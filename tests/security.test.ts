import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateRawSync } from "node:zlib";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSampleDocx, buildSamplePdf } from "../scripts/fixtures.mjs";
import { ExtractionError } from "@/src/lib/extraction/providers/types";
import { createSafeLookup, fetchPublication, isPublicAddress, parseIPv6, parsePublicationUrl } from "@/src/lib/extraction/url-fetch";
import { scanZip, verifyZipExpansion } from "@/src/lib/extraction/zip";
import { auditRecord, auditRequest, setAuditSink, signAuditRecord } from "@/src/lib/security/audit";
import { authenticateRequest, readAuthConfig, type AuthConfig } from "@/src/lib/security/auth";
import { BodyTooLargeError, readBodyWithLimit } from "@/src/lib/security/body";
import { ConcurrencyLimiter, rateLimitKey, SlidingWindowLimiter } from "@/src/lib/security/rate-limit";
import { isCrossSite } from "@/src/lib/security/request";

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

describe("auth configuration", () => {
  it("fails closed in production when nothing is configured", () => {
    expect(readAuthConfig({ NODE_ENV: "production" })).toMatchObject({ mode: "misconfigured" });
  });
  it("allows unauthenticated mode in development only by default", () => {
    expect(readAuthConfig({ NODE_ENV: "development" })).toEqual({ mode: "none", explicit: false });
  });
  it("requires an explicit second flag for unauthenticated production", () => {
    expect(readAuthConfig({ NODE_ENV: "production", CONTENT_STUDIO_AUTH_MODE: "none" })).toMatchObject({ mode: "misconfigured" });
    expect(readAuthConfig({ NODE_ENV: "production", CONTENT_STUDIO_AUTH_MODE: "none", CONTENT_STUDIO_ALLOW_UNAUTHENTICATED: "true" })).toEqual({ mode: "none", explicit: true });
  });
  it("requires domain and audience for auth0", () => {
    expect(readAuthConfig({ CONTENT_STUDIO_AUTH_MODE: "auth0", CONTENT_STUDIO_AUTH0_DOMAIN: "x.auth0.com" })).toMatchObject({ mode: "misconfigured" });
    expect(readAuthConfig({ CONTENT_STUDIO_AUTH_MODE: "auth0", CONTENT_STUDIO_AUTH0_DOMAIN: "https://x.auth0.com/", CONTENT_STUDIO_AUTH0_AUDIENCE: "api" })).toMatchObject({
      mode: "auth0",
      issuer: "https://x.auth0.com/",
      audience: "api",
    });
  });
  it("rejects unknown modes instead of falling back", () => {
    expect(readAuthConfig({ CONTENT_STUDIO_AUTH_MODE: "header" })).toMatchObject({ mode: "misconfigured" });
  });
});

describe("bearer token verification", () => {
  const issuer = "https://tenant.example-auth0.com/";
  const audience = "https://content-studio.example/api";
  const config: AuthConfig = { mode: "auth0", issuer, audience, clientIds: ["client-ok"], orgClaim: "org_id", allowedOrgs: ["org_1"] };
  let keySet: ReturnType<typeof createLocalJWKSet>;
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey as CryptoKey;
    otherKey = (await generateKeyPair("RS256")).privateKey as CryptoKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    keySet = createLocalJWKSet({ keys: [jwk] });
  });

  const token = (claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number } = {}) =>
    new SignJWT({ azp: "client-ok", org_id: "org_1", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("auth0|user-1")
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(opts.key ?? privateKey);

  const req = (auth?: string) => new Request("https://app.example/api/extract", { method: "POST", headers: auth ? { authorization: auth } : {} });

  it("accepts a valid token", async () => {
    expect(await authenticateRequest(req(`Bearer ${await token()}`), config, keySet)).toEqual({ ok: true, subject: "auth0|user-1", mode: "auth0", client: "client-ok", organization: "org_1" });
  });
  it("rejects a missing or malformed header", async () => {
    expect(await authenticateRequest(req(), config, keySet)).toMatchObject({ ok: false, status: 401, reason: "missing-token" });
    expect(await authenticateRequest(req("Basic abc"), config, keySet)).toMatchObject({ ok: false, status: 401, reason: "malformed-authorization-header" });
  });
  it("rejects wrong audience, wrong issuer, expiry and foreign signatures", async () => {
    for (const t of [
      await token({}, { aud: "https://other-api" }),
      await token({}, { iss: "https://evil.example/" }),
      await token({}, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      await token({}, { key: otherKey }),
    ]) {
      expect(await authenticateRequest(req(`Bearer ${t}`), config, keySet)).toMatchObject({ ok: false, status: 401 });
    }
  });
  it("rejects a tampered payload", async () => {
    const [h, , s] = (await token()).split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "admin", iss: issuer, aud: audience, exp: 9999999999, azp: "client-ok", org_id: "org_1" })).toString("base64url");
    expect(await authenticateRequest(req(`Bearer ${h}.${forged}.${s}`), config, keySet)).toMatchObject({ ok: false });
  });
  it("rejects unsigned (alg: none) and symmetric (HS256) tokens", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const claims = { sub: "x", iss: issuer, aud: audience, exp: 9999999999, azp: "client-ok", org_id: "org_1" };
    const none = `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.`;
    expect(await authenticateRequest(req(`Bearer ${none}`), config, keySet)).toMatchObject({ ok: false });
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("guessable-secret-guessable-secret"));
    expect(await authenticateRequest(req(`Bearer ${hs}`), config, keySet)).toMatchObject({ ok: false });
  });
  it("enforces allowed client and organization", async () => {
    expect(await authenticateRequest(req(`Bearer ${await token({ azp: "someone-else" })}`), config, keySet)).toMatchObject({ ok: false, reason: "client-not-allowed" });
    expect(await authenticateRequest(req(`Bearer ${await token({ org_id: "org_2" })}`), config, keySet)).toMatchObject({ ok: false, reason: "organization-not-allowed" });
  });
  it("returns 503 when misconfigured, without accepting the request", async () => {
    expect(await authenticateRequest(req(), { mode: "misconfigured", reason: "x" })).toMatchObject({ ok: false, status: 503, code: "auth-not-configured" });
  });
});

describe("audit log", () => {
  const at = new Date("2026-10-28T09:30:00+04:00");

  it("records a UTC timestamp, the event and its fields, and drops missing fields", () => {
    expect(auditRecord("auth.success", "success", "req-1", { subject: "auth0|u", organization: undefined }, {}, at)).toEqual({
      type: "audit",
      ts: "2026-10-28T05:30:00.000Z",
      app: "content-studio",
      event: "auth.success",
      outcome: "success",
      requestId: "req-1",
      subject: "auth0|u",
    });
  });
  it("signs records when a key is set, so edits are detectable", () => {
    const record = auditRecord("extract.succeeded", "success", "req-1", { bytes: 10 }, { CONTENT_STUDIO_AUDIT_HMAC_KEY: "k" }, at);
    const { sig, ...rest } = record;
    expect(sig).toBe(signAuditRecord(rest, "k"));
    expect(signAuditRecord({ ...rest, bytes: 11 }, "k")).not.toBe(sig);
  });
  it("writes one JSON line per event and never throws", () => {
    const lines: string[] = [];
    const previous = setAuditSink((line) => lines.push(line));
    try {
      const audit = auditRequest(new Request("https://app.example/api/extract", { headers: { "x-vercel-id": "fra1::abc" } }));
      audit.log("auth.failure", "failure", { reason: "missing-token" });
      expect(JSON.parse(lines[0])).toMatchObject({ event: "auth.failure", outcome: "failure", requestId: "fra1::abc", reason: "missing-token" });
      setAuditSink(() => {
        throw new Error("sink down");
      });
      expect(() => audit.log("auth.success", "success")).not.toThrow();
    } finally {
      setAuditSink(previous);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Rate limiting, body limits, origin checks
// ---------------------------------------------------------------------------------------------

describe("rate and concurrency limits", () => {
  it("limits requests per key within the window", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 60_000, () => now);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    const blocked = limiter.check("a");
    expect(blocked).toMatchObject({ allowed: false });
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.check("b").allowed).toBe(true);
    now = 61_000;
    expect(limiter.check("a").allowed).toBe(true);
  });
  it("caps concurrent work and releases slots once", () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = limiter.tryAcquire();
    expect(release).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
    release!();
    release!();
    const again = limiter.tryAcquire();
    expect(again).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });
  it("ignores client-supplied forwarding headers unless the operator trusts one", () => {
    const req = new Request("https://app/x", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(rateLimitKey(req, "anonymous", {})).toBe("anonymous");
    expect(rateLimitKey(req, "anonymous", { CONTENT_STUDIO_TRUSTED_IP_HEADER: "x-forwarded-for" })).toBe("ip:1.2.3.4");
    expect(rateLimitKey(req, "auth0|u1", { CONTENT_STUDIO_TRUSTED_IP_HEADER: "x-forwarded-for" })).toBe("user:auth0|u1");
  });
});

describe("request body limits", () => {
  const streamOf = (size: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < size; sent += 64 * 1024) controller.enqueue(new Uint8Array(Math.min(64 * 1024, size - sent)));
        controller.close();
      },
    });

  it("rejects an oversized chunked body that has no Content-Length", async () => {
    const req = new Request("https://app/x", { method: "POST", body: streamOf(2 * 1024 * 1024), duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readBodyWithLimit(req, 1024 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it("rejects early when Content-Length declares too much", async () => {
    const req = new Request("https://app/x", { method: "POST", body: "x".repeat(10), headers: { "content-length": "99999999" } });
    await expect(readBodyWithLimit(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it("reads bodies within the limit", async () => {
    const req = new Request("https://app/x", { method: "POST", body: "hello" });
    expect(new TextDecoder().decode(await readBodyWithLimit(req, 100))).toBe("hello");
  });
});

describe("cross-site request detection", () => {
  const req = (headers: Record<string, string>) => new Request("https://app.example/api/extract", { method: "POST", headers: { host: "app.example", ...headers } });
  it("allows same-origin and non-browser requests", () => {
    expect(isCrossSite(req({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossSite(req({}))).toBe(false);
    expect(isCrossSite(req({ origin: "https://app.example" }))).toBe(false);
  });
  it("blocks cross-site browser requests", () => {
    expect(isCrossSite(req({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSite(req({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isCrossSite(req({ origin: "https://evil.example" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------------------------

describe("SSRF address classification", () => {
  it.each([
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "255.255.255.255", "224.0.0.1", "198.18.0.1",
    "::", "::1", "fd00:ec2::254", "fc00::1", "fe80::1", "ff02::1",
    // IPv4 embedded in IPv6 — previously bypassed the guard:
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "64:ff9b::a00:1", "64:ff9b::7f00:1",
    "2001::1", "2001:db8::1", "100::1",
  ])("blocks %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700::1111", "2a00:1450:4001::1", "::ffff:8.8.8.8", "2002:808:808::1", "64:ff9b::808:808"])("allows public %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it("parses IPv6 forms consistently", () => {
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual(parseIPv6("::ffff:7f00:1"));
    expect(parseIPv6("fe80::1%eth0")?.[0]).toBe(0xfe);
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("12345::")).toBeNull();
  });

  it("normalises obfuscated IPv4 hosts before checking", () => {
    for (const url of ["http://2130706433/", "http://0x7f.0.0.1/", "http://127.1/", "http://[::ffff:127.0.0.1]/"]) {
      const host = parsePublicationUrl(url).hostname.replace(/^\[|\]$/g, "");
      expect(isPublicAddress(host)).toBe(false);
    }
  });

  it("rejects single-label and internal host names", () => {
    for (const url of ["http://intranet/", "http://metadata.google.internal/", "http://printer.local/", "http://localhost/"]) {
      expect(() => parsePublicationUrl(url)).toThrow(/Private or local/);
    }
  });
});

describe("SSRF network behaviour (local test server)", () => {
  let server: Server;
  let port: number;
  let hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><article><h1>Hello world headline</h1><p>Text paragraph.</p></article></body></html>");
      } else if (req.url === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (req.url === "/to-internal") {
        res.writeHead(302, { location: `http://internal.test:${port}/page` });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        const chunk = Buffer.alloc(64 * 1024, 97);
        let sent = 0;
        const pump = () => {
          while (sent < 3 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once("drain", pump);
          }
          res.end();
        };
        pump();
      } else if (req.url === "/hang") {
        // never responds
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  beforeEach(() => {
    hits = [];
  });

  // "public.test" stands in for a public site; the test server lives on loopback, so the test
  // allowlist treats exactly that one address as allowed. Everything else uses the real policy.
  const resolver = async (host: string) => {
    if (host === "public.test") return [{ address: "127.0.0.1", family: 4 }];
    if (host === "internal.test") return [{ address: "10.0.0.5", family: 4 }];
    if (host === "mixed.test") return [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    if (host === "rebind.test") return [{ address: "127.0.0.1", family: 4 }];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
  const testAllowed = (addr: string) => addr === "127.0.0.1" || isPublicAddress(addr);
  const opts = () => ({ resolver, isAllowedAddress: testAllowed, allowedPorts: [String(port)] });
  const url = (host: string, path: string) => `http://${host}:${port}${path}`;

  it("fetches an allowed page (control)", async () => {
    const doc = await fetchPublication(url("public.test", "/page"), opts());
    expect(new TextDecoder().decode(doc.bytes)).toContain("Hello world headline");
  });

  it("blocks DNS rebinding: the address used for the connection is the one validated", async () => {
    // Real policy (no test allowance): rebind.test resolves to loopback at connect time.
    await expect(fetchPublication(url("rebind.test", "/page"), { resolver, allowedPorts: [String(port)] })).rejects.toMatchObject({ code: "url-rejected" });
    expect(hits).toEqual([]);
  });

  it("blocks a host whose DNS answer mixes public and private addresses", async () => {
    await expect(fetchPublication(url("mixed.test", "/page"), { resolver, allowedPorts: [String(port)] })).rejects.toMatchObject({ code: "url-rejected" });
    expect(hits).toEqual([]);
  });

  it("re-checks redirects: to a metadata IP literal", async () => {
    await expect(fetchPublication(url("public.test", "/to-metadata"), opts())).rejects.toMatchObject({ code: "url-rejected" });
    expect(hits).toEqual(["/to-metadata"]);
  });

  it("re-checks redirects: to a host resolving to a private address", async () => {
    await expect(fetchPublication(url("public.test", "/to-internal"), opts())).rejects.toMatchObject({ code: "url-rejected" });
    expect(hits).toEqual(["/to-internal"]);
  });

  it("stops redirect loops", async () => {
    await expect(fetchPublication(url("public.test", "/loop"), opts())).rejects.toMatchObject({ code: "fetch-failed" });
    expect(hits.length).toBe(4);
  });

  it("caps response size while streaming (no Content-Length)", async () => {
    await expect(fetchPublication(url("public.test", "/big"), { ...opts(), maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: "file-too-large" });
  });

  it("enforces an overall timeout", async () => {
    const started = Date.now();
    await expect(fetchPublication(url("public.test", "/hang"), { ...opts(), timeoutMs: 300 })).rejects.toMatchObject({ code: "fetch-failed" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects non-standard ports in production configuration", () => {
    expect(() => parsePublicationUrl(url("public.test", "/page"))).toThrow(/ports/);
  });

  it("safe lookup never yields a blocked address, including for all-address lookups", async () => {
    const lookup = createSafeLookup(resolver, isPublicAddress);
    const result = await new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown }>((resolve) =>
      lookup("rebind.test", { all: true }, (err, addr) => resolve({ err, addr })),
    );
    expect(result.err?.code).toBe("CS_BLOCKED_ADDRESS");
  });
});

// ---------------------------------------------------------------------------------------------
// Document bombs and file validation
// ---------------------------------------------------------------------------------------------

describe("DOCX decompression limits", () => {
  it("detects a ZIP whose headers understate the real decompressed size", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", Buffer.alloc(4 * 1024 * 1024, 0x20), { createFolders: false });
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
    // Forge the declared uncompressed size (central directory offset 24) to 100 bytes.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const summary = scanZip(bytes)!;
    let cd = bytes.length - 22;
    while (view.getUint32(cd, true) !== 0x06054b50) cd--;
    const cdStart = view.getUint32(cd + 16, true);
    view.setUint32(cdStart + 24, 100, true);
    const forged = scanZip(bytes)!;
    expect(summary.totalUncompressed).toBe(4 * 1024 * 1024);
    expect(forged.totalUncompressed).toBe(100);
    expect(verifyZipExpansion(bytes, forged, 1024 * 1024)).toEqual({ ok: false, reason: "too-large" });
    expect(verifyZipExpansion(bytes, forged, 8 * 1024 * 1024)).toMatchObject({ ok: true });
  });

  it("rejects corrupt entries and unsupported compression", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "hello world hello world");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
    const summary = scanZip(bytes)!;
    expect(verifyZipExpansion(bytes, { ...summary, entries: summary.entries.map((e) => ({ ...e, method: 12 })) }, 1e6)).toEqual({ ok: false, reason: "unsupported" });
    expect(verifyZipExpansion(bytes, { ...summary, entries: summary.entries.map((e) => ({ ...e, localHeaderOffset: 5 })) }, 1e6)).toEqual({ ok: false, reason: "corrupt" });
    expect(deflateRawSync(Buffer.from("x")).length).toBeGreaterThan(0);
  });

  it("still accepts a valid DOCX", async () => {
    const bytes = new Uint8Array(await buildSampleDocx());
    const summary = scanZip(bytes)!;
    expect(verifyZipExpansion(bytes, summary, 100 * 1024 * 1024)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Route: end-to-end behaviour of POST /api/extract
// ---------------------------------------------------------------------------------------------

describe("POST /api/extract", () => {
  const ENV_KEYS = ["NODE_ENV", "CONTENT_STUDIO_AUTH_MODE", "CONTENT_STUDIO_ALLOW_UNAUTHENTICATED", "CONTENT_STUDIO_RATE_LIMIT_PER_MINUTE", "CONTENT_STUDIO_AUTH0_DOMAIN", "CONTENT_STUDIO_AUTH0_AUDIENCE"];
  const saved: Record<string, string | undefined> = {};
  const env = process.env as Record<string, string | undefined>;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = env[k];
    vi.resetModules();
  });
  afterAll(() => {
    for (const k of ENV_KEYS) env[k] = saved[k];
  });
  const restore = () => {
    for (const k of ENV_KEYS) env[k] = saved[k];
  };

  async function loadRoute(overrides: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(overrides)) env[k] = v;
    return import("@/src/app/api/extract/route");
  }

  const upload = (bytes: Uint8Array, name: string, headers: Record<string, string> = {}) => {
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], name));
    return new Request("http://localhost/api/extract", { method: "POST", body: form, headers: { host: "localhost", ...headers } });
  };

  it("processes a valid PDF and marks the response as not cacheable", async () => {
    const { POST } = await loadRoute({ CONTENT_STUDIO_AUTH_MODE: "none" });
    const res = await POST(upload(new Uint8Array(buildSamplePdf()), "release.pdf", { "sec-fetch-site": "same-origin" }));
    restore();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.blocks.find((b: { type: string }) => b.type === "headline").text).toContain("Northwind");
  });

  it("refuses to process anything in production without authentication configured", async () => {
    const { POST } = await loadRoute({ NODE_ENV: "production", CONTENT_STUDIO_AUTH_MODE: undefined });
    const res = await POST(upload(new Uint8Array(buildSamplePdf()), "release.pdf"));
    restore();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("auth-not-configured");
  });

  it("requires a bearer token in auth0 mode", async () => {
    const { POST } = await loadRoute({ CONTENT_STUDIO_AUTH_MODE: "auth0", CONTENT_STUDIO_AUTH0_DOMAIN: "tenant.example-auth0.com", CONTENT_STUDIO_AUTH0_AUDIENCE: "api" });
    const res = await POST(upload(new Uint8Array(buildSamplePdf()), "release.pdf", { "x-user-id": "admin", "x-sitecore-user": "admin@example.com" }));
    restore();
    expect(res.status).toBe(401);
  });

  it("rejects cross-site browser requests", async () => {
    const { POST } = await loadRoute({ CONTENT_STUDIO_AUTH_MODE: "none" });
    const res = await POST(upload(new Uint8Array(buildSamplePdf()), "release.pdf", { "sec-fetch-site": "cross-site" }));
    restore();
    expect(res.status).toBe(403);
  });

  it("validates file signatures, not names or declared MIME types", async () => {
    const { POST } = await loadRoute({ CONTENT_STUDIO_AUTH_MODE: "none" });
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const res1 = await POST(upload(html, "evil.pdf"));
    const docxAsPdf = await POST(upload(new Uint8Array(await buildSampleDocx()), "renamed.pdf"));
    restore();
    expect(res1.status).toBe(415);
    expect(docxAsPdf.status).toBe(415);
  });

  it("rejects multiple files, wrong content types, and oversized JSON", async () => {
    const { POST } = await loadRoute({ CONTENT_STUDIO_AUTH_MODE: "none" });
    const form = new FormData();
    form.append("file", new File([buildSamplePdf() as BlobPart], "a.pdf"));
    form.append("file", new File([buildSamplePdf() as BlobPart], "b.pdf"));
    const two = await POST(new Request("http://localhost/api/extract", { method: "POST", body: form }));
    const text = await POST(new Request("http://localhost/api/extract", { method: "POST", body: "hi", headers: { "content-type": "text/plain" } }));
    const json = await POST(new Request("http://localhost/api/extract", { method: "POST", body: JSON.stringify({ url: "https://example.com/" + "a".repeat(10_000) }), headers: { "content-type": "application/json" } }));
    restore();
    expect(two.status).toBe(400);
    expect(text.status).toBe(415);
    expect(json.status).toBe(413);
  });

  it("rejects an oversized streamed upload without Content-Length", async () => {
    const { POST } = await loadRoute({ CONTENT_STUDIO_AUTH_MODE: "none" });
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 300; i++) controller.enqueue(new Uint8Array(64 * 1024));
        controller.close();
      },
    });
    const res = await POST(new Request("http://localhost/api/extract", { method: "POST", body: big, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=x" } } as RequestInit));
    restore();
    expect(res.status).toBe(413);
  });

  it("rate-limits repeated requests", async () => {
    const { POST } = await loadRoute({ CONTENT_STUDIO_AUTH_MODE: "none", CONTENT_STUDIO_RATE_LIMIT_PER_MINUTE: "2" });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await POST(new Request("http://localhost/api/extract", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).status);
    restore();
    expect(statuses.slice(0, 2)).toEqual([400, 400]);
    expect(statuses[2]).toBe(429);
  });

  it("does not leak parser internals in error messages", async () => {
    const { POST } = await loadRoute({ CONTENT_STUDIO_AUTH_MODE: "none" });
    const res = await POST(upload(new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Broken"), "broken.pdf"));
    restore();
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.message).toBe("The PDF could not be read. It may be damaged or use an unsupported format.");
  });
});

it("ExtractionError keeps HTTP status codes", () => {
  expect(new ExtractionError("url-rejected", "x", 400).status).toBe(400);
});
