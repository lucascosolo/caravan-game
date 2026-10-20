const fs = require("fs");
const dir = "/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/sf-review/shots/";
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("state"))) {
  const d = JSON.parse(fs.readFileSync(dir + f, "utf8"));
  if (!d.scrollH) continue;
  const prim = d.items.filter((i) => i.tag === "button").map((i) => i.y).sort((a, b) => b - a)[0];
  console.log(f.padEnd(34), String(d.scrollH).padStart(6), (d.scrollH / d.vh).toFixed(1).padStart(5) + " screens", d.items.filter((i) => i.tag === "button").length + " buttons");
}
