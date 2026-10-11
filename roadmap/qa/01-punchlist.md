# Chunk 01 — QA punch list (commit c1ce47e)

No blockers. Items 4–8 (resolver lint rules) are assigned to the chunk 21 Maker, who owns eslint.config.js. Items 1–3 and 9–17 go to the chunk 01 fixer.

## Should-fix
1. [closed] `TRUNCATE pool_progress` bypasses the row-level permanence/delete guards (001_core_schema.up.sql:156-175). Add a BEFORE TRUNCATE statement trigger that raises; switch test/helpers.ts:11 from `TRUNCATE account CASCADE` to `DELETE FROM account`; add a test that truncate is refused.
2. [closed] Deleting a caravan is unguarded and erases its living ladder/unlock points (001:66-93). Add `caravan_guard_delete` refusing deletion while the owning account exists, mirroring `pool_progress_guard_delete`, plus a test.
3. [closed] The runtime DB role is a superuser that owns every table, so `ALTER TABLE ... DISABLE TRIGGER` undoes every guard. Run migrations as the owner role and the server as a separate non-superuser role with DML-only grants (no ALTER/TRUNCATE/TRIGGER). Document in .env.example and AGENTS.md; add a test (as the app role) that disabling a trigger is refused.
4. (→21) Relative import `../../content/...` escapes the resolver package and passes lint (eslint.config.js:50-55).
5. (→21) Float/alias evasions pass lint: `Number("0.5")`, `+"0.5"`, `JSON.parse`, `const m = Math; m.random()`, `Math["ran"+"dom"]`, `eval`, `Function`, `DataView.getFloat32`, `Infinity`, `NaN`, `WeakRef`.
6. (→21) `(a / b) | 0` is accepted as truncation but wraps to int32; drop the `| 0` exemption, keep Math.trunc/Math.floor only; remove allowed.ts:6.
7. (→21) The Map/Set iteration rule is dead code (eslint.config.js:80). Ban `Map`/`Set` globals in the resolver outright (use sorted arrays / id-keyed objects) and say so in the comment.
8. (→21) Isolation rules apply to `src/**/*.ts` only; widen to `src/**/*.{ts,mts,cts,js,mjs}`.

## Nits
9. [closed] routes/auth.ts:27-43 + services/onboarding.ts:34 — no upper bound on password (≤128) or caravanName (1–40, trimmed, non-empty).
10. [closed] routes/auth.ts:54-57 — unknown-username login returns ~1 ms vs ~48 ms: run verifyPassword against a fixed dummy hash when the account is missing.
11. [closed] auth/sessions.ts:31-32 — accept `/^Bearer\s+(\S+)$/i` exactly; reject trailing tokens.
12. [closed] repo/sessions.ts — purge expired sessions on login; cap sessions per account (e.g. 10, oldest evicted).
13. [closed] 001:120 — `unlock_points_spent` can be lowered freely. PROJECT.md has no refund/respec: guard decreases in the permanence trigger.
14. [closed] 001:182-189 — `unit_type_id` accepts `''`; add CHECK length > 0. Note in the migration comment that every caravan must have a living progress row (app-enforced until chunk 04).
15. [closed] 001:41 — coin cap is a hard CHECK; chunk 16/19 must clamp before writing. Add a comment at the constraint saying so.
16. [closed] db/migrate.ts:25 — sort migrations by parsed numeric id and reject duplicate ids.
17. [closed] db/pool.ts:8 — `setTypeParser(20, Number)` is lossy above 2^53; add a comment for chunk 02's ledger to pick a type deliberately.
