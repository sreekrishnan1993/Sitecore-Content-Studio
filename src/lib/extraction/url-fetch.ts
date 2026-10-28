import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { MAX_URL_RESPONSE_BYTES, URL_FETCH_TIMEOUT_MS } from "./limits";
import { ExtractionError } from "./providers/types";

// Server-side fetching of publication URLs with SSRF protections:
//
// - http/https only, standard ports only, no embedded credentials.
// - Every address is checked against an allowlist of public unicast ranges. IPv6 is parsed
//   to bytes (not matched as text), and IPv4 embedded in IPv6 (mapped, compatible, NAT64,
//   6to4) is extracted and checked as IPv4.
// - DNS rebinding: the address check runs inside the socket's `lookup` hook, so the address
//   that is validated is exactly the address that is connected to. There is no gap between
//   "check" and "connect".
// - Redirects are followed manually (max 3) and every hop goes through the same checks.
// - One overall deadline across all hops; response size is capped while streaming; responses
//   are requested without compression so the cap applies to real bytes.
// - Environment proxy settings are not used.

const MAX_REDIRECTS = 3;
const BLOCKED_ADDRESS = "CS_BLOCKED_ADDRESS";

type Bytes = number[];

function parseIPv4(ip: string): Bytes | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

/** Parses an IPv6 address (optionally with an embedded IPv4 tail or a zone id) into 16 bytes. */
export function parseIPv6(input: string): Bytes | null {
  let ip = input.split("%")[0].toLowerCase();
  let tail: Bytes = [];
  const lastColon = ip.lastIndexOf(":");
  if (ip.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(ip.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inV4(b: Bytes, base: Bytes, bits: number): boolean {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((b[i] & mask) !== (base[i] & mask)) return false;
  }
  return true;
}

const V4_BLOCKED: Array<[Bytes, number]> = [
  [[0, 0, 0, 0], 8], // "this" network
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (AWS/GCP/Azure metadata 169.254.169.254)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
];

function isPublicV4(b: Bytes): boolean {
  return !V4_BLOCKED.some(([base, bits]) => inV4(b, base, bits));
}

function isPublicV6(b: Bytes): boolean {
  const word = (i: number) => (b[i * 2] << 8) | b[i * 2 + 1];
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);

  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d -> judge the IPv4 address.
  if (zeros(0, 10) && word(5) === 0xffff) return isPublicV4(b.slice(12));
  if (zeros(0, 12)) return false; // ::, ::1 and deprecated IPv4-compatible addresses
  // NAT64 64:ff9b::/96 -> embedded IPv4; 64:ff9b:1::/48 local-use NAT64 is blocked.
  if (word(0) === 0x64 && word(1) === 0xff9b && zeros(4, 12)) return isPublicV4(b.slice(12));
  if (word(0) === 0x64 && word(1) === 0xff9b) return false;
  // Only global unicast 2000::/3 is allowed beyond this point.
  if ((word(0) & 0xe000) !== 0x2000) return false;
  if (word(0) === 0x2002) return isPublicV4(b.slice(2, 6)); // 6to4 embeds an IPv4 address
  if (word(0) === 0x2001 && word(1) < 0x200) return false; // 2001::/23 IETF (Teredo, ORCHID, ...)
  if (word(0) === 0x2001 && word(1) === 0x0db8) return false; // documentation
  if (word(0) === 0x3fff && word(1) < 0x1000) return false; // documentation 3fff::/20
  return true;
}

export function isPublicAddress(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, "");
  const family = isIP(clean.split("%")[0]);
  if (family === 4) {
    const b = parseIPv4(clean);
    return b !== null && isPublicV4(b);
  }
  if (family === 6) {
    const b = parseIPv6(clean);
    return b !== null && isPublicV6(b);
  }
  return false;
}

export function parsePublicationUrl(input: string, allowedPorts: string[] = ["", "80", "443"]): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ExtractionError("url-rejected", "Enter a full URL, for example https://example.com/news/press-release.", 400);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ExtractionError("url-rejected", "Only http and https URLs are supported.", 400);
  }
  if (url.username || url.password) {
    throw new ExtractionError("url-rejected", "URLs with embedded credentials are not allowed.", 400);
  }
  if (!allowedPorts.includes(url.port)) {
    throw new ExtractionError("url-rejected", "Only standard web ports (80/443) are allowed.", 400);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|intranet|lan|home\.arpa)$/.test(host) || !host.includes(".") && !isIP(host)) {
    throw new ExtractionError("url-rejected", "Private or local addresses cannot be imported.", 400);
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))));

/** A socket lookup that only ever yields addresses that passed the allowlist. */
export function createSafeLookup(resolver: Resolver, isAllowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname)
      .then((addresses) => {
        if (addresses.length === 0 || !addresses.every((a) => isAllowed(a.address))) {
          const error = Object.assign(new Error("Blocked address"), { code: BLOCKED_ADDRESS });
          callback(error, "", 4);
          return;
        }
        const wanted = options.family === 4 || options.family === 6 ? addresses.filter((a) => a.family === options.family) : addresses;
        const usable = wanted.length ? wanted : addresses;
        if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, "", 4));
  };
}

export interface FetchOptions {
  resolver?: Resolver;
  isAllowedAddress?: (address: string) => boolean;
  /** Test hook only. Production always uses 80/443. */
  allowedPorts?: string[];
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchedDocument {
  finalUrl: URL;
  contentType: string;
  bytes: Uint8Array;
}

interface RawResponse {
  status: number;
  location?: string;
  contentType: string;
  bytes: Uint8Array;
}

function requestOnce(url: URL, lookup: LookupFunction, signal: AbortSignal, maxBytes: number): Promise<RawResponse> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "GET",
        lookup,
        signal,
        agent: false,
        headers: {
          "user-agent": "ContentStudio/1.0 (+Sitecore Marketplace app)",
          accept: "text/html,application/xhtml+xml,application/pdf;q=0.9",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location, contentType, bytes: new Uint8Array(0) });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, contentType, bytes: new Uint8Array(0) });
          return;
        }
        if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
          res.destroy();
          reject(new ExtractionError("file-too-large", `The publication is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB import limit.`, 413));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            res.destroy();
            reject(new ExtractionError("file-too-large", `The publication is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB import limit.`, 413));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, contentType, bytes: new Uint8Array(Buffer.concat(chunks)) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export async function fetchPublication(input: string, options: FetchOptions = {}): Promise<FetchedDocument> {
  const isAllowed = options.isAllowedAddress ?? isPublicAddress;
  const lookup = createSafeLookup(options.resolver ?? systemResolver, isAllowed);
  const maxBytes = options.maxBytes ?? MAX_URL_RESPONSE_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? URL_FETCH_TIMEOUT_MS);
  let url = parsePublicationUrl(input, options.allowedPorts);

  for (let redirects = 0; ; redirects++) {
    // IP literals never reach the lookup hook, so they are checked here.
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !isAllowed(literal)) {
      throw new ExtractionError("url-rejected", "Private or local addresses cannot be imported.", 400);
    }

    let response: RawResponse;
    try {
      response = await requestOnce(url, lookup, signal, maxBytes);
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === BLOCKED_ADDRESS) throw new ExtractionError("url-rejected", "Private or local addresses cannot be imported.", 400);
      if (signal.aborted) throw new ExtractionError("fetch-failed", "The publication did not respond in time.", 504);
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new ExtractionError("fetch-failed", `The host "${url.hostname}" could not be resolved.`, 502);
      throw new ExtractionError("fetch-failed", "The publication could not be downloaded.", 502);
    }

    if (response.status >= 300 && response.status < 400) {
      if (!response.location || redirects >= MAX_REDIRECTS) {
        throw new ExtractionError("fetch-failed", "The publication redirected too many times.", 502);
      }
      url = parsePublicationUrl(new URL(response.location, url).toString(), options.allowedPorts);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ExtractionError("fetch-failed", `The publication returned HTTP ${response.status}.`, 502);
    }
    return { finalUrl: url, contentType: response.contentType, bytes: response.bytes };
  }
}
