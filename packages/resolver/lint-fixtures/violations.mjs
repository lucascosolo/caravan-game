// Proves the isolation rules apply to .mjs/.js inside src, not only .ts (QA 01 #8).
export const leak = Math.random();
