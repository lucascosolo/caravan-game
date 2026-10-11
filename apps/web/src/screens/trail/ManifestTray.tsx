/**
 * The manifest tray (chunk 08): what survives of what was packed, as the constraint it
 * is. Units at their REAL current HP (dead ones listed, marked, not draggable), traps
 * (spent ones listed, marked, not draggable; "fires once" said plainly), fence material
 * (remaining / on the ring / destroyed / packed). Every draggable chip is also a 44px
 * button: tap selects it, then a tap on the ground places it — no drag required.
 *
 * Drag starts here with a pointer event and is reported up; the screen converts pointer
 * positions to cells through the canvas and owns the drop.
 */
import { getFenceTier, getTrapType } from "@caravan/content";
import type { Formation, Manifest } from "@caravan/circle";
import type { PointerEvent } from "react";
import { STRINGS } from "../../strings.ts";
import { AffinityIcon } from "../webs/AffinityIcon.tsx";
import { fenceBudget, nextFenceRef, unplacedFences } from "./placement.ts";
import { defenderCard } from "./stats.ts";
import { StatPair } from "./ScoutPanel.tsx";

const T = STRINGS.trail;

export interface ManifestTrayProps {
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly selectedRef: string | null;
  readonly locked: boolean;
  readonly onPick: (ref: string) => void;
  readonly onDragStart: (ref: string, e: PointerEvent<HTMLButtonElement>) => void;
}

function Chip({
  itemRef,
  label,
  sub,
  disabled,
  selected,
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
  locked: boolean;
  testId: string;
  onPick: (ref: string) => void;
  onDragStart: (ref: string, e: PointerEvent<HTMLButtonElement>) => void;
  children?: React.ReactNode;
}): JSX.Element {
  const inert = disabled || locked;
  return (
    <li className={`chip${disabled ? " chip--gone" : ""}${selected ? " chip--selected" : ""}`} data-testid={testId}>
      <button
        type="button"
        className="chip__btn"
        aria-pressed={selected}
        aria-disabled={inert}
        aria-label={`${label}, ${sub}`}
        onClick={() => !inert && onPick(itemRef)}
        onPointerDown={(e) => !inert && onDragStart(itemRef, e)}
      >
        <span className="chip__name">{label}</span>
        <span className="chip__sub">{sub}</span>
        {children}
      </button>
    </li>
  );
}

export function ManifestTray({ manifest, formation, selectedRef, locked, onPick, onDragStart }: ManifestTrayProps): JSX.Element {
  const budget = fenceBudget(manifest, formation);
  const next = nextFenceRef(manifest, formation);
  const unplaced = unplacedFences(manifest, formation);
  const damaged = unplaced.filter((f) => f.hp < f.maxHp);
  const destroyed = manifest.fences.filter((f) => f.hp <= 0);
  const tierName = (tierId: string) => getFenceTier(tierId)?.displayName ?? tierId;
  const nextFence = next ? manifest.fences.find((f) => f.ref === next) : undefined;
  return (
    <section className="tray" aria-labelledby="tray-heading" data-testid="manifest-tray">
      <h2 id="tray-heading">{T.trayHeading}</h2>
      <p className="hint">{T.trayIntro}</p>
      <p className="hint">{T.trayDragHint}</p>

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
              itemRef={u.ref}
              label={card?.displayName ?? u.typeId}
              sub={sub}
              disabled={dead}
              selected={selectedRef === u.ref}
              locked={locked}
              testId={`tray-unit-${u.ref}`}
              onPick={onPick}
              onDragStart={onDragStart}
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
                itemRef={t.ref}
                label={getTrapType(t.typeId)?.displayName ?? t.typeId}
                sub={sub}
                disabled={t.spent}
                selected={selectedRef === t.ref}
                locked={locked}
                testId={`tray-trap-${t.ref}`}
                onPick={onPick}
                onDragStart={onDragStart}
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
            itemRef={nextFence.ref}
            label={`${T.fenceNext}: ${tierName(nextFence.tierId)}`}
            sub={T.fenceSegment(nextFence.ref, nextFence.hp, nextFence.maxHp)}
            disabled={false}
            selected={selectedRef === nextFence.ref}
            locked={locked}
            testId="tray-fence-next"
            onPick={onPick}
            onDragStart={onDragStart}
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
                itemRef={f.ref}
                label={tierName(f.tierId)}
                sub={T.fenceSegment(f.ref, f.hp, f.maxHp)}
                disabled={false}
                selected={selectedRef === f.ref}
                locked={locked}
                testId={`tray-fence-${f.ref}`}
                onPick={onPick}
                onDragStart={onDragStart}
              />
            ))}
          </ul>
        </>
      )}
      {destroyed.length > 0 && (
        <ul className="chips">
          {destroyed.map((f) => (
            <Chip
              key={f.ref}
              itemRef={f.ref}
              label={tierName(f.tierId)}
              sub={`${T.fenceSegment(f.ref, f.hp, f.maxHp)} — ${T.fenceDestroyed}`}
              disabled
              selected={false}
              locked={locked}
              testId={`tray-fence-${f.ref}`}
              onPick={onPick}
              onDragStart={onDragStart}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
