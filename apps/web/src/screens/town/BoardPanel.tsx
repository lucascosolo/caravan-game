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
import { Button } from "../../ui/Button.tsx";
import { Note } from "../../ui/Note.tsx";
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
    <li key={u.id} data-unit={u.id} data-type={u.typeId} data-level={u.mergeLevel}>
      <button type="button" className={`cv-card town-unit${selectedId === u.id ? " is-selected" : ""}`} aria-pressed={selectedId === u.id} onClick={() => tap(u.id)}>
        <span className="town-name">{T.unitChip(unitName(u.typeId), u.mergeLevel)}</span>
        <span className="cv-small">
          {where}
          {packedIds.has(u.id) ? ` · ${T.packedTag}` : ""}
        </span>
      </button>
    </li>
  );

  return (
    <section className="town-panel" aria-labelledby="board-heading" data-testid="board-panel">
      <h2 id="board-heading" tabIndex={-1}>{T.boardHeading}</h2>
      <p className="cv-small">{T.boardIntro(BOARD_SLOTS)}</p>
      <p data-testid="board-count">{T.boardCount(onBoardUnits.length, BOARD_SLOTS, over.length)}</p>
      {units.length === 0 && <p className="cv-small">{T.boardEmpty}</p>}
      <p className="cv-small">{T.dragHint}</p>
      {selected && (
        <div className="cv-card town-sel" data-testid="board-selection">
          <p>{T.selectedUnit(unitName(selected.typeId))}</p>
          <div className="town-actions">
            {layout.has(selected.id) ? (
              <Button onClick={() => onToOverflow(selected.id)}>{T.toOverflow}</Button>
            ) : (
              <Button disabled={layout.size >= BOARD_SLOTS} onClick={() => onToBoard(selected.id)}>
                {T.toBoard}
              </Button>
            )}
            <Button onClick={() => onSelect(null)}>{T.deselect}</Button>
          </div>
        </div>
      )}
      <ul className="town-list" data-testid="board-units">
        {onBoardUnits.map((u) => {
          const c = layout.get(u.id)!;
          return chip(u, T.onBoardAt(c.x, c.y));
        })}
      </ul>
      {over.length > 0 && (
        <>
          <div className="town-name">{T.overflowHeading}</div>
          <p className="cv-small">{T.overflowIntro}</p>
          <ul className="town-list" data-testid="overflow-units">
            {over.map((u) => chip(u, T.inOverflow))}
          </ul>
        </>
      )}

      <h2>{T.mergeHeading}</h2>
      <p className="cv-small">{T.mergeIntro}</p>
      {mergeBlocked && (
        <Note variant="canvas" testId="merge-blocked">
          {mergeBlocked}
        </Note>
      )}
      <ul className="town-list" data-testid="merge-groups">
        {mergeGroups(mergeable).map((g) => {
          const atCap = g.mergeLevel >= MERGE_LEVEL_MAX;
          const recipes = merge?.recipes ?? [];
          return (
            <li key={`${g.typeId}@${g.mergeLevel}`} className="cv-card town-panel" data-type={g.typeId} data-level={g.mergeLevel}>
              <div className="town-name">{T.mergeGroup(unitName(g.typeId), g.mergeLevel, g.ids.length)}</div>
              {atCap ? (
                <p className="cv-small">{T.mergeAtCap}</p>
              ) : (
                recipes.map((r) => {
                  const ids = pickForMerge(g, r.spend, selectedId ? [selectedId] : []);
                  const cost = merge ? quotedCost(merge.costPerResultingUnitByLevel, g.mergeLevel + 1, r.produce) : null;
                  return (
                    <div key={`${r.spend}-${r.produce}`}>
                      <Button
                        block
                        icon="coin"
                        disabled={ids === null || mergeBlocked !== null}
                        disabledReason={ids === null ? T.mergeNeedMore(g.ids.length, r.spend) : undefined}
                        onClick={() => ids && onMerge(ids)}
                        testId={`merge-${r.spend}-${r.produce}`}
                      >
                        {T.mergeRecipe(r.spend, r.produce, cost)}
                      </Button>
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
