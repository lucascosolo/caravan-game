// Word count of the guide's string literals (template literals included, ${} counted as one word).
const fs = require("fs");
const src = fs.readFileSync("/home/user/caravan-game/.claude/worktrees/agent-a0a750c9427565bad/apps/web/src/strings.ts", "utf8").split("\n");
const block = src.slice(1385, 1550).join("\n");
const lits = [...block.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2]);
const words = lits.map((s) => s.replace(/\$\{[^}]*\}/g, "X")).join(" ").split(/\s+/).filter(Boolean).length;
console.log("guide string literals:", lits.length, "words:", words);
const all = src.join("\n");
const allLits = [...all.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2]);
console.log("all string literals in strings.ts words:", allLits.join(" ").split(/\s+/).filter(Boolean).length);
