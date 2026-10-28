import { NextResponse } from "next/server";
import { ExtractionError, extractPublicationUrl, extractUploadedFile } from "@/src/lib/extraction";
import { getContentEnhancer } from "@/src/lib/extraction/ai";
import { isUrlImportEnabled, maxUploadBytes } from "@/src/lib/extraction/limits";
import { authenticateRequest, readAuthConfig } from "@/src/lib/security/auth";
import { BodyTooLargeError, readBodyWithLimit } from "@/src/lib/security/body";
import { readDeployment } from "@/src/lib/security/deployment";
import { isCrossSite, withDeadline } from "@/src/lib/security/request";
import { extractionConcurrency, extractionRateLimiter, rateLimitKey } from "@/src/lib/security/rate-limit";
import type { ServerCapabilities } from "@/src/lib/types/capabilities";
import type { ExtractionErrorBody } from "@/src/lib/types/extraction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EXTRACTION_DEADLINE_MS = 45_000;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 4 * 1024;

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

type ErrorCode = ExtractionErrorBody["error"]["code"];

function errorResponse(code: ErrorCode, message: string, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json<ExtractionErrorBody>({ error: { code, message } }, { status, headers: { ...NO_STORE, ...headers } });
}

/** Reports server-side capabilities so the UI never offers features that are not available. Contains no secrets. */
export async function GET() {
  const auth = readAuthConfig();
  return NextResponse.json<ServerCapabilities>(
    {
      maxUploadBytes: maxUploadBytes(),
      urlImportEnabled: isUrlImportEnabled(),
      aiProvider: getContentEnhancer()?.id ?? null,
      ocrProvider: null,
      authMode: auth.mode,
      ...readDeployment(),
    },
    { headers: NO_STORE },
  );
}

/**
 * Extracts content from an uploaded PDF/DOCX (multipart field "file") or a publication URL
 * (JSON body { "url": "..." }). Files are processed in memory and never written to disk;
 * document content is never logged.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return errorResponse(auth.code, auth.message, auth.status);

  if (isCrossSite(request)) return errorResponse("forbidden-origin", "Cross-site requests are not allowed.", 403);

  const rate = extractionRateLimiter.check(rateLimitKey(request, auth.subject));
  if (!rate.allowed) {
    return errorResponse("rate-limited", `Too many documents were processed recently. Try again in ${rate.retryAfterSeconds} seconds.`, 429, {
      "retry-after": String(rate.retryAfterSeconds),
    });
  }

  const release = extractionConcurrency.tryAcquire();
  if (!release) return errorResponse("busy", "The server is processing other documents. Try again in a moment.", 503, { "retry-after": "5" });

  // The slot is released when the work really finishes, even if the response timed out first,
  // so slow documents cannot pile up beyond the concurrency limit.
  let work: Promise<unknown> | null = null;
  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.startsWith("application/json")) {
      if (!isUrlImportEnabled()) return errorResponse("invalid-request", "Publication URL import is disabled on this installation.", 403);
      const raw = await readBodyWithLimit(request, MAX_JSON_BYTES);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return errorResponse("invalid-request", "The request body is not valid JSON.", 400);
      }
      const url = (body as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || !url.trim() || url.length > 2048) return errorResponse("invalid-request", "Provide a publication URL.", 400);
      work = extractPublicationUrl(url);
    } else if (contentType.startsWith("multipart/form-data")) {
      const limit = maxUploadBytes();
      const raw = await readBodyWithLimit(request, limit + MULTIPART_OVERHEAD_BYTES);
      let form: FormData;
      try {
        form = await new Response(raw as BodyInit, { headers: { "content-type": contentType } }).formData();
      } catch {
        return errorResponse("invalid-request", "The upload could not be read as form data.", 400);
      }
      const files = form.getAll("file");
      if (files.length !== 1 || !(files[0] instanceof File)) return errorResponse("invalid-request", "Upload exactly one file in the \"file\" field.", 400);
      const file = files[0];
      if (file.size > limit) return errorResponse("file-too-large", `The file exceeds the ${Math.round(limit / 1024 / 1024)} MB upload limit.`, 413);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = file.name.replace(/[\u0000-\u001f\u007f\\/]/g, "_").slice(0, 200) || "document";
      work = extractUploadedFile(bytes, name);
    } else {
      return errorResponse("invalid-request", "Send a file as multipart/form-data or a URL as JSON.", 415);
    }

    return NextResponse.json(await withDeadline(work, EXTRACTION_DEADLINE_MS, () => new ExtractionError("timeout", "Processing took too long and was stopped. Try a smaller or simpler document.", 504)), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return errorResponse("file-too-large", `The request exceeds the ${Math.round(maxUploadBytes() / 1024 / 1024)} MB upload limit.`, 413);
    }
    if (error instanceof ExtractionError) return errorResponse(error.code, error.message, error.status);
    // Log the error type and stack only; never document content or request bodies.
    console.error("Content Studio: extraction failed unexpectedly:", error instanceof Error ? `${error.name}: ${error.stack?.split("\n").slice(0, 4).join(" | ")}` : typeof error);
    return errorResponse("internal-error", "The document could not be processed because of an unexpected error.", 500);
  } finally {
    if (work) work.finally(release).catch(() => undefined);
    else release();
  }
}
