import "server-only";
import { createHmac, randomUUID } from "node:crypto";

/**
 * Security audit log for Content Studio's API.
 *
 * Each event is one JSON line on stdout with a UTC ISO-8601 timestamp, so the hosting platform
 * collects it and a log drain can forward it to an append-only store (see README, "Audit logging").
 * Events record who did what and the outcome. They never contain tokens, document content,
 * file names or full URLs.
 *
 * When CONTENT_STUDIO_AUDIT_HMAC_KEY is set, every event carries an HMAC-SHA256 signature over its
 * other fields, so the log store can detect edited or forged entries.
 */

export type AuditEvent =
  | "auth.success"
  | "auth.failure"
  | "auth.misconfigured"
  | "request.rejected"
  | "extract.started"
  | "extract.succeeded"
  | "extract.failed";

export type AuditFields = Record<string, string | number | boolean | null | undefined>;

export interface AuditContext {
  requestId: string;
  /** Records the event. Missing (undefined) fields are dropped. */
  log(event: AuditEvent, outcome: "success" | "failure" | "info", fields?: AuditFields): void;
}

type Sink = (line: string) => void;

let sink: Sink = (line) => console.info(line);

/** Replaces the output for tests. Returns the previous sink. */
export function setAuditSink(next: Sink): Sink {
  const previous = sink;
  sink = next;
  return previous;
}

export function signAuditRecord(record: Record<string, unknown>, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify(record)).digest("hex");
}

export function auditRecord(event: AuditEvent, outcome: string, requestId: string, fields: AuditFields = {}, env: Record<string, string | undefined> = process.env, now: Date = new Date()): Record<string, unknown> {
  const record: Record<string, unknown> = { type: "audit", ts: now.toISOString(), app: "content-studio", event, outcome, requestId };
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) record[name] = value;
  const key = env.CONTENT_STUDIO_AUDIT_HMAC_KEY?.trim();
  if (key) record.sig = signAuditRecord(record, key);
  return record;
}

/** Starts an audit context for one API request. */
export function auditRequest(request: Request): AuditContext {
  const requestId = request.headers.get("x-vercel-id")?.slice(0, 128) || randomUUID();
  return {
    requestId,
    log(event, outcome, fields) {
      try {
        sink(JSON.stringify(auditRecord(event, outcome, requestId, fields)));
      } catch {
        // Auditing must never break the request.
      }
    },
  };
}
