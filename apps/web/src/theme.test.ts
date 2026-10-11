/**
 * Chunk 24 QA S1: a merge once left `.inbox-actions {` unclosed in theme.css, so every rule after
 * it (the whole guide block) parsed as NESTED inside it and matched nothing — the guide cards lost
 * their dashed border, the one marker that is not colour alone. Vite's build did not complain.
 * These checks would have caught it:
 *  - the stylesheet's braces balance (comments and strings skipped) and never go negative;
 *  - every style rule sits at the top level or directly in an at-rule (@media / @supports …), never
 *    inside another style rule (this sheet does not use CSS nesting on purpose);
 *  - the guide's rules exist at the top level, and applying the sheet in the DOM gives a guide
 *    card a dashed border.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "theme.css"), "utf8");

interface Block {
  readonly prelude: string;
  readonly depth: number;
  readonly parent: string | null;
  readonly line: number;
}

/** Every `{`-opened block with its prelude and enclosing block. Throws on an unbalanced sheet. */
function cssBlocks(css: string): Block[] {
  const out: Block[] = [];
  const stack: Block[] = [];
  let prelude = "";
  let line = 1;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (ch === "\n") line++;
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`unterminated comment at line ${line}`);
      line += (css.slice(i, end).match(/\n/g) ?? []).length;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = css.indexOf(ch, i + 1);
      if (end < 0) throw new Error(`unterminated string at line ${line}`);
      prelude += css.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "{") {
      const b: Block = { prelude: prelude.trim(), depth: stack.length, parent: stack.at(-1)?.prelude ?? null, line };
      out.push(b);
      stack.push(b);
      prelude = "";
    } else if (ch === "}") {
      if (!stack.pop()) throw new Error(`unmatched '}' at line ${line}`);
      prelude = "";
    } else if (ch === ";") {
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  if (stack.length) throw new Error(`unclosed block(s): ${stack.map((b) => `'${b.prelude}' (line ${b.line})`).join(", ")}`);
  return out;
}

const isAtRule = (p: string | null): boolean => p !== null && p.startsWith("@");

describe("theme.css parses as intended (chunk 24 QA S1)", () => {
  it("balances its braces", () => {
    expect(() => cssBlocks(CSS)).not.toThrow();
    expect(() => cssBlocks(".a { color: red;\n.b { color: blue; }")).toThrow(/unclosed/);
  });

  it("nests no style rule inside another style rule", () => {
    // A block whose parent is a style rule (not an at-rule such as @media or @keyframes).
    const nested = cssBlocks(CSS).filter((b) => b.parent !== null && !isAtRule(b.parent) && !isAtRule(b.prelude));
    expect(nested.map((b) => `${b.prelude} inside ${b.parent} (line ${b.line})`)).toEqual([]);
    // The S1 shape is caught: an unclosed rule followed by a closing brace later reads as nesting.
    const s1 = cssBlocks(".inbox-actions { display: flex;\n.guide { border: 2px dashed; }\n}");
    expect(s1.filter((b) => b.parent === ".inbox-actions")).toHaveLength(1);
  });

  it("the guide's rules are top-level, and a guide card gets its dashed border", () => {
    const top = new Set(cssBlocks(CSS).filter((b) => b.depth === 0).map((b) => b.prelude));
    for (const sel of [".guide", ".guide__label", ".guide__list", ".guide__mark"]) expect([...top].some((p) => p.split(",").map((s) => s.trim()).includes(sel)), sel).toBe(true);
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const card = document.createElement("aside");
    card.className = "guide";
    document.body.appendChild(card);
    try {
      // The browser-side parse (jsdom's CSSOM) has `.guide` as a top-level rule that matches a
      // guide card and carries the dashed border (jsdom resolves no var(), so read the rule itself).
      const rules = [...style.sheet!.cssRules].filter((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === ".guide");
      expect(rules.length).toBeGreaterThan(0);
      expect(card.matches(rules[0]!.selectorText)).toBe(true);
      expect(rules.map((r) => r.style.cssText).join(" ")).toMatch(/dashed/);
    } finally {
      card.remove();
      style.remove();
    }
  });
});
