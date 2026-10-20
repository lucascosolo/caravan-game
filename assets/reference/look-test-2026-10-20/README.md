# Look test, 2026-10-20

The in-house art reference for the pixel-art direction (`docs/art/STYLE-GUIDE.md`). These
sprites were hand-typed as pixel grids for an animated look test
(https://claude.ai/artifact/EGHs2F88GqNcDEN2xh3hgy), on which the owner picked small pixels,
an extra-bold outline that never touches ground tiles, warm-bright colour, and side marks as a
per-player setting that defaults to on.

- `sprites/*.json`: one file per sprite, `{name, w, h, anchor, frames: {anim: [rows]}}`. Each row is a string of palette keys; `.` is transparent, and `p`/`P` mark the side colour.
- `palette.json`: the UNGRADED colours the look test drew with. The graded warm-bright values are in the style guide, §4.
- `sheet.png`: the first frame of every sprite, side by side.
- `scene.png`: the look test with the owner's picks.

These are placeholders and a style reference, not shipped art.
