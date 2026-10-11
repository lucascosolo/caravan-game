/**
 * Every player-facing string in the client (PHASE-2 §35: nothing lives in a component).
 * English only at launch; the shape is a flat module so a locale table can replace it
 * without touching screens. Functions take the numbers they interpolate.
 *
 * Copy rule for the unlock web (chunk 06): a node grants ACCESS to recruit or deploy a type.
 * It never gives the player an instance. Any string that could read as "you get a unit"
 * is a legibility failure — keep "access" in the sentence.
 */
import type { UnlockPool } from "./api/types.ts";

/** What a node grants, for the kind-aware copy. Mirrors catalogue.ts's GrantKind. */
export type GrantKindKey = "unit" | "trap" | "fence" | "siege";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const STRINGS = {
  app: {
    title: "Caravan Vaults",
    loading: "Loading…",
    retry: "Retry",
    signOut: "Sign out",
    genericError: "Something went wrong.",
    networkError: "Could not reach the server.",
    badPayload: "The server's answer could not be read. Nothing was changed.",
    renderError: "This screen hit a problem and could not be drawn. Nothing was changed.",
  },
  tabs: {
    town: "Town",
    trail: "Trail",
    party: "Party",
    webs: "Webs",
  },
  placeholder: {
    town: "The home town: roster, merge board and the mine. Built in chunk 17.",
    trail: "The trail: scout each party and arrange your wagon circle. Built in chunk 08.",
    party: "Your standing raid party, served into other players' trips. Built in chunk 09.",
  },
  auth: {
    signIn: "Sign in",
    register: "Start a caravan",
    username: "Username",
    password: "Password",
    region: "Region",
    caravanName: "Caravan name (optional)",
    submitSignIn: "Sign in",
    submitRegister: "Create account",
    switchToRegister: "New here? Start a caravan",
    switchToSignIn: "Have an account? Sign in",
    regionHint: "Chosen once per caravan and never swapped. It decides which living units your caravan can ever unlock.",
    working: "Working…",
  },
  webs: {
    title: "Unlock webs",
    intro: "Spend ladder points to open access to new types. Unlocking a node lets you recruit or deploy that type; it does not give you one.",
    poolName: (pool: UnlockPool): string => ({ living: "Living units", trap: "Traps & fences", siege: "Siege" })[pool],
    scopeAccount: "Account-level: shared by every caravan you will ever run.",
    scopeCaravan: (region: string, caravan: string): string => `Caravan-level, ${region} only: belongs to “${caravan}” and does not transfer to another caravan.`,
    points: "Unlock points",
    lblAvailable: "available",
    lblGranted: "granted",
    lblSpent: "spent",
    ladderLine: (level: number, cap: number): string => `Ladder rung ${level} of ${cap}`,
    nextRung: (toGo: number, grants: number): string => `${plural(toGo, "ladder point")} to the next rung, which grants ${plural(grants, "unlock point")}.`,
    ladderCapped: "Ladder capped: every unlock point this pool will ever grant has been granted.",
    tier: (t: number): string => `Tier ${t}`,
    costFree: "Free · starting node",
    cost: (n: number): string => plural(n, "pt"),
    requires: "Requires",
    requiresNone: "No prerequisites",
    stateReached: "Reached",
    stateAffordable: "Affordable",
    stateLocked: "Locked",
    /** The server's `missing` list, by name. */
    lockedMissing: (names: string): string => `Needs ${names} first`,
    /** The server said not affordable and nothing is missing: it is the points. No arithmetic here (QA-06 S7). */
    lockedPoints: "Not enough points yet",
    accessNote: "Reaching this node grants access to recruit or deploy this type. It does not give you one.",
    accessGranted: (kind: GrantKindKey): string =>
      ({
        unit: "You have access to this unit type. Recruit it in town; this node gives no instance.",
        trap: "You have access to this trap. Deploy it from the wagon-circle editor; this node gives no instance.",
        fence: "You have access to this fence tier. Deploy it from the wagon-circle editor; this node gives no instance.",
        siege: "You have access to this siege piece. Add it to your party; this node gives no instance.",
      })[kind],
    unlockButton: (name: string, cost: number): string => `Unlock access to ${name} for ${plural(cost, "pt")}`,
    confirmTitle: "Confirm unlock",
    /** Cost and balance are the server's numbers from the fresh re-fetch; the remainder is quoted after the spend, from the server's answer. */
    confirmBody: (name: string, cost: number, available: number): string => `Spend ${cost} of ${available} unlock points for access to ${name}? Points are never refunded.`,
    confirmYes: "Spend points",
    confirmNo: "Cancel",
    spending: "Spending…",
    checking: "Checking…",
    spendFailed: "The server refused this unlock:",
    spendDone: (name: string, remaining: number): string => `Access to ${name} unlocked. ${plural(remaining, "unlock point")} remain.`,
    /** The re-fetch before the confirm found the node no longer affordable. */
    spendStale: (name: string): string => `${name} is no longer affordable; the web was refreshed.`,
    close: "Close",
    detailsFor: (name: string): string => `${name} — details`,
    statsHeading: "Stats",
    grantsHeading: "Grants access to",
    kindUnit: "Living unit",
    kindTrap: "Trap",
    kindFence: "Fence tier",
    kindSiege: "Siege piece",
    affinity: "Affinity",
    affinityName: (a: string): string => ({ grit: "Grit", powder: "Powder", beast: "Beast" })[a] ?? a,
    stat: {
      offense: "Offense",
      defense: "Defense",
      hp: "HP",
      moveSpeed: "Speed (cells/s)",
      attackRange: "Range (cells)",
      attackCooldown: "Attack every",
      aggroRadius: "Notices at (cells)",
      leashDistance: "Chases up to (cells)",
      ability: "Ability",
      cooldown: "Cooldown",
      damage: "Damage",
      effect: "Effect",
      effectNone: "None",
      effectRoot: (duration: string): string => `Root for ${duration}`,
      effectSlow: (magnitude: string, duration: string): string => `Slow ×${magnitude} for ${duration}`,
      category: "Category",
      segmentHp: "Segment HP",
      counters: "Counters",
      countersValue: (category: string, kind: string): string => `${category} ${kind}s`,
      fenceTier: "Fence tier",
      charges: "Charges per battle",
      radius: "Radius (cells)",
      oneHit: (mult: string): string => `×${mult} one hit`,
      heals: "Heals",
      healsValue: (percent: string): string => `${percent}% of max HP`,
      bonusDamage: "Bonus damage",
      bonusValue: (bonus: string): string => `+${bonus}`,
      duration: "Duration",
      distance: "Distance (cells)",
      fenceDamage: "Fence damage",
    },
    seconds: (s: string): string => `${s} s`,
    graphLabel: (pool: string): string => `${pool} unlock web`,
    noCaravan: "No caravan yet.",
    fetchFailed: "Could not load the unlock webs.",
  },
} as const;
