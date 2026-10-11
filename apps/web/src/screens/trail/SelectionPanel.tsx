/**
 * The selected placed thing (chunk 08): its full stat block, and for a post the stance
 * picker — three 44px buttons (guard / hold / reserve, QA D1) with what each means and
 * the radii legend — plus "take back". Tapping a placed fence shows its HP and tier.
 */
import { getFenceTier, getTrapType } from "@caravan/content";
import { DEFENSIVE_STANCES, ringSegment, type DefensiveStance, type Formation, type Manifest } from "@caravan/circle";
import { STRINGS } from "../../strings.ts";
import { AffinityIcon } from "../webs/AffinityIcon.tsx";
import { kindOfRef } from "./placement.ts";
import { UnitStatBlock } from "./ScoutPanel.tsx";
import { defenderCard as card } from "./stats.ts";

const T = STRINGS.trail;

export interface SelectionPanelProps {
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly selectedRef: string;
  readonly locked: boolean;
  readonly onStance: (ref: string, stance: DefensiveStance) => void;
  readonly onRemove: (ref: string) => void;
  readonly onClose: () => void;
}

export function SelectionPanel({ manifest, formation, selectedRef, locked, onStance, onRemove, onClose }: SelectionPanelProps): JSX.Element | null {
  const kind = kindOfRef(manifest, selectedRef);
  if (!kind) return null;
  let body: JSX.Element;
  let placed = false;
  if (kind === "post") {
    const u = manifest.units.find((x) => x.ref === selectedRef)!;
    const post = formation.posts.find((p) => p.ref === selectedRef);
    placed = !!post;
    const c = card(u);
    body = (
      <>
        <div className="card__head">
          <span className="card__name">{c?.displayName ?? u.typeId}</span>
          {c && <AffinityIcon affinity={c.affinity} />}
        </div>
        <p className="hint">
          {T.mergeLevel(u.mergeLevel)} · {T.hpOf(u.hp, u.maxHp)} · {post ? T.posted(post.cell.x, post.cell.y) : T.notPlaced}
        </p>
        {c && <UnitStatBlock card={c} />}
        {post && (
          <fieldset className="stances" data-testid="stance-picker">
            <legend className="h3">{T.stanceHeading}</legend>
            <div className="stances__row" role="radiogroup" aria-label={T.stanceHeading}>
              {DEFENSIVE_STANCES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={post.stance === s}
                  className={`btn stances__btn${post.stance === s ? " stances__btn--on" : ""}`}
                  disabled={locked}
                  onClick={() => onStance(selectedRef, s)}
                >
                  {T.stanceName(s)}
                </button>
              ))}
            </div>
            <p className="hint">{T.stanceDesc(post.stance)}</p>
            <p className="hint">{T.radiiLegend}</p>
          </fieldset>
        )}
      </>
    );
  } else if (kind === "trap") {
    const t = manifest.traps.find((x) => x.ref === selectedRef)!;
    const laid = formation.traps.find((p) => p.ref === selectedRef);
    placed = !!laid;
    const type = getTrapType(t.typeId);
    body = (
      <>
        <div className="card__head">
          <span className="card__name">{type?.displayName ?? t.typeId}</span>
          {type && <AffinityIcon affinity={type.affinity} />}
        </div>
        <p className="hint">{t.spent ? T.trapSpent : laid ? `${T.trapSingleUse} ${T.laid(laid.cell.x, laid.cell.y)}` : `${T.trapSingleUse} ${T.notPlaced}`}</p>
        {type && (
          <dl className="statlist statlist--compact">
            <dt>{STRINGS.webs.stat.category}</dt>
            <dd>{type.category}</dd>
            <dt>{STRINGS.webs.stat.damage}</dt>
            <dd>{type.damage}</dd>
          </dl>
        )}
      </>
    );
  } else {
    const f = manifest.fences.find((x) => x.ref === selectedRef)!;
    const on = formation.fences.find((p) => p.ref === selectedRef);
    placed = !!on;
    const tier = getFenceTier(f.tierId);
    body = (
      <>
        <div className="card__head">
          <span className="card__name">{tier?.displayName ?? f.tierId}</span>
        </div>
        <p className="hint">
          {T.fenceSegment(f.ref, f.hp, f.maxHp)}
          {on ? ` · #${on.segment} ${T.edgeName(ringSegment(on.segment).edge)}` : ` · ${T.notPlaced}`}
        </p>
        {tier && (
          <dl className="statlist statlist--compact">
            <dt>{STRINGS.webs.stat.fenceTier}</dt>
            <dd>{tier.tier}</dd>
            <dt>{STRINGS.webs.stat.category}</dt>
            <dd>{tier.category}</dd>
          </dl>
        )}
      </>
    );
  }
  return (
    <section className="selection" aria-labelledby="selection-heading" data-testid="selection-panel">
      <div className="sheet__head">
        <h2 id="selection-heading" style={{ margin: 0 }}>
          {T.selectedHeading}
        </h2>
        <div className="row">
          {placed && !locked && (
            <button type="button" className="btn" onClick={() => onRemove(selectedRef)} data-testid="selection-remove">
              {T.remove}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {T.deselect}
          </button>
        </div>
      </div>
      {body}
    </section>
  );
}
