/**
 * The DOM placement picker (chunk 08 QA D3; PHASE-2 §35): the keyboard and screen-reader
 * path to every target the canvas offers. For the selected tray item it lists where it can
 * go, grouped by the side of the circle each place faces, with @caravan/circle's refusal
 * (and code) on any ring position that is taken. A fence chooses among the ring
 * positions; a trap or post among every legal cell. "Place here" does exactly what a drop
 * on that cell does (the same `dropAt`).
 */
import { ENTRY_EDGES, type Cell, type Formation, type Manifest } from "@caravan/circle";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { STRINGS } from "../../strings.ts";
import { pickerOptions } from "./placement.ts";

const T = STRINGS.trail;

export interface PlacementPickerProps {
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly itemRef: string;
  readonly name: string;
  readonly onPlace: (cell: Cell) => void;
}

const key = (c: Cell): string => `${c.x},${c.y}`;

export const PlacementPicker = memo(function PlacementPicker({ manifest, formation, itemRef, name, onPlace }: PlacementPickerProps): JSX.Element {
  const id = useId();
  const options = useMemo(() => pickerOptions(manifest, formation, itemRef), [manifest, formation, itemRef]);
  const [choice, setChoice] = useState("");
  const all = [...options.values()].flat();
  const isFence = all.some((o) => o.segment !== null);
  const chosen = all.find((o) => key(o.cell) === choice && o.refusal === null) ?? null;
  // Final play-test review r3 N8: after "Place here" the selection moves on and the panels above
  // the picker change height, so the page used to jump by hundreds of pixels under the thumb.
  // Keep the picker where it was on screen: measure before the placement, correct after layout.
  const sectionRef = useRef<HTMLElement>(null);
  const pendingTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const before = pendingTop.current;
    pendingTop.current = null;
    if (before === null || !sectionRef.current) return;
    const delta = sectionRef.current.getBoundingClientRect().top - before;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  });
  return (
    <section className="picker" ref={sectionRef} aria-labelledby={`${id}-h`} data-testid="placement-picker">
      <h3 className="h3" id={`${id}-h`}>
        {T.pickerHeading(name)}
      </h3>
      <p className="hint">{T.pickerIntro}</p>
      {!isFence && <p className="hint">{T.pickerReserved}</p>}
      <div className="row">
        <select className="picker__select" aria-labelledby={`${id}-h`} value={choice} onChange={(e) => setChoice(e.target.value)} data-testid="picker-select">
          <option value="">{T.pickerChoose}</option>
          {ENTRY_EDGES.map((edge) => {
            const list = (options.get(edge) ?? []).filter((o) => isFence || o.refusal === null);
            if (list.length === 0) return null;
            return (
              <optgroup key={edge} label={T.pickerSide(T.edgeName(edge), list.filter((o) => o.refusal === null).length)}>
                {list.map((o) => (
                  <option key={key(o.cell)} value={key(o.cell)} disabled={o.refusal !== null}>
                    {o.segment !== null ? T.pickerRing(o.segment, o.cell.x, o.cell.y) : T.pickerCell(o.cell.x, o.cell.y)}
                    {o.refusal ? ` — ${o.refusal.message}` : ""}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <button
          type="button"
          className="btn"
          disabled={!chosen}
          onClick={() => {
            if (!chosen) return;
            pendingTop.current = sectionRef.current?.getBoundingClientRect().top ?? null;
            onPlace(chosen.cell);
            setChoice("");
          }}
          data-testid="picker-place"
        >
          {T.pickerPlace}
        </button>
      </div>
    </section>
  );
});
