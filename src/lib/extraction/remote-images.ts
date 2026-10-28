import "server-only";
import type { ExtractedImage, ExtractionResult } from "../types/extraction";
import { checkMediaImage } from "../validation/file";
import { sniffImage, toDataUrl } from "./images";
import { MAX_MEDIA_IMAGE_BYTES, MIN_IMAGE_DIMENSION } from "./limits";
import { fetchPublication, type FetchOptions } from "./url-fetch";

// Downloads the images a publication page references, so they can be reviewed and uploaded to
// the Media Library like images extracted from a document. Every request goes through the same
// SSRF-safe fetcher as the page itself (public addresses only, re-checked on every redirect).
// The format is taken from the file signature, never from the server's Content-Type.

/**
 * Downloaded images travel back inline in the JSON response (base64, about a third larger).
 * Serverless platforms cap response bodies (Vercel: 4.5 MB), so the total stays well below that.
 */
export const MAX_URL_IMAGE_TOTAL_BYTES = 3 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8_000;
/** Time budget for all image downloads, within the endpoint's 45 s processing deadline. */
const IMAGE_BUDGET_MS = 20_000;
const CONCURRENCY = 4;
const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp;q=0.9";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export interface RemoteImageOptions {
  /** Test hooks, passed to the fetcher. */
  fetchOptions?: Omit<FetchOptions, "accept" | "maxBytes" | "timeoutMs">;
  budgetMs?: number;
  maxTotalBytes?: number;
}

type Outcome = { ok: true; image: ExtractedImage; bytes: number } | { ok: false; reason: string };

function withExtension(fileName: string, mimeType: string): string {
  const base = fileName.replace(/\.[a-z0-9]{1,5}$/i, "") || "image";
  return `${base}.${EXTENSIONS[mimeType]}`;
}

async function download(image: ExtractedImage, timeoutMs: number, options: RemoteImageOptions): Promise<Outcome> {
  let bytes: Uint8Array;
  try {
    ({ bytes } = await fetchPublication(image.src, { ...options.fetchOptions, accept: IMAGE_ACCEPT, maxBytes: MAX_MEDIA_IMAGE_BYTES, timeoutMs }));
  } catch {
    return { ok: false, reason: "could not be downloaded" };
  }
  const info = sniffImage(bytes);
  if (!info) return { ok: false, reason: "is not a PNG, JPEG, GIF or WebP image" };
  if (checkMediaImage(info.mimeType, bytes.byteLength)) return { ok: false, reason: "is not a supported image" };
  if ((info.width && info.width < MIN_IMAGE_DIMENSION) || (info.height && info.height < MIN_IMAGE_DIMENSION)) return { ok: false, reason: "is an icon-sized image" };
  return {
    ok: true,
    bytes: bytes.byteLength,
    image: {
      ...image,
      fileName: withExtension(image.fileName, info.mimeType),
      mimeType: info.mimeType,
      byteSize: bytes.byteLength,
      width: info.width ?? image.width,
      height: info.height ?? image.height,
      src: toDataUrl(info.mimeType, bytes),
      origin: "extracted",
    },
  };
}

/**
 * Replaces referenced (remote) images with downloaded copies. Images that cannot be downloaded,
 * are not supported, or exceed the time or size budget stay referenced, and a warning says so.
 * Icon-sized images are dropped.
 */
export async function downloadReferencedImages(result: ExtractionResult, options: RemoteImageOptions = {}): Promise<ExtractionResult> {
  const pending = result.images.map((image, index) => ({ image, index })).filter(({ image }) => image.origin === "referenced" && /^https?:/.test(image.src));
  if (pending.length === 0) return result;

  const deadline = Date.now() + (options.budgetMs ?? IMAGE_BUDGET_MS);
  const maxTotal = options.maxTotalBytes ?? MAX_URL_IMAGE_TOTAL_BYTES;
  const outcomes = new Map<number, Outcome>();
  let next = 0;

  const worker = async () => {
    while (next < pending.length) {
      const { image, index } = pending[next++];
      const remaining = deadline - Date.now();
      if (remaining < 1_000) {
        outcomes.set(index, { ok: false, reason: "was skipped because the time limit was reached" });
        continue;
      }
      outcomes.set(index, await download(image, Math.min(IMAGE_TIMEOUT_MS, remaining), options));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  // Apply the size budget in document order, so the first images on the page are kept.
  let total = 0;
  const images: ExtractedImage[] = [];
  const failed: string[] = [];
  let dropped = 0;
  let overBudget = 0;
  result.images.forEach((image, index) => {
    const outcome = outcomes.get(index);
    if (!outcome) return images.push(image);
    if (outcome.ok) {
      if (total + outcome.bytes <= maxTotal) {
        total += outcome.bytes;
        return images.push(outcome.image);
      }
      overBudget++;
      return images.push(image);
    }
    if (outcome.reason === "is an icon-sized image") {
      dropped++;
      return;
    }
    failed.push(`${image.fileName} ${outcome.reason}`);
    images.push(image);
  });

  const warnings = [...result.warnings];
  if (failed.length > 0) {
    warnings.push({ code: "image-skipped", message: `${failed.length} image(s) are only linked, not downloaded, so they cannot be uploaded: ${failed.slice(0, 5).join("; ")}${failed.length > 5 ? "; …" : ""}.` });
  }
  if (overBudget > 0) {
    warnings.push({ code: "images-truncated", message: `${overBudget} image(s) were not downloaded because the page's images exceed ${Math.round(maxTotal / 1024 / 1024)} MB in total. Download them from the page and upload them to the Media Library manually.` });
  }
  if (dropped > 0) {
    warnings.push({ code: "image-skipped", message: `${dropped} icon-sized image(s) were left out.` });
  }
  return { ...result, images, warnings };
}
