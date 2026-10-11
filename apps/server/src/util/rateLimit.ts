/**
 * A per-key sliding-window request limit, in memory (chunk 09 QA S4). An ABUSE limit on
 * write endpoints — never a gameplay cooldown, never purchasable, never consulted by
 * anything that decides an outcome. Per process: a multi-process deployment limits per
 * process, which is still a bound; nothing here is a correctness guarantee.
 *
 * `allow(key, nowMs)` records the request and says whether it is within the limit:
 * `count` requests per `windowMs`, counted over the trailing window. The clock is passed
 * in so a test can drive it; nothing reads Date.now() here.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    public readonly count: number,
    public readonly windowMs: number,
  ) {
    if (!Number.isInteger(count) || count < 1) throw new RangeError(`count ${String(count)}`);
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError(`windowMs ${String(windowMs)}`);
  }

  /** Records the request at `nowMs`; true when it is within the limit, false when it must be refused. */
  allow(key: string, nowMs: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const cutoff = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.count) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, recent[0]! + this.windowMs - nowMs) };
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return { ok: true };
  }

  /** Forget one key, or everything. */
  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  /** Drop keys with no hits inside the window — call occasionally so idle keys do not accumulate. */
  prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [key, times] of this.hits) {
      if (!times.some((t) => t > cutoff)) this.hits.delete(key);
    }
  }
}
