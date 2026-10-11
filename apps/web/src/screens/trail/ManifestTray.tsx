/**
 * The manifest tray (chunk 08): what survives of what was packed, as the constraint it
 * is. Units at their REAL current HP (dead ones listed, marked, not draggable), traps
 * (spent ones listed, marked, not draggable; "fires once" said plainly), fence material
 * (remaining / on the ring / destroyed / packed; destroyed segments under their own
 * heading). Every draggable chip is also a 44px button: tap selects it, then a tap on the
 * ground (or the placement picker) places it — no drag required.
 *
 * A chip's accessible name is its content (QA N2): no aria-label that could fall behind
 * what is drawn. Chips scroll the page on a vertical swipe (`touch-action: pan-y`, QA B4);
 * the drag rules are trayGesture.ts's. A chip the server's last answer named is flagged.
 *
 * Memoised (QA S2): during a drag the screen re-renders every frame; the tray only when
 * the arrangement, the selection or the flags change.
 */
import { getFenceTier, getTrapType } from "@caravan/content";
import type { Formation, Manifest } from "@caravan/circle";
import { memo, type PointerEvent } from "react";
import { STRINGS } from "../../strings.ts";
import { AffinityIcon } from "../webs/AffinityIcon.tsx";
import { fenceBudget, nextFenceRef, segmentNumber, unplacedFences } from "./placement.ts";
import { defenderCard } from "./stats.ts";
import { StatPair } from "./ScoutPanel.tsx";

const T = STRINGS.trail;

export interface ManifestTrayProps {
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly selectedRef: string | null;
  readonly locked: boolean;
  /** Refs the server's last issue list named (QA S8). */
  readonly flagged: ReadonlySet<string>;
  readonly onPick: (ref: string) => void;
  readonly onDragStart: (ref: string, e: PointerEvent<HTMLButtonElement>) => void;
}

function Chip({
  itemRef,
  label,
  sub,
  disabled,
  selected,
  flagged,
  locked,
  testId,
  onPick,
  onDragStart,
  children,
}: {
  itemRef: string;
  label: string;
  sub: string;
  disabled: boolean;
  selected: boolean;
  flagged: boolean;
  locked: boolean;
  testId: string;
  onPick: (ref: string) => void;
  onDragStart: (ref: string, e: PointerEvent<HTMLButtonElement>) => void;
  children?: React.ReactNode;
}): JSX.Element {
  const inert = disabled || locked;
  return (
    <li className={`chip${disabled ? " chip--gone" : ""}${selected ? " chip--selected" : ""}${flagged ? " chip--issue" : ""}`} data-testid={testId} data-ref={itemRef}>
      <button
        type="button"
        className="chip__btn"
        aria-pressed={selected}
        aria-disabled={inert}
        onClick={() => !inert && onPick(itemRef)}
        onPointerDown={(e) => !inert && onDragStart(itemRef, e)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="chip__name">{label}</span>
        <span className="chip__sub">{sub}</span>
        {children}
      </button>
    </li>
  );
}

export const ManifestTray = memo(function ManifestTray({ manifest, formation, selectedRef, locked, flagged, onPick, onDragStart }: ManifestTrayProps): JSX.Element {
  const budget = fenceBudget(manifest, formation);
  const next = nextFenceRef(manifest, formation);
  const unplaced = unplacedFences(manifest, formation);
  const damaged = unplaced.filter((f) => f.hp < f.maxHp);
  const destroyed = manifest.fences.filter((f) => f.hp <= 0);
  const tierName = (tierId: string) => getFenceTier(tierId)?.displayName ?? T.unknownThing;
  const nextFence = next ? manifest.fences.find((f) => f.ref === next) : undefined;
  const common = { locked, onPick, onDragStart };
  return (
    <section className="tray" aria-labelledby="tray-heading" data-testid="manifest-tray">
      <h2 id="tray-heading">{T.trayHeading}</h2>
      <p className="hint">{T.trayIntro}</p>
      <p className="hint">{T.trayDragHint}</p>
      <p className="hint">{T.trayLongPress}</p>

      <h3 className="h3">{T.trayUnits}</h3>
      <ul className="chips">
        {manifest.units.map((u) => {
          const card = defenderCard(u);
          const post = formation.posts.find((p) => p.ref === u.ref);
          const dead = u.hp <= 0;
          const sub = dead ? T.unitDead : `${T.hpOf(u.hp, u.maxHp)} · ${T.mergeLevel(u.mergeLevel)} · ${post ? T.posted(post.cell.x, post.cell.y) : T.notPlaced}`;
          return (
            <Chip
              key={u.ref}
              {...common}
              itemRef={u.ref}
              label={card?.displayName ?? T.unknownThing}
              sub={sub}
              disabled={dead}
              selected={selectedRef === u.ref}
              flagged={flagged.has(u.ref)}
              testId={`tray-unit-${u.ref}`}
            >
              {card && (
                <span className="chip__extra">
                  <AffinityIcon affinity={card.affinity} />
                  <StatPair card={card} />
                </span>
              )}
            </Chip>
          );
        })}
      </ul>

      <h3 className="h3">{T.trayTraps}</h3>
      {manifest.traps.length === 0 ? (
        <p className="hint">—</p>
      ) : (
        <ul className="chips">
          {manifest.traps.map((t) => {
            const laid = formation.traps.find((p) => p.ref === t.ref);
            const sub = t.spent ? T.trapSpent : `${T.trapSingleUse} ${laid ? T.laid(laid.cell.x, laid.cell.y) : T.notPlaced}`;
            return (
              <Chip
                key={t.ref}
                {...common}
                itemRef={t.ref}
                label={getTrapType(t.typeId)?.displayName ?? T.unknownThing}
                sub={sub}
                disabled={t.spent}
                selected={selectedRef === t.ref}
                flagged={flagged.has(t.ref)}
                testId={`tray-trap-${t.ref}`}
              />
            );
          })}
        </ul>
      )}

      <h3 className="h3">{T.trayFence}</h3>
      <p data-testid="fence-tray-line">{T.fenceTray(budget.remaining, budget.placed, budget.destroyed, budget.packed)}</p>
      {nextFence && (
        <ul className="chips">
          <Chip
            {...common}
            itemRef={nextFence.ref}
            label={`${T.fenceNext}: ${tierName(nextFence.tierId)}`}
            sub={T.fenceSegment(segmentNumber(manifest, nextFence.ref), nextFence.hp, nextFence.maxHp)}
            disabled={false}
            selected={selectedRef === nextFence.ref}
            flagged={flagged.has(nextFence.ref)}
            testId="tray-fence-next"
          />
        </ul>
      )}
      {damaged.length > 0 && (
        <>
          <p className="hint">{T.fenceDamaged}</p>
          <ul className="chips">
            {damaged.map((f) => (
              <Chip
                key={f.ref}
                {...common}
                itemRef={f.ref}
                label={tierName(f.tierId)}
                sub={T.fenceSegment(segmentNumber(manifest, f.ref), f.hp, f.maxHp)}
                disabled={false}
                selected={selectedRef === f.ref}
                flagged={flagged.has(f.ref)}
                testId={`tray-fence-${f.ref}`}
              />
            ))}
          </ul>
        </>
      )}
      {destroyed.length > 0 && (
        <>
          <h3 className="h3" data-testid="fence-destroyed-heading">
            {T.fenceDestroyedHeading}
          </h3>
          <ul className="chips">
            {destroyed.map((f) => (
              <Chip
                key={f.ref}
                {...common}
                itemRef={f.ref}
                label={tierName(f.tierId)}
                sub={`${T.fenceSegment(segmentNumber(manifest, f.ref), f.hp, f.maxHp)} — ${T.fenceDestroyed}`}
                disabled
                selected={false}
                flagged={false}
                testId={`tray-fence-${f.ref}`}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
});
