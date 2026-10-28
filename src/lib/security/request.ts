/**
 * Browsers send Sec-Fetch-Site / Origin. Cross-site browser requests are refused so another
 * website cannot drive the API from a victim's browser. This is not authentication:
 * non-browser clients can omit these headers, which is why authentication runs first.
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return true;
  }
}

/** Rejects with `onTimeout()` if `work` does not settle within `ms`. The work itself keeps running. */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
