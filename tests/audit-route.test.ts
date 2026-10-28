import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/src/app/api/extract/route";
import { setAuditSink } from "@/src/lib/security/audit";

// The extraction endpoint records sign-in and processing outcomes, without document details.
describe("extraction endpoint audit trail", () => {
  let restore: ((line: string) => void) | null = null;
  afterEach(() => {
    if (restore) setAuditSink(restore);
    restore = null;
  });

  it("logs the sign-in and the rejected request", async () => {
    const lines: string[] = [];
    restore = setAuditSink((line) => lines.push(line));
    const response = await POST(new Request("https://app.example/api/extract", { method: "POST", headers: { "content-type": "text/plain" }, body: "secret document text" }));
    expect(response.status).toBe(415);
    const events = lines.map((line) => JSON.parse(line));
    expect(events.map((e) => e.event)).toEqual(["auth.success", "extract.failed"]);
    expect(events[1]).toMatchObject({ outcome: "failure", code: "invalid-request", status: 415, kind: "unknown" });
    expect(lines.join("\n")).not.toContain("secret document text");
  });

  it("logs a failed sign-in with the reason only", async () => {
    const lines: string[] = [];
    restore = setAuditSink((line) => lines.push(line));
    const previous = { ...process.env };
    Object.assign(process.env, { CONTENT_STUDIO_AUTH_MODE: "auth0", CONTENT_STUDIO_AUTH0_DOMAIN: "auth.example", CONTENT_STUDIO_AUTH0_AUDIENCE: "api" });
    try {
      const response = await POST(new Request("https://app.example/api/extract", { method: "POST", headers: { authorization: "Bearer not-a-token" } }));
      expect(response.status).toBe(401);
    } finally {
      process.env = previous;
    }
    expect(lines.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ event: "auth.failure", reason: "malformed-authorization-header", status: 401 })]);
    expect(lines.join("\n")).not.toContain("not-a-token");
  });
});
