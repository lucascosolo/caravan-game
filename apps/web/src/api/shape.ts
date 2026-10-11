/**
 * Payload guards (chunk 06 QA B1): a tiny shape validator the API client runs on every
 * response body BEFORE a screen sees it. The server is trusted to mean well, not to be
 * right: a proxy error page, a half-deployed server or a shape drift must become an
 * `ApiError(0, "bad_payload")` that the screen shows with a Retry — never a `TypeError`
 * deep in a render that blanks the page.
 *
 * No dependency: six combinators cover every response this client reads. Each guard is a
 * function `(value, path) => T` that returns the value typed, or throws `ShapeError` naming
 * the first offending path (`webs[2].nodes[0].tier`). Declare a shape typed against the
 * hand-written interface in types.ts (`const meShape: Guard<MeResponse> = object({...})`)
 * so TypeScript checks the guard and the type agree.
 *
 * Numbers: `integer()` refuses NaN, Infinity, fractions and strings. Pass bounds wherever a
 * value sizes a render (a tier builds a row; an unbounded tier would build millions).
 */

export type Guard<T> = (value: unknown, path: string) => T;

export class ShapeError extends Error {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly actual: unknown,
  ) {
    super(`${path || "$"}: expected ${expected}, got ${describe(actual)}`);
    this.name = "ShapeError";
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "string") return `string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
  if (typeof v === "number") return Number.isFinite(v) ? `number ${v}` : String(v);
  return typeof v;
}

function at(path: string, key: string | number): string {
  return typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;
}

export const string = (opts: { readonly maxLength?: number } = {}): Guard<string> => (v, path) => {
  if (typeof v !== "string") throw new ShapeError(path, "string", v);
  if (opts.maxLength !== undefined && v.length > opts.maxLength) throw new ShapeError(path, `string of at most ${opts.maxLength} chars`, v);
  return v;
};

export const boolean = (): Guard<boolean> => (v, path) => {
  if (typeof v !== "boolean") throw new ShapeError(path, "boolean", v);
  return v;
};

export const integer = (opts: { readonly min?: number; readonly max?: number } = {}): Guard<number> => (v, path) => {
  const bounds = `integer${opts.min !== undefined ? ` >= ${opts.min}` : ""}${opts.max !== undefined ? ` <= ${opts.max}` : ""}`;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ShapeError(path, bounds, v);
  if (opts.min !== undefined && v < opts.min) throw new ShapeError(path, bounds, v);
  if (opts.max !== undefined && v > opts.max) throw new ShapeError(path, bounds, v);
  return v;
};

export const literal = <const L extends readonly (string | number | boolean)[]>(...values: L): Guard<L[number]> => (v, path) => {
  if (!(values as readonly unknown[]).includes(v)) throw new ShapeError(path, `one of ${values.map((x) => JSON.stringify(x)).join(" | ")}`, v);
  return v as L[number];
};

export const nullable = <T>(inner: Guard<T>): Guard<T | null> => (v, path) => (v === null ? null : inner(v, path));

/** A field that may be absent (`undefined`); present values must still pass `inner`. */
export const optional = <T>(inner: Guard<T>): Guard<T | undefined> => (v, path) => (v === undefined ? undefined : inner(v, path));

export const array = <T>(item: Guard<T>, opts: { readonly maxLength?: number } = {}): Guard<readonly T[]> => (v, path) => {
  if (!Array.isArray(v)) throw new ShapeError(path, "array", v);
  if (opts.maxLength !== undefined && v.length > opts.maxLength) throw new ShapeError(path, `array of at most ${opts.maxLength}`, v);
  return v.map((x, i) => item(x, at(path, i)));
};

type Infer<F> = { readonly [K in keyof F]: F[K] extends Guard<infer T> ? T : never };

/** An object with exactly these fields checked. Extra fields are ignored (forward compatible). */
export const object = <F extends Record<string, Guard<unknown>>>(fields: F): Guard<Infer<F>> => (v, path) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ShapeError(path, "object", v);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    const got = fields[key]!((v as Record<string, unknown>)[key], at(path, key));
    if (got !== undefined) out[key] = got;
  }
  return out as Infer<F>;
};

/**
 * Run a guard over a payload. Returns the typed value or throws `ShapeError`; the API
 * client turns that into `ApiError(0, "bad_payload", …)` with the path as `detail`.
 */
export function expectShape<T>(guard: Guard<T>, value: unknown): T {
  return guard(value, "");
}
