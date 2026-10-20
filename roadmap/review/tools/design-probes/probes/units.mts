import { LIVING_UNIT_TYPES, CONTENT, unlockWebFor } from "../../../../../packages/content/src/index.js";
const rows = LIVING_UNIT_TYPES.map((t) => {
  const web = unlockWebFor("living", t.regionId);
  const n = web.nodes.find((x) => x.id === t.id)!;
  const cd = t.attackCooldown / 1000;
  return { id: t.id, tier: n.tier, off: t.offense, def: t.defense, hp: t.hp, spd: (t.moveSpeed / 1024).toFixed(2), rng: (t.attackRange / 1024).toFixed(1), cd, arch: t.ability.archetype, aff: t.affinity };
});
console.table(rows);
console.log(CONTENT.traps.map((t) => JSON.stringify(t)).join("\n"));
console.log(CONTENT.fences.map((f) => JSON.stringify(f)).join("\n"));
console.log(CONTENT.siege.map((s) => JSON.stringify(s)).join("\n"));
