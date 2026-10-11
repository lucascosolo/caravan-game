/**
 * Chunk 20 guardrail tests that need no database (GUARDRAILS §2):
 *   - the cosmetic rotation is byte-identical across separate Node processes;
 *   - the resolver dependency-boundary check passes and bans cosmetic / purchase modules;
 *   - nothing in packages/resolver, packages/circle, src/matchmaking, src/jobs, src/economy,
 *     src/acquisition, src/unlocks, src/progression, src/circle or src/party reads a
 *     purchase or cosmetic table, and nothing there imports the store;
 *   - the store reads nothing battle-side and credits only through appendCoinCredits;
 *   - the sandbox backend charges nothing and no billing SDK is a dependency.
 */
import { TUNABLES, cosmeticRotationForWeek, packOffersForWeek } from "@caravan/content";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SANDBOX_PURCHASE_BACKEND } from "../src/store/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "..");
const REPO = resolve(SERVER, "..", "..");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (e === "node_modules" || e === "dist" || e === "lint-fixtures") return [];
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|mts|js|mjs)$/.test(e) ? [full] : [];
  });
}

function codeLines(file: string): { line: string; n: number }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line));
}

const ROTATION_SCRIPT = `
import { cosmeticRotationForWeek, packOffersForWeek } from "@caravan/content";
const out = [];
for (let w = -2; w < 300; w++) out.push([w, cosmeticRotationForWeek(w), packOffersForWeek(w).map((o) => [o.tier, o.priceCents, o.coin, o.cosmetics.map((c) => c.id)])]);
process.stdout.write(JSON.stringify(out));
`;

function rotationInChildProcess(): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ROTATION_SCRIPT], { cwd: SERVER, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
}

describe("the rotation is deterministic across processes (GUARDRAILS §1)", () => {
  it("two separate Node processes and this one agree byte for byte on 302 weeks of offers", () => {
    const inProcess: unknown[] = [];
    for (let w = -2; w < 300; w++) inProcess.push([w, cosmeticRotationForWeek(w), packOffersForWeek(w).map((o) => [o.tier, o.priceCents, o.coin, o.cosmetics.map((c) => c.id)])]);
    const here = JSON.stringify(inProcess);
    const a = rotationInChildProcess();
    const b = rotationInChildProcess();
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(sha(a)).toBe(sha(here));
    expect(sha(b)).toBe(sha(here));
    expect(a.length).toBeGreaterThan(10_000);
  }, 60_000);
});

describe("the resolver cannot reach purchase or entitlement state (dependency boundary)", () => {
  it("scripts/resolver-boundary-check.mjs passes, and its banned-specifier list names cosmetic, pack, purchase, entitlement and store", () => {
    const script = join(REPO, "scripts", "resolver-boundary-check.mjs");
    const out = execFileSync(process.execPath, [script], { cwd: REPO, encoding: "utf8" });
    expect(out).toMatch(/Resolver boundary check passed/);
    const src = readFileSync(script, "utf8");
    const line = src.split("\n").find((l) => l.startsWith("const FORBIDDEN_SPECIFIER"))!;
    expect(line).toBeDefined();
    const re = new RegExp(line.slice(line.indexOf("/") + 1, line.lastIndexOf("/")), "i");
    for (const spec of ["cosmetic", "./cosmetics.js", "@caravan/content", "../../apps/server/src/store/purchase.js", "entitlement", "../packs.js", "billing/stripe", "pg"]) {
      expect(re.test(spec), spec).toBe(true);
    }
    for (const spec of ["./fixed.js", "../battlefield.js", "./tick.js"]) expect(re.test(spec), spec).toBe(false);
  });

  it("the resolver package has zero dependencies and no file in it names a store, cosmetic or purchase module", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "packages", "resolver", "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const f of walk(join(REPO, "packages", "resolver", "src"))) {
      for (const { line, n } of codeLines(f)) {
        expect(line, `${f}:${n}`).not.toMatch(/cosmetic|purchas|entitle|pack_purchase|@caravan\/content|apps\/server/i);
      }
    }
  });
});

describe("no battle-side, matchmaking or acquisition code reads a purchase or cosmetic table", () => {
  const TABLE_WORDS = /pack_purchase|cosmetic_ownership|cosmetic_equip|\bcosmetic|entitlement|\/store\//i;
  const dirs = [
    join(REPO, "packages", "resolver", "src"),
    join(REPO, "packages", "circle", "src"),
    join(SERVER, "src", "matchmaking"),
    join(SERVER, "src", "jobs"),
    join(SERVER, "src", "economy"),
    join(SERVER, "src", "acquisition"),
    join(SERVER, "src", "unlocks"),
    join(SERVER, "src", "progression"),
    join(SERVER, "src", "circle"),
    join(SERVER, "src", "party"),
    join(SERVER, "src", "ledger"),
    join(SERVER, "src", "repo"),
  ];

  it("grep: none of those directories mentions the tables, the word cosmetic, entitlement, or imports from src/store", () => {
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const f of walk(dir)) {
        for (const { line, n } of codeLines(f)) if (TABLE_WORDS.test(line)) offenders.push(`${f.slice(REPO.length + 1)}:${n}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(dirs.filter((d) => existsSync(d)).length).toBe(dirs.length);
  });

  it("no SQL anywhere outside src/store touches the store's tables, and the store's own SQL touches only its own tables", () => {
    const outside = walk(join(SERVER, "src")).filter((f) => !f.includes("/store/"));
    for (const f of outside) {
      for (const { line, n } of codeLines(f)) expect(line, `${f}:${n}`).not.toMatch(/\b(FROM|INTO|UPDATE|JOIN)\s+(pack_purchase|cosmetic_ownership|cosmetic_equip)\b/i);
    }
    const storeFiles = walk(join(SERVER, "src", "store"));
    expect(storeFiles.length).toBeGreaterThan(3);
    const tables = new Set<string>();
    for (const f of storeFiles) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/g)) tables.add(m[1]!);
    }
    // The store's own SQL names only its own tables: the balance and the cap are read and
    // written through the economy module (peekTrickle / appendCoinCredits), never directly.
    expect([...tables].sort()).toEqual(["cosmetic_equip", "cosmetic_ownership", "pack_purchase"]);
    for (const f of storeFiles) expect(readFileSync(f, "utf8"), f).not.toMatch(/FROM account\b|UPDATE account\b/i);
  });

  it("the store credits Coin only through appendCoinCredits (no hand-built coin_purchased drafts, no coinCreditDraft, no direct ledger insert)", () => {
    const storeFiles = walk(join(SERVER, "src", "store"));
    for (const f of storeFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/coinCreditDraft|INSERT INTO ledger_event|appendEvents\(/);
    }
    const purchase = readFileSync(join(SERVER, "src", "store", "purchase.ts"), "utf8");
    expect(purchase).toMatch(/appendCoinCredits\(/);
    expect(purchase).toMatch(/type: "coin_purchased"/);
    // And coin_purchased is written nowhere else in the server.
    const writers = walk(join(SERVER, "src")).filter((f) => !f.endsWith("ledger/events.ts") && !f.endsWith("ledger/coin.ts") && /["']coin_purchased["']/.test(readFileSync(f, "utf8")));
    expect(writers.map((f) => f.slice(SERVER.length + 1))).toEqual(["src/store/purchase.ts"]);
  });

  it("the store cannot sell anything but Coin and cosmetics: no forbidden content kind appears in any pack-content position", () => {
    for (const f of [...walk(join(SERVER, "src", "store")), join(REPO, "packages", "content", "src", "packs.ts")]) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/kind:\s*"([a-z_]+)"/g)) expect(["coin", "cosmetic"], `${f}: kind "${m[1]}"`).toContain(m[1]);
      expect(src, f).not.toMatch(/unlock_points_granted|unit_acquired|trip_cap|FENCE_MATERIAL|reroll|resupply|repair/i);
    }
  });
});

describe("the purchase backend is a sandbox stub (no real charge anywhere)", () => {
  it("TUNABLES.PURCHASE_BACKEND is the stub; a charge records 0 cents and a sandbox receipt", () => {
    expect(TUNABLES.PURCHASE_BACKEND).toBe("sandbox_stub");
    expect(SANDBOX_PURCHASE_BACKEND.name).toBe("sandbox_stub");
    const offer = packOffersForWeek(0)[0]!;
    const receipt = SANDBOX_PURCHASE_BACKEND.charge({ accountId: "00000000-0000-0000-0000-000000000000", offer });
    expect(receipt.chargedCents).toBe(0);
    expect(receipt.backend).toBe("sandbox_stub");
    expect(receipt.receipt).toMatch(/^sandbox:[0-9a-f-]{36}$/);
    const src = readFileSync(join(SERVER, "src", "store", "sandbox.ts"), "utf8");
    expect(src).toMatch(/NO MONEY MOVES/);
  });

  it("no payment SDK is a dependency of any workspace package", () => {
    for (const p of ["apps/server/package.json", "apps/web/package.json", "packages/content/package.json", "packages/circle/package.json", "packages/resolver/package.json", "package.json"]) {
      const file = join(REPO, p);
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      const names = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      expect(names.filter((n) => /stripe|paypal|braintree|iap|billing|revenuecat|adyen|square/i.test(n)), p).toEqual([]);
    }
  });
});
