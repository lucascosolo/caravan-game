/**
 * The shared isometric renderer (chunk 08). Import from here, never from the files:
 *   - projection.ts — pure 2:1 projection, depth order, lattice snap, camera math;
 *   - hit.ts        — pure hit testing over a scene state;
 *   - skins.ts      — the skin seam (placeholder registry now, sprites in chunk 26);
 *   - scene.ts      — the PixiJS scene: island, lattice (drag-only), entities, overlays;
 *   - IsoCanvas.tsx — the React wrapper: pointer gestures, camera, resize.
 * Chunks 17 (town) and 22 (replay) reuse these; they never build a second renderer.
 */
export * from "./projection.ts";
export * from "./hit.ts";
export * from "./skins.ts";
export { ART_MANIFEST, atlasDpr, loadSceneSkins, type ArtManifest, type ArtScene } from "./art.ts";
export { drawSprite } from "./spriteDraw.ts";
export * from "./types.ts";
export { IsoScene, LATTICE_ALPHA, type SceneGeometry, type SceneOptions } from "./scene.ts";
export { IsoCanvas, ISO_DEBUG, frameCamera, type FrameRect, type IsoCanvasHandle, type IsoCanvasProps } from "./IsoCanvas.tsx";
export * from "./gestures.ts";
