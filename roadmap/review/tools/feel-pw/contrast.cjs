const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const L = (h) => {
  const [r, g, b] = hex(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// blend fg over bg at alpha
const mix = (fg, bg, a) => {
  const f = hex(fg), b = hex(bg);
  return "#" + f.map((c, i) => Math.round((c * a + b[i] * (1 - a)) * 255).toString(16).padStart(2, "0")).join("");
};
const pairs = [
  ["fg on bg", "#f1e9d6", "#1b1a17"],
  ["fg-muted on bg", "#b5ac98", "#1b1a17"],
  ["fg-muted on bg-raised (cards, hints)", "#b5ac98", "#27251f"],
  ["accent-fg on accent (primary button)", "#1b1a17", "#e69f00"],
  ["accent text on bg (active tab)", "#e69f00", "#1b1a17"],
  ["info text on bg-raised (GUIDE label)", "#56b4e9", "#27251f"],
  ["locked text on bg-raised", "#7a7468", "#27251f"],
  ["--line border on bg (button outline, 3:1 needed)", "#3f3b32", "#1b1a17"],
  ["--line border on bg-raised", "#3f3b32", "#27251f"],
  ["disabled btn text (fg @55%) on bg-raised", mix("#f1e9d6", "#27251f", 0.55), "#27251f"],
  ["disabled primary: accent-fg on accent@55% over bg", "#1b1a17", mix("#e69f00", "#1b1a17", 0.55)],
  ["canvas: defender blue on ground", "#56b4e9", "#b9a06b"],
  ["canvas: attacker vermillion on ground", "#d55e00", "#b9a06b"],
  ["canvas: glyph #1b1a17 on defender blue", "#1b1a17", "#56b4e9"],
  ["canvas: glyph #1b1a17 on attacker vermillion", "#1b1a17", "#d55e00"],
  ["canvas: core yellow on ground", "#f0e442", "#b9a06b"],
  ["canvas: hit line cream on ground", "#f1e9d6", "#b9a06b"],
  ["canvas: fence-break green on ground", "#009e73", "#b9a06b"],
  ["canvas: trap orange on ground", "#e69f00", "#b9a06b"],
  ["canvas: death X lattice cream on ground", "#f1e9d6", "#b9a06b"],
];
for (const [n, a, b] of pairs) console.log(ratio(a, b).toFixed(2).padStart(6), " ", n, a, b);
