/**
 * The art pipeline CLI (PHASE-2 §26). Run from the repo root through the pnpm scripts:
 *
 *   pnpm art:intake <image> <class> <key> --footprint WxH [--meta provenance.json]
 *       paint one source into assets/art/<class>/<key>/: master.png (trimmed, harmonised,
 *       outlined, at the 3x device size), body.png (the same before the outline, which the
 *       build regrows per DPR), asset.json (footprint, anchor, poses), provenance.json.
 *   pnpm art:build   per-scene atlases at 1x/2x/3x (WebP + PNG) in apps/web/public/art and the
 *                    manifest the web app imports (apps/web/src/art/generated/manifest.json).
 *                    Both are build output: gitignored, never hand-edited.
 *   pnpm art:check   coverage + size/anchor rules + provenance + the payload budget (needs
 *                    `pnpm build` first, for apps/web/dist and the atlases).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type Sharp } from "sharp";
import { measureBudget } from "./budget.ts";
import { ART_CLASSES, checkCoverage, expectedIds, type ArtClass, type Finding } from "./coverage.ts";
import { HARMONISE_STRENGTH, MASTER_DPR, OUTLINE_PX, findAnchor, harmoniseImage, outline, placeOnCanvas, trimClean, type Rgba } from "./paint.ts";
import { CLASS_RULES, checkAssetRules, type AssetMeta } from "./rules.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ART = path.join(ROOT, "assets/art");
const WEB = path.join(ROOT, "apps/web");
const ATLAS_OUT = path.join(WEB, "public/art");
const MANIFEST_OUT = path.join(WEB, "src/art/generated/manifest.json");
const DPRS = [1, 2, 3] as const;
type Dpr = (typeof DPRS)[number];

/** Which classes each scene's atlas carries (units appear in both). */
export const SCENES: Record<"town" | "battle", readonly ArtClass[]> = {
  town: ["units", "town", "ui"],
  battle: ["units", "wagons", "fences", "traps", "siege", "terrain"],
};
const ATLAS_PAD = 2; // art px between frames
const ATLAS_MAX_W = 1024; // art px (3072 device px at 3x)
const PROVENANCE_KEYS = ["source", "model", "prompt", "seed", "cost_usd", "date", "licence"];

async function readRgba(file: string | Buffer, raw?: { width: number; height: number }): Promise<Rgba> {
  const img = raw ? sharp(file, { raw: { ...raw, channels: 4 } }) : sharp(file);
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

async function resize(img: Rgba, w: number, h: number): Promise<Rgba> {
  if (img.width === w && img.height === h) return img;
  return readRgba(
    await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } }).resize(w, h, { kernel: "lanczos3", fit: "fill" }).raw().toBuffer(),
    { width: w, height: h },
  );
}

const png = (img: Rgba): Sharp => sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } });

/** Fit `body` into the footprint at `dpr`, bottom-centred, and grow that DPR's outline. */
async function renderAt(body: Rgba, footprint: [number, number], dpr: Dpr): Promise<{ canvas: Rgba; final: Rgba }> {
  const o = OUTLINE_PX[dpr];
  const fw = footprint[0] * dpr, fh = footprint[1] * dpr;
  const sc = Math.min((fw - 2 * o) / body.width, (fh - 2 * o) / body.height);
  const sized = dpr === MASTER_DPR ? body : await resize(body, Math.max(1, Math.round(body.width * sc)), Math.max(1, Math.round(body.height * sc)));
  const canvas = placeOnCanvas(sized, fw, fh, o);
  return { canvas, final: outline(canvas, o) };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function intake(args: string[]): Promise<void> {
  const [image, cls, key] = args;
  const fp = arg(args, "--footprint")?.split("x").map(Number);
  if (!image || !cls || !key || !fp || fp.length !== 2 || fp.some((n) => !Number.isInteger(n))) {
    throw new Error("usage: art:intake <image> <class> <key> --footprint WxH [--meta provenance.json]");
  }
  if (!(ART_CLASSES as readonly string[]).includes(cls)) throw new Error(`unknown class '${cls}' (${ART_CLASSES.join(", ")})`);
  const rule = CLASS_RULES[cls as ArtClass];
  const footprint: [number, number] = [fp[0]!, fp[1]!];
  const cwd = process.env["INIT_CWD"] ?? process.cwd();
  const src = path.resolve(cwd, image);
  const raw = trimClean(await readRgba(src));
  const o = OUTLINE_PX[MASTER_DPR];
  const fw = footprint[0] * MASTER_DPR, fh = footprint[1] * MASTER_DPR;
  const sc = Math.min((fw - 2 * o) / raw.width, (fh - 2 * o) / raw.height);
  const body = harmoniseImage(await resize(raw, Math.max(1, Math.round(raw.width * sc)), Math.max(1, Math.round(raw.height * sc))), rule.sideColour, HARMONISE_STRENGTH);
  const { canvas, final } = await renderAt(body, footprint, MASTER_DPR);
  const [ax, ay] = findAnchor(canvas, rule.anchorKind);
  const meta: AssetMeta = {
    footprint,
    anchor: [Math.round((ax / MASTER_DPR) * 100) / 100, Math.round((ay / MASTER_DPR) * 100) / 100],
    poses: { idle: ["master.png"] },
  };
  const dir = path.join(ART, cls, key);
  mkdirSync(dir, { recursive: true });
  await png(body).png({ compressionLevel: 9 }).toFile(path.join(dir, "body.png"));
  await png(final).png({ compressionLevel: 9 }).toFile(path.join(dir, "master.png"));
  writeFileSync(path.join(dir, "asset.json"), JSON.stringify(meta, null, 2) + "\n");
  const metaFile = arg(args, "--meta");
  const given = metaFile ? (JSON.parse(readFileSync(path.resolve(cwd, metaFile), "utf8")) as Record<string, unknown>) : {};
  const provenance = { source: path.basename(src), ...given, intake: { tool: "pnpm art:intake", harmonise_strength: HARMONISE_STRENGTH, outline_px: OUTLINE_PX, master_dpr: MASTER_DPR } };
  writeFileSync(path.join(dir, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  console.log(`art:intake: ${cls}/${key} ${footprint.join("x")} anchor ${meta.anchor.join(",")} → ${path.relative(ROOT, dir)}`);
}

interface Entry {
  cls: ArtClass;
  key: string;
  dir: string;
  meta: AssetMeta;
}

function scanAssets(): Entry[] {
  const out: Entry[] = [];
  for (const cls of ART_CLASSES) {
    const cdir = path.join(ART, cls);
    if (!existsSync(cdir)) continue;
    for (const key of readdirSync(cdir).sort()) {
      const dir = path.join(cdir, key);
      if (!statSync(dir).isDirectory()) continue;
      const metaPath = path.join(dir, "asset.json");
      const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as AssetMeta) : { footprint: [0, 0] as [number, number], anchor: [0, 0] as [number, number], poses: {} };
      out.push({ cls, key, dir, meta });
    }
  }
  return out;
}

function readFallbacks(): Partial<Record<ArtClass, string[]>> {
  const f = path.join(ART, "fallbacks.json");
  if (!existsSync(f)) return {};
  const { fallbacks } = JSON.parse(readFileSync(f, "utf8")) as { fallbacks: Partial<Record<ArtClass, string[]>> };
  return fallbacks;
}

interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shelf packing in art px, tallest first; every DPR uses the same layout scaled. */
function pack(items: { id: string; w: number; h: number }[]): { placed: Placed[]; width: number; height: number } {
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w || a.id.localeCompare(b.id));
  const placed: Placed[] = [];
  let x = 0, y = 0, shelf = 0, width = 0;
  for (const it of sorted) {
    if (x > 0 && x + it.w > ATLAS_MAX_W) {
      y += shelf + ATLAS_PAD;
      x = 0;
      shelf = 0;
    }
    placed.push({ id: it.id, x, y, w: it.w, h: it.h });
    x += it.w + ATLAS_PAD;
    shelf = Math.max(shelf, it.h);
    width = Math.max(width, x - ATLAS_PAD);
  }
  return { placed, width, height: y + shelf };
}

async function build(): Promise<void> {
  const entries = scanAssets();
  const rendered = new Map<string, Record<Dpr, Rgba>>();
  for (const e of entries) {
    const body = await readRgba(path.join(e.dir, "body.png"));
    const byDpr = {} as Record<Dpr, Rgba>;
    for (const d of DPRS) byDpr[d] = d === MASTER_DPR ? await readRgba(path.join(e.dir, "master.png")) : (await renderAt(body, e.meta.footprint, d)).final;
    rendered.set(`${e.cls}/${e.key}`, byDpr);
  }
  mkdirSync(ATLAS_OUT, { recursive: true });
  mkdirSync(path.dirname(MANIFEST_OUT), { recursive: true });
  const manifest = {
    version: 1 as const,
    assets: Object.fromEntries(
      entries.map((e) => [`${e.cls}/${e.key}`, { class: e.cls, key: e.key, footprint: e.meta.footprint, anchor: e.meta.anchor, poses: { idle: [`${e.cls}/${e.key}`] } }]),
    ),
    scenes: {} as Record<string, unknown>,
  };
  for (const [scene, classes] of Object.entries(SCENES)) {
    const items = entries.filter((e) => classes.includes(e.cls)).map((e) => ({ id: `${e.cls}/${e.key}`, w: e.meta.footprint[0], h: e.meta.footprint[1] }));
    if (items.length === 0) continue;
    const { placed, width, height } = pack(items);
    const files: Record<string, unknown> = {};
    for (const d of DPRS) {
      const composite = placed.map((p) => {
        const img = rendered.get(p.id)![d];
        return { input: Buffer.from(img.data), raw: { width: img.width, height: img.height, channels: 4 as const }, left: p.x * d, top: p.y * d };
      });
      const base = sharp({ create: { width: width * d, height: height * d, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composite);
      const pngBuf = await base.clone().png({ compressionLevel: 9 }).toBuffer();
      const webpBuf = await sharp(pngBuf).webp({ lossless: true, effort: 6 }).toBuffer();
      const name = `${scene}@${d}x`;
      writeFileSync(path.join(ATLAS_OUT, `${name}.png`), pngBuf);
      writeFileSync(path.join(ATLAS_OUT, `${name}.webp`), webpBuf);
      const v = (b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 10);
      files[String(d)] = { webp: `art/${name}.webp?v=${v(webpBuf)}`, png: `art/${name}.png?v=${v(pngBuf)}`, bytes: { webp: webpBuf.length, png: pngBuf.length } };
    }
    manifest.scenes[scene] = { width, height, files, frames: Object.fromEntries(placed.map((p) => [p.id, { x: p.x, y: p.y, w: p.w, h: p.h }])) };
    console.log(`art:build: ${scene} atlas ${width}x${height} art px, ${placed.length} frames`);
  }
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`art:build: wrote ${path.relative(ROOT, ATLAS_OUT)} and ${path.relative(ROOT, MANIFEST_OUT)}`);
}

async function check(): Promise<number> {
  const entries = scanAssets();
  const assets: Partial<Record<ArtClass, string[]>> = {};
  for (const e of entries) (assets[e.cls] ??= []).push(e.key);
  const findings: Finding[] = checkCoverage({ expected: expectedIds(), assets, fallbacks: readFallbacks() });
  for (const e of entries) {
    const id = `${e.cls}/${e.key}`;
    const missing = ["asset.json", "master.png", "body.png", "provenance.json"].filter((f) => !existsSync(path.join(e.dir, f)));
    if (missing.length) {
      findings.push({ level: "error", id, message: `missing ${missing.join(", ")}` });
      continue;
    }
    const masterPath = path.join(e.dir, "master.png");
    const m = await sharp(masterPath).metadata();
    findings.push(...checkAssetRules(e.cls, e.key, e.meta, { width: m.width ?? 0, height: m.height ?? 0, bytes: statSync(masterPath).size }));
    const prov = JSON.parse(readFileSync(path.join(e.dir, "provenance.json"), "utf8")) as Record<string, unknown>;
    const absent = PROVENANCE_KEYS.filter((k) => !(k in prov));
    if (absent.length) findings.push({ level: "error", id, message: `provenance.json lacks ${absent.join(", ")}` });
  }
  const dist = path.join(WEB, "dist");
  if (!existsSync(MANIFEST_OUT) || !existsSync(path.join(dist, "index.html"))) {
    findings.push({ level: "error", id: "budget", message: "no atlas manifest or apps/web/dist: run `pnpm build` first" });
  } else {
    const manifest = JSON.parse(readFileSync(MANIFEST_OUT, "utf8")) as { scenes: Record<string, { files: Record<string, { bytes: { webp: number } }> }> };
    const worst = (s: string): number => manifest.scenes[s]?.files["3"]?.bytes.webp ?? 0;
    const r = measureBudget(dist, { town: worst("town"), battle: worst("battle") });
    findings.push(...r.findings);
    console.log(`art:check: budget town first load ${r.townBytes} B (limit 8000000), battle ${r.battleBytes} B more (limit 4000000); atlases at 3x WebP: town ${worst("town")} B, battle ${worst("battle")} B`);
  }
  const errors = findings.filter((f) => f.level === "error");
  for (const f of findings) console.log(`art:check: ${f.level.toUpperCase()} ${f.id}: ${f.message}`);
  console.log(`art:check: ${entries.length} assets, ${errors.length} error(s), ${findings.length - errors.length} warning(s)`);
  return errors.length ? 1 : 0;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "intake") await intake(rest);
  else if (cmd === "build") await build();
  else if (cmd === "check") process.exitCode = await check();
  else throw new Error("usage: art <intake|build|check>");
} catch (e) {
  console.error(`art: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
