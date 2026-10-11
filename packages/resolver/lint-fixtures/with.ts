// `with` is a syntax error in module code, so it cannot share violations.ts. The self-test
// lints this file on its own and asserts it errors (parse error or WithStatement rule).
const o = { a: 1 };
with (o) { a; }
