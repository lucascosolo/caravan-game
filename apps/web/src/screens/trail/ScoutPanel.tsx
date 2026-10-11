/**
 * The scouting panel (chunk 08): the attacking party in full, BEFORE any arrangement is
 * committed. Every unit (type, merge level, HP, offense and defense as two numbers with
 * offense emphasized, speed, range, cooldown, its one ability with cooldown and — for a
 * healer — its finite charges, its targeting stance, which edge it enters from and the
 * exact start cell), every siege piece with what it counters, and the approach summary
 * per edge. This is a DOM list on purpose: it is the text alternative to the canvas
 * (PHASE-2 §35) and a screen reader can name every unit, stance and siege piece from it.
 *
 * Nothing in the party model is left out. If a field is added to `PartyUnit`, it belongs
 * here too.
 */
import { getSiegeType } from "@caravan/content";
import { STRINGS } from "../../strings.ts";
import { AffinityIcon } from "../webs/AffinityIcon.tsx";
import type { ScoutedEncounter } from "./scoutTypes.ts";
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

export function ScoutPanel({ encounter }: { encounter: ScoutedEncounter }): JSX.Element {
  const { party } = encounter;
  const cards = party.units.map((u) => ({ unit: u, card: attackerCard(u) }));
  return (
    <section className="scout" aria-labelledby="scout-heading" data-testid="scout-panel">
      <h2 id="scout-heading">{T.scoutHeading}</h2>
      <p className="hint">{T.scoutIntro}</p>
      {encounter.source === "fixture" && (
        <p className="hint" data-testid="scout-fixture-hint">
          {T.scoutFixture}
        </p>
      )}
      <p>
        <strong>{T.scoutUnits(party.units.length)}</strong> · <strong>{T.scoutSiege(party.siege.length)}</strong>
      </p>

      <h3 className="h3">{T.scoutApproach}</h3>
      <ul className="plain" data-testid="scout-approach">
        {EDGES.map((edge) => {
          const n = party.units.filter((u) => u.entry.edge === edge).length;
          return (
            <li key={edge} data-edge={edge} data-count={n}>
              {T.scoutApproachLine(T.edgeName(edge), n)}
            </li>
          );
        })}
      </ul>

      <ul className="cards" aria-label={T.scoutUnits(party.units.length)}>
        {cards.map(({ unit, card }) => (
          <li key={unit.ref} className="card card--attacker" data-testid={`scout-unit-${unit.ref}`}>
            <div className="card__head">
              <span className="card__name">{card.displayName}</span>
              <AffinityIcon affinity={card.affinity} />
            </div>
            <p className="hint">
              {T.mergeLevel(unit.mergeLevel)} · {T.hpOf(unit.hp, unit.maxHp)}
            </p>
            <p className="card__line">{T.attackerStance(unit.stance)}</p>
            <p className="card__line">{T.startsAt(T.edgeName(unit.entry.edge), unit.entry.cell.x, unit.entry.cell.y)}</p>
            <UnitStatBlock card={card} />
          </li>
        ))}
      </ul>

      <h3 className="h3">{T.scoutSiege(party.siege.length)}</h3>
      {party.siege.length === 0 ? (
        <p className="hint">{T.scoutNoSiege}</p>
      ) : (
        <ul className="cards" aria-label={T.scoutSiege(party.siege.length)}>
          {party.siege.map((s) => {
            const type = getSiegeType(s.typeId);
            return (
              <li key={s.ref} className="card card--siege" data-testid={`scout-siege-${s.ref}`}>
                <div className="card__head">
                  <span className="card__name">{type?.displayName ?? s.typeId}</span>
                </div>
                <p className="card__line">{T.siegeCounters(s.counters.category, s.counters.kind === "fence" ? T.siegeKindFence : T.siegeKindTrap)}</p>
                {type?.flavor && <p className="flavor">{type.flavor}</p>}
              </li>
            );
          })}
          <li className="hint">{T.siegeTrapNote}</li>
        </ul>
      )}
    </section>
  );
}
