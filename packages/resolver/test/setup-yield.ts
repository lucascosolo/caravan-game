/**
 * QA-13 S6: every resolver test file is mostly synchronous CPU work, and between tests vitest only
 * awaits promises (microtasks) — so the worker's event loop never runs during a file, and the reply
 * to its "onTaskUpdate" RPC waits until the file ends. On a loaded runner a file past 60 s then
 * fails the run ("Timeout calling onTaskUpdate", exit 1, every test green). One macrotask yield
 * before every test lets the RPC through. It checks nothing and changes no result.
 */
import { beforeEach } from "vitest";

beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
