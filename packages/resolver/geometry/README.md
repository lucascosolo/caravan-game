# Ring geometry fixture

`round-ring.json` is the owner-approved round wagon circle (chunk 50), copied byte for byte from
`~/.cache/caravan/looktest/round-ring.json`, the data behind the look-test mock-up
https://claude.ai/artifact/EGHs2F88GqNcDEN2xh3hgy, approved by the owner in the session of
2026-10-20 (roadmap/chunks/50-round-wagon-circle.md, "Owner decisions"). It was produced by
`ring_check.py` in the same folder; `test/ring-geometry.test.ts` ports that script's closure checks.

Coordinates are look-test cells (`i` = x, `j` = y) with the core centre at (5, 5). The game maps
that onto `CORE_CENTER_CELL` = (15, 15), an offset of (+10, +10). The file's own note says
"add (11, 11) … core centre (16, 16)", which does not match this lattice: its 3 × 3 core block is
cells 14..16 (`CORE_ORIGIN` = trunc((32 − 3) / 2) = 14), so +11 would put the ring off-centre
around the core. The tests derive the offset from `CORE_CENTER_CELL` and check that the
fixture's core cells land exactly on `CORE_CELLS`.

The resolver never reads this file: `battlefield.ts` embeds the ring as constants and
`test/ring-geometry.test.ts` checks them against it. Never edit a cell here or there by hand; a
geometry change is a new approved fixture, a `BATTLEFIELD_VERSION` and a `RESOLVER_VERSION` bump.
