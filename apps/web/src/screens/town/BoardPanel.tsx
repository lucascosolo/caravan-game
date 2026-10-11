/**
 * The merge board as DOM (chunk 17): the list twin of the canvas — every unit on the board
 * with its cell, the overflow below it, and the merge groups with BOTH recipes. The canvas
 * is the drag surface; this is the tap surface, the screen-reader surface and the text
 * alternative when WebGL is unavailable. Neither one moves a unit on its own.
 *
 * The 5 → 3 recipe gets its own explicit button per group (it cannot be expressed by
 * dragging one unit onto one other). Quoted costs come from the server's cost table and
 * are display only: the preview the button opens is authoritative.
 */
import { getUnitType } from "@caravan/content";
import type { EconomyView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";
import { BOARD_SLOTS, MERGE_LEVEL_MAX, canMergeDrop, mergeGroups, overflow, pickForMerge, quotedCost, type BoardLayout, type RosterUnit } from "./board.ts";

const T = STRINGS.town;

export const unitName = (typeId: string): string => getUnitType(typeId)?.displayName ?? typeId;

export interface BoardPanelProps {
  readonly units: readonly RosterUnit[];
  readonly layout: BoardLayout;
  readonly selectedId: string | null;
  readonly merge: EconomyView["merge"] | null;
  /** Why merging is unavailable right now (on a trip), or null. */
  readonly mergeBlocked: string | null;
  /** Instances packed in the open manifest: never offered for merging. */
  readonly packedIds: ReadonlySet<string>;
  readonly onSelect: (id: string | null) => void;
  readonly onToBoard: (id: string) => void;
  readonly onToOverflow: (id: string) => void;
  /** Open the preview for these instance ids (drop target / first pick first). */
  readonly onMerge: (ids: readonly string[]) => void;
}

export function BoardPanel(props: BoardPanelProps): JSX.Element {
  const { units, layout, selectedId, merge, mergeBlocked, packedIds, onSelect, onToBoard, onToOverflow, onMerge } = props;
  const mergeable = units.filter((u) => !packedIds.has(u.id));
  const onBoardUnits = units
    .filter((u) => layout.has(u.id))
    .sort((a, b) => {
      const ca = layout.get(a.id)!;
      const cb = layout.get(b.id)!;
      return ca.y - cb.y || ca.x - cb.x;
    });
  const over = overflow(units, layout);
  const selected = selectedId ? units.find((u) => u.id === selectedId) : undefined;

  const tap = (id: string): void => {
    if (selectedId && selectedId !== id && !mergeBlocked && !packedIds.has(id) && !packedIds.has(selectedId) && canMergeDrop(units, selectedId, id)) {
      onMerge([id, selectedId]);
      return;
    }
    onSelect(selectedId === id ? null : id);
  };

  const chip = (u: RosterUnit, where: string): JSX.Element => (
    <li key={u.id} className={`chip${selectedId === u.id ? " chip--selected" : ""}`} data-unit={u.id} data-type={u.typeId} data-level={u.mergeLevel}>
      <button type="button" className="chip__btn" style={{ cursor: "pointer", touchAction: "pan-y" }} aria-pressed={selectedId === u.id} onClick={() => tap(u.id)}>
        <span className="chip__name">{T.unitChip(unitName(u.typeId), u.mergeLevel)}</span>
        <span className="chip__sub">
          {where}
          {packedIds.has(u.id) ? ` · ${T.packedTag}` : ""}
        </span>
      </button>
    </li>
  );

  return (
    <section aria-labelledby="board-heading" data-testid="board-panel">
      <h2 id="board-heading" tabIndex={-1}>{T.boardHeading}</h2>
      <p className="hint">{T.boardIntro(BOARD_SLOTS)}</p>
      <p data-testid="board-count">{T.boardCount(onBoardUnits.length, BOARD_SLOTS, over.length)}</p>
      {units.length === 0 && <p className="hint">{T.boardEmpty}</p>}
      <p className="hint">{T.dragHint}</p>
      {selected && (
        <div className="selection" data-testid="board-selection">
          <p style={{ marginTop: 0 }}>{T.selectedUnit(unitName(selected.typeId))}</p>
          <div className="row">
            {layout.has(selected.id) ? (
              <button type="button" className="btn" onClick={() => onToOverflow(selected.id)}>
                {T.toOverflow}
              </button>
            ) : (
              <button type="button" className="btn" disabled={layout.size >= BOARD_SLOTS} onClick={() => onToBoard(selected.id)}>
                {T.toBoard}
              </button>
            )}
            <button type="button" className="btn" onClick={() => onSelect(null)}>
              {T.deselect}
            </button>
          </div>
        </div>
      )}
      <ul className="chips" data-testid="board-units">
        {onBoardUnits.map((u) => {
          const c = layout.get(u.id)!;
          return chip(u, T.onBoardAt(c.x, c.y));
        })}
      </ul>
      {over.length > 0 && (
        <>
          <div className="h3">{T.overflowHeading}</div>
          <p className="hint">{T.overflowIntro}</p>
          <ul className="chips" data-testid="overflow-units">
            {over.map((u) => chip(u, T.inOverflow))}
          </ul>
        </>
      )}

      <h2>{T.mergeHeading}</h2>
      <p className="hint">{T.mergeIntro}</p>
      {mergeBlocked && (
        <p className="notice" data-testid="merge-blocked">
          {mergeBlocked}
        </p>
      )}
      <ul className="cards" data-testid="merge-groups">
        {mergeGroups(mergeable).map((g) => {
          const atCap = g.mergeLevel >= MERGE_LEVEL_MAX;
          const recipes = merge?.recipes ?? [];
          return (
            <li key={`${g.typeId}@${g.mergeLevel}`} className="card" data-type={g.typeId} data-level={g.mergeLevel}>
              <div className="card__name">{T.mergeGroup(unitName(g.typeId), g.mergeLevel, g.ids.length)}</div>
              {atCap ? (
                <p className="hint">{T.mergeAtCap}</p>
              ) : (
                recipes.map((r) => {
                  const ids = pickForMerge(g, r.spend, selectedId ? [selectedId] : []);
                  const cost = merge ? quotedCost(merge.costPerResultingUnitByLevel, g.mergeLevel + 1, r.produce) : null;
                  return (
                    <div key={`${r.spend}-${r.produce}`}>
                      <button
                        type="button"
                        className="btn btn--block"
                        style={{ marginTop: "0.375rem" }}
                        disabled={ids === null || mergeBlocked !== null}
                        onClick={() => ids && onMerge(ids)}
                        data-testid={`merge-${r.spend}-${r.produce}`}
                      >
                        {T.mergeRecipe(r.spend, r.produce, cost)}
                      </button>
                      {ids === null && <div className="hint">{T.mergeNeedMore(g.ids.length, r.spend)}</div>}
                    </div>
                  );
                })
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
