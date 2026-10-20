/**
 * The guided arrangement (chunk 24, PHASE-2 §24: "place this fence, leave this gap, post this
 * unit here, now scout why"), at every encounter of the guided trip (final play-test review
 * round 3). The rule lives in @caravan/circle's guideLayout.ts as pure functions, shared with the
 * balance harness so it models exactly the layout the guide's "do it for me" makes; this module
 * re-exports it for the onboarding UI. Every suggested drop is legal by circle's own
 * `validateFormation`, and the server re-validates the commit as for any other arrangement.
 */
export {
  GUIDE_POST_NEAR_GAP_CELLS,
  GUIDE_TRAP_NEAR_GAP_CELLS,
  applyMainFence,
  applyOpenGap,
  applyPosts,
  applyRestOfFence,
  applyTrap,
  arrangeStatus,
  gapSegment,
  guidedFormation,
  inwardFromGap,
  mainEdge,
  nearestLegalCell,
  raidersByEdge,
  sideSegments,
  type ArrangeStatus,
  type EdgeCount,
  type GuideScoutLike,
} from "@caravan/circle";
