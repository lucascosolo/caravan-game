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

  /**
   * Final review D2: refuse (RateLimitedError) when `key` has ALREADY used up `name`'s window, without
   * counting this request. Pair with `record` to count only failures.
   */
  check(name: RateLimitName, key: string): void {
    if (!this.rules) return;
    const rule = this.rules[name];
    const t = this.now();
    const w = this.windows.get(`${name}\u0000${key}`);
    if (w && t - w.start < rule.windowMs && w.count >= rule.limit) throw new RateLimitedError(Math.max(1, w.start + rule.windowMs - t));
  }

  /** Count one event (a failure) against `name` for `key`, never throwing. */
  record(name: RateLimitName, key: string): void {
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
  }

  /** Forget `key`'s window for `name` (a success clears its failures). */
  reset(name: RateLimitName, key: string): void {
    this.windows.delete(`${name}\u0000${key}`);
  }

  private sweep(t: number): void {
    const longest = this.rules ? Math.max(...Object.values(this.rules).map((r) => r.windowMs)) : 0;
    for (const [k, w] of this.windows) if (t - w.start >= longest) this.windows.delete(k);
  }
}

/**
 * Final review D2: the password-failure limits for one (username, address). `check` refuses when
 * either window is used up; `fail` counts one wrong password; `succeed` clears the pair's count.
 * Usernames are matched case-insensitively and capped like the login form.
 */
export function passwordFailureLimits(limiter: RateLimiter, rawUsername: string, address: string) {
  const user = rawUsername.trim().toLowerCase().slice(0, 64);
  const pair = `${user}\u0000${address}`;
  return {
    check(): void {
      limiter.check("loginFailuresPerUsernameAddress", pair);
      limiter.check("loginFailuresPerUsername", user);
    },
    fail(): void {
      limiter.record("loginFailuresPerUsernameAddress", pair);
      limiter.record("loginFailuresPerUsername", user);
    },
    succeed(): void {
      limiter.reset("loginFailuresPerUsernameAddress", pair);
    },
  };
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
