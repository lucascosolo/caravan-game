/**
 * Chunk 30: a fixed-window rate limiter for the auth and account routes. In memory, per
 * process, no dependency. Each (rule, key) pair counts requests in the current window; over
 * the limit is a 429 `rate_limited` with `retryAfterMs` and a Retry-After header.
 *
 * Operational, never a game rule: nothing here enters a resolution.
 */
import type { FastifyReply } from "fastify";
import { AppError } from "../services/errors.js";
import { RATE_LIMITS, type RateLimitConfig, type RateLimitName } from "./tunables.js";

export class RateLimitedError extends AppError {
  constructor(public readonly retryAfterMs: number) {
    super(429, "rate_limited", `too many attempts; try again in ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = "RateLimitedError";
  }
}

interface Window {
  start: number;
  count: number;
}

/** Entries swept when the map grows past this, so a spray of distinct keys cannot grow it without bound. */
const SWEEP_AT = 10_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly rules: RateLimitConfig | null = RATE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one request against `name` for `key`; throws RateLimitedError when over the limit. Off when constructed with null. */
  hit(name: RateLimitName, key: string): void {
    if (!this.rules) return;
    const rule = this.rules[name];
    const t = this.now();
    const id = `${name}\u0000${key}`;
    let w = this.windows.get(id);
    if (!w || t - w.start >= rule.windowMs) {
      if (this.windows.size >= SWEEP_AT) this.sweep(t);
      w = { start: t, count: 0 };
      this.windows.set(id, w);
    }
    w.count += 1;
    if (w.count > rule.limit) throw new RateLimitedError(Math.max(1, w.start + rule.windowMs - t));
  }

  private sweep(t: number): void {
    const longest = this.rules ? Math.max(...Object.values(this.rules).map((r) => r.windowMs)) : 0;
    for (const [k, w] of this.windows) if (t - w.start >= longest) this.windows.delete(k);
  }
}

/** Fastify error-handler helper: the Retry-After header and the body's retryAfterMs. */
export function sendRateLimited(reply: FastifyReply, err: RateLimitedError): FastifyReply {
  return reply
    .code(429)
    .header("retry-after", String(Math.ceil(err.retryAfterMs / 1000)))
    .send({ error: err.code, message: err.message, retryAfterMs: err.retryAfterMs });
}

/** Rate limits are on unless the process says otherwise: CARAVAN_RATE_LIMITS=off (the server test suite; never production). */
export function rateLimitsFromEnv(env: NodeJS.ProcessEnv): RateLimitConfig | null {
  const v = env["CARAVAN_RATE_LIMITS"];
  if (v === undefined || v === "on") return RATE_LIMITS;
  if (v === "off") {
    if (env["NODE_ENV"] === "production") throw new Error("CARAVAN_RATE_LIMITS=off is refused with NODE_ENV=production");
    return null;
  }
  throw new Error(`CARAVAN_RATE_LIMITS must be 'on' or 'off', got '${v}'`);
}
