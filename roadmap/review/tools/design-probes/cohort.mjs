// Studio review cohort driver: simulated days of play for several API players on the hosted server.
// Each simulated day = SESSIONS sessions. Before each session, ONLY the time caps are aged:
// the trip cap by 1 h (3 trips back) and the refugee timer by 1.5 h (one free menu). The mine and
// the ledger are never aged. Every aging is logged with its wall-clock time.
//   node cohort.mjs <fromDay> <toDay>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
const DIR = process.env.STUDIO_DIR ?? "./studio-out";
const OWNER = `postgres://caravan_sdes_owner:${fs.readFileSync(`${DIR}/owner.pw`, "utf8").trim()}@localhost:5432/caravan_studio_design`;
const SERVER = new URL("../../../../apps/server", import.meta.url).pathname;
const PLAYERS = process.env.PLAYERS ? JSON.parse(process.env.PLAYERS) : [
  { user: "sd_guide1", region: "desert", persona: "guide", sessions: 3 },
  { user: "sd_guide2", region: "high_plains", persona: "guide", sessions: 3 },
  { user: "sd_solver1", region: "mountain", persona: "solver", sessions: 3 },
  { user: "sd_solver2", region: "badlands", persona: "solver", sessions: 3 },
  { user: "sd_naive1", region: "high_plains", persona: "naive", sessions: 1 },
  { user: "sd_design1", region: "desert", persona: "designer", sessions: 3 },
  { user: "sd_design2", region: "badlands", persona: "designer", sessions: 2 },
];
const [, , from = "1", to = "1"] = process.argv;
const ageLog = `${DIR}/logs/aging.log`;
function age(user, caph, refh) {
  const out = execFileSync("psql", [OWNER, "-v", `caph=${caph}`, "-v", `refh=${refh}`, "-v", `u=${user}`, "-At", "-f", `${DIR}/age.sql`], { encoding: "utf8" });
  fs.appendFileSync(ageLog, `${new Date().toISOString()} aged ${user}: trip cap -${caph} h, refugee timer -${refh} h (${out.trim().split("\n").pop()})\n`);
}
function runBot(p, day) {
  return new Promise((res) => {
    const c = spawn("pnpm", ["exec", "tsx", `${DIR}/bot.mts`, "--user", p.user, "--region", p.region, "--persona", p.persona, "--trips", "3", "--day", String(day), "--smart", p.smart ? "1" : "0"], { cwd: SERVER, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => { if (code) fs.appendFileSync(`${DIR}/logs/cohort.err`, `${p.user} day ${day}: exit ${code}\n${err.slice(-1500)}\n`); res(); });
  });
}
for (let day = Number(from); day <= Number(to); day++) {
  for (let s = 0; s < 3; s++) {
    const active = PLAYERS.filter((p) => s < p.sessions);
    for (const p of active) { try { age(p.user, 1, 1.5); } catch (e) { /* account not registered yet */ } }
    fs.appendFileSync(`${DIR}/logs/cohort.log`, `${new Date().toISOString()} day ${day} session ${s + 1}: ${active.map((p) => p.user).join(", ")}\n`);
    await Promise.all(active.map((p) => runBot(p, day)));
  }
  fs.appendFileSync(`${DIR}/logs/cohort.log`, `${new Date().toISOString()} day ${day} done\n`);
}
