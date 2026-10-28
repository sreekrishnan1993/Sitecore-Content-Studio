// In-process limits for the extraction endpoint.
//
// These protect a single server instance. On serverless or multi-instance hosting each instance
// has its own counters, so a deployment-level limit (WAF / API gateway / platform rate limiting)
// is still required — see README "Deployment requirements".

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  check(key: string): RateLimitDecision {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private prune(now: number) {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
    // Still too many distinct keys: drop the oldest entries rather than grow without bound.
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
  }
}

/** Caps simultaneous CPU/memory-heavy work (document parsing). */
export class ConcurrencyLimiter {
  private active = 0;

  constructor(private readonly max: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const extractionRateLimiter = new SlidingWindowLimiter(positiveInt(process.env.CONTENT_STUDIO_RATE_LIMIT_PER_MINUTE, 10), 60_000);
export const extractionConcurrency = new ConcurrencyLimiter(positiveInt(process.env.CONTENT_STUDIO_MAX_CONCURRENT_EXTRACTIONS, 2));

/**
 * Rate-limit key. Prefer the verified user. Otherwise use the client IP only from a header the
 * operator declares trustworthy (set by their proxy); untrusted forwarding headers are ignored
 * because any caller can forge them. Without either, all anonymous callers share one bucket.
 */
export function rateLimitKey(request: Request, subject: string | null, env: Record<string, string | undefined> = process.env): string {
  if (subject && subject !== "anonymous") return `user:${subject}`;
  const header = env.CONTENT_STUDIO_TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (header) {
    const value = request.headers.get(header)?.split(",")[0]?.trim();
    if (value) return `ip:${value.slice(0, 64)}`;
  }
  return "anonymous";
}
