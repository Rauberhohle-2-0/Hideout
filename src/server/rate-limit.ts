import type { Context } from "hono";

/**
 * Fixed-window, in-memory rate limiter: up to `maxReq` requests per client per
 * `windowMs` per route group. Returns a 429 Response when the caller is over the
 * limit, otherwise null. In-memory on purpose — the sidecar is single-process
 * and the limiter exists to stop a burst, not to be a distributed gate.
 */
export interface RateLimiter {
  (c: Context): Response | null;
  /** Test hook: forget every client's counters. */
  clear(): void;
}

export function createRateLimiter(
  group: string,
  windowMs = 60_000,
  maxReq = 60,
): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const limiter: RateLimiter = (c) => {
    // Single-user app bound to loopback: treat every connection as one client and
    // never trust spoofable proxy headers (x-forwarded-for / x-real-ip) to identify it.
    const key = `loopback:${group}`;
    const now = Date.now();
    const cur = buckets.get(key);
    if (!cur || now > cur.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return null;
    }
    if (cur.count >= maxReq) {
      return c.json({ error: "Rate limited" }, 429);
    }
    cur.count++;
    return null;
  };

  limiter.clear = () => buckets.clear();
  return limiter;
}
