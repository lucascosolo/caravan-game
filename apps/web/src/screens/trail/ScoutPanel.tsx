/**
 * The scouting panel (chunk 08, fed by chunk 14): one party in full, as the server's
 * `PartyScoutView` describes it. Every unit (type, merge level, max HP, offense and defense
 * as two numbers with offense emphasized since that is the rating in use, speed, range,
 * cooldown, its one ability with cooldown and — for a healer — its finite charges, its
 * targeting stance, the edge it enters from and the exact start cell), every siege piece
 * (what it counters, whether it accelerates or bypasses, the multiplier, the exact fence
 * tiers or trap types it affects), the edges used and the slots used. This is a DOM list
 * on purpose: it is the text alternative to the canvas (PHASE-2 §35) and a screen reader
 * can name every unit, stance and siege piece from it.
 *
 * Nothing in the view is left out. If a field is added to `ScoutUnit` or `ScoutSiege`, it
 * belongs here too.
 */
import { getFenceTier, getTrapType } from "@caravan/content";
import { memo } from "react";
import { STRINGS } from "../../strings.ts";
import { fixedToText } from "../webs/catalogue.ts";
import { AffinityIcon } from "../webs/AffinityIcon.tsx";
import type { ScoutedParty } from "./scoutTypes.ts";
import { attackerCard, type UnitCard } from "./stats.ts";

const T = STRINGS.trail;
const EDGES = ["north", "east", "south", "west"] as const;

export function StatPair({ card }: { card: UnitCard }): JSX.Element {
  const big = card.emphasis;
  return (
    <div className="statpair" role="group" aria-label={`${T.offense} ${card.offense}, ${T.defense} ${card.defense}`}>
      <span className={`statpair__stat${big === "offense" ? " statpair__stat--big" : ""}`}>
        <span className="statpair__lbl">{T.offense}</span>
        <span className="statpair__num">{card.offense}</span>
      </span>
      <span className={`statpair__stat${big === "defense" ? " statpair__stat--big" : ""}`}>
        <span className="statpair__lbl">{T.defense}</span>
        <span className="statpair__num">{card.defense}</span>
      </span>
    </div>
  );
}

export function UnitStatBlock({ card }: { card: UnitCard }): JSX.Element {
  return (
    <>
      <StatPair card={card} />
      <dl className="statlist statlist--compact">
        {card.lines.map((l) => (
          <div key={l.label} style={{ display: "contents" }}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
        <div style={{ display: "contents" }}>
          <dt>{STRINGS.webs.stat.ability}</dt>
          <dd>
            <strong>{card.ability.name}</strong> — {card.ability.description}
          </dd>
        </div>
        {card.ability.lines.map((l) => (
          <div key={`a-${l.label}`} style={{ display: "contents" }}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export interface ScoutPanelProps {
  readonly scout: ScoutedParty;
  /** Only component tests pass a fixture; the app always shows a matchmaking candidate. */
  readonly source?: "fixture" | "matchmaking";
  /** Distinguishes several panels on the candidates screen. */
  readonly idSuffix?: string;
  /** An attacker tapped on the canvas (QA S14): its card is highlighted. */
  readonly selectedRef?: string | null;
}

/** Memoised (QA S2): it is long, and nothing in it changes while the player drags. */
export const ScoutPanel = memo(function ScoutPanel({ scout, source = "matchmaking", idSuffix = "", selectedRef = null }: ScoutPanelProps): JSX.Element {
  const cards = scout.units.map((u) => ({ unit: u, card: attackerCard(u) }));
  const headingId = `scout-heading${idSuffix}`;
  const typeName = (id: string): string => getFenceTier(id)?.displayName ?? getTrapType(id)?.displayName ?? id;
  return (
    <section className="scout" aria-labelledby={headingId} data-testid={`scout-panel${idSuffix}`}>
      <h2 id={headingId}>{T.scoutHeading}</h2>
      <p className="hint">{T.scoutIntro}</p>
      {source === "fixture" && (
        <p className="hint" data-testid="scout-fixture-hint">
          {T.scoutFixture}
        </p>
      )}
      <p>
        <strong>{T.scoutUnits(scout.units.length)}</strong> · <strong>{T.scoutSiege(scout.siege.length)}</strong>
      </p>
      <p className="hint">
        {T.unitSlots(scout.unitSlots.used, scout.unitSlots.cap)} · {T.siegeSlots(scout.siegeSlots.used, scout.siegeSlots.cap)}
      </p>

      <h3 className="h3">{T.scoutApproach}</h3>
      <ul className="plain" data-testid={`scout-approach${idSuffix}`}>
        {EDGES.map((edge) => {
          const n = scout.units.filter((u) => u.edge === edge).length;
          return (
            <li key={edge} data-edge={edge} data-count={n} data-used={scout.edges.includes(edge) ? "yes" : "no"}>
              {T.scoutApproachLine(T.edgeName(edge), n)}
            </li>
          );
        })}
      </ul>

      <ul className="cards" aria-label={T.scoutUnits(scout.units.length)}>
        {cards.map(({ unit, card }) => (
          <li
            key={unit.ref}
            className={`card card--attacker${selectedRef === unit.ref ? " card--selected" : ""}`}
            data-testid={`scout-unit-${unit.ref}${idSuffix}`}
            data-selected={selectedRef === unit.ref ? "true" : "false"}
            tabIndex={-1}
          >
            <div className="card__head">
              <span className="card__name">{card.displayName}</span>
              <AffinityIcon affinity={card.affinity} />
            </div>
            <p className="hint">
              {T.mergeLevel(unit.mergeLevel)} · {T.hpOf(unit.hp, unit.hp)}
            </p>
            <p className="card__line">{T.attackerStance(unit.stance)}</p>
            <p className="card__line">{T.startsAt(T.edgeName(unit.edge), unit.cell.x, unit.cell.y)}</p>
            <UnitStatBlock card={card} />
          </li>
        ))}
      </ul>

      <h3 className="h3">{T.scoutSiege(scout.siege.length)}</h3>
      {scout.siege.length === 0 ? (
        <p className="hint">{T.scoutNoSiege}</p>
      ) : (
        <ul className="cards" aria-label={T.scoutSiege(scout.siege.length)}>
          {scout.siege.map((s) => (
            <li key={s.typeId} className="card card--siege" data-testid={`scout-siege-${s.typeId}${idSuffix}`}>
              <div className="card__head">
                <span className="card__name">{s.displayName}</span>
              </div>
              <p className="card__line">{T.siegeCounters(s.counters.category, s.counters.kind === "fence" ? T.siegeKindFence : T.siegeKindTrap)}</p>
              <p className="card__line">
                {T.siegeEffect(s.effect)}
                {s.fenceDamageMult !== null ? ` · ${T.siegeMult(fixedToText(s.fenceDamageMult))}` : ""}
              </p>
              <p className="hint">{T.siegeTargets(s.targetTypeIds.map(typeName).join(", "))}</p>
            </li>
          ))}
          <li className="hint">{T.siegeTrapNote}</li>
        </ul>
      )}
    </section>
  );
});
