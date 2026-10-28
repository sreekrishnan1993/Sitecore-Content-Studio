import type { ExtractionResult } from "../types/extraction";

/**
 * Optional AI enhancement step (classification, rewriting suggestions).
 *
 * An enhancer receives deterministic extraction output and may append blocks with
 * origin "ai-suggestion". It must never modify or replace "extracted" blocks, so the
 * author can always tell source text from generated suggestions. Document text is
 * untrusted input and must be passed to a model as data, never as instructions.
 *
 * No enhancer ships with the MVP; register one here when credentials are available
 * (keep the API key in a server-side environment variable).
 */
export interface ContentEnhancer {
  id: string;
  enhance(result: ExtractionResult): Promise<ExtractionResult>;
}

export function getContentEnhancer(): ContentEnhancer | null {
  return null;
}
