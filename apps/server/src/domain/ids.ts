import { randomUUID } from "node:crypto";

/**
 * Small seam around id generation so tests can inject a deterministic
 * generator instead of random UUIDs, without touching call sites.
 */
export interface IdGenerator {
  next(prefix: string): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

/** Deterministic, monotonically-increasing ids — for tests only. */
export class CountingIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const current = this.counters.get(prefix) ?? 0;
    this.counters.set(prefix, current + 1);
    return `${prefix}_${current}`;
  }
}
