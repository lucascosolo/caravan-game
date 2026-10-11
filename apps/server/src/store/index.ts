/**
 * The store (chunk 20): weekly packs, sandboxed purchase, cosmetic ownership and equip.
 * Account-level throughout; nothing here is reachable from resolution, matchmaking or
 * acquisition (tests: store-guards.test.ts, scripts/resolver-boundary-check.mjs).
 */
export * from "./offers.js";
export * from "./purchase.js";
export * from "./cosmetics.js";
export { SANDBOX_BACKEND_NAME, SANDBOX_PURCHASE_BACKEND, type PurchaseBackend, type ChargeReceipt } from "./sandbox.js";
