/**
 * Chunk 32: the admin balance dashboard (`#/admin`). A lazy chunk linked from nowhere; for
 * anyone the server does not flag as an admin, `GET /admin/dashboard` is a 404 and this page
 * says "Not found." and nothing else. Everything on it is the server's aggregate — the page
 * renders tables (every number as text; a rate also gets a single-hue bar beside its text) and
 * the PROJECT.md §20 table that names the panel each placeholder number is tuned against.
 * Read-only: nothing here writes, and nothing a player sees reads it.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { DashboardView, TypedPanel } from "../../api/telemetryTypes.ts";
import { useApi } from "../../auth/session.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.admin;
const WINDOWS = [7, 30, 90] as const;

type Cell = string | number | null;
interface Column<R> {
  readonly label: string;
  readonly value: (row: R) => Cell;
  /** Basis points: also drawn as a bar. */
  readonly rate?: boolean;
}

function RateBar({ bp }: { readonly bp: number | null }): JSX.Element {
  return (
    <span className="admin-rate">
      <span>{T.rate(bp)}</span>
      {bp !== null && (
        <span className="admin-rate__track" aria-hidden="true">
          <span className="admin-rate__fill" style={{ width: `${Math.min(100, bp / 100)}%` }} />
        </span>
      )}
    </span>
  );
}

function Table<R>({ rows, columns, testId }: { readonly rows: readonly R[]; readonly columns: readonly Column<R>[]; readonly testId?: string }): JSX.Element {
  if (rows.length === 0) return <p className="hint">{T.empty}</p>;
  return (
    <div className="admin-table__scroll">
      <table className="admin-table" data-testid={testId}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const v = c.value(r);
                return <td key={c.label}>{c.rate ? <RateBar bp={v as number | null} /> : v === null ? "—" : String(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ id, children }: { readonly id: string; readonly children: React.ReactNode }): JSX.Element {
  return (
    <section className="card admin-panel" data-testid={`panel-${id}`} aria-labelledby={`panel-${id}-h`}>
      <h2 id={`panel-${id}-h`} className="card__name">
        {T.panels[id] ?? id}
      </h2>
      {children}
    </section>
  );
}

const typed = (win: "held" | "overrun"): Column<TypedPanel["rows"][number]>[] => [
  { label: "Type", value: (r) => r.typeId },
  { label: "Encounters", value: (r) => r.appearances },
  { label: "Pick rate", value: (r) => r.pickRateBp, rate: true },
  { label: win === "held" ? "Held" : "Overran", value: (r) => r.wins },
  { label: "Win rate", value: (r) => r.winRateBp, rate: true },
];

export function AdminScreen(props: { readonly api?: Api } = {}): JSX.Element {
  const api = useApi(props.api);
  const [days, setDays] = useState<number>(30);
  const [dash, setDash] = useState<DashboardView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setDash(await api.adminDashboard(days));
    } catch (err) {
      setDash(null);
      setError(err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));
    }
  }, [api, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error?.status === 404) {
    return (
      <p className="hint" data-testid="admin-not-found">
        {T.notFound}
      </p>
    );
  }
  if (error) return <ErrorBox error={error} onRetry={() => void load()} />;
  if (!dash) {
    return (
      <p className="hint" role="status">
        {STRINGS.app.loading}
      </p>
    );
  }
  const p = dash.panels;
  const panelTitle = (id: string): string => T.panels[id] ?? id;
  return (
    <section aria-labelledby="admin-heading" data-testid="admin-screen" className="admin">
      <div className="sheet__head">
        <h1 id="admin-heading" className="sheet__title">
          {T.title}
        </h1>
        <label className="admin-window">
          <span className="hint">{T.days}</span>{" "}
          <select value={days} onChange={(e) => setDays(Number(e.currentTarget.value))} data-testid="admin-days">
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">{T.intro}</p>
      <p className="hint" data-testid="admin-window">
        {T.window(dash.window.days, dash.window.from.slice(0, 10), dash.window.to.slice(0, 10))}
      </p>

      <section className="card admin-panel" data-testid="admin-tuning" aria-labelledby="admin-tuning-h">
        <h2 id="admin-tuning-h" className="card__name">
          {T.tuningHeading}
        </h2>
        <Table
          rows={dash.tuning}
          columns={[
            { label: "#", value: (t) => t.n },
            { label: T.tuningNumber, value: (t) => t.number },
            { label: T.tuningTunables, value: (t) => t.tunables.map((k) => (k in dash.tunableValues ? `${k} = ${JSON.stringify(dash.tunableValues[k])}` : k)).join("; ") },
            { label: T.tuningPanels, value: (t) => t.panels.map(panelTitle).join(" · ") },
            { label: T.tuningMetric, value: (t) => t.metric },
          ]}
        />
      </section>

      <Panel id="poolHealth">
        <p className="hint" data-testid="admin-alarms">
          {T.alarms(p.poolHealth.alarms)}
        </p>
        <Table
          testId="pool-bands"
          rows={p.poolHealth.bands}
          columns={[
            { label: "Band", value: (b) => `${b.band} (${b.low}–${b.high})` },
            { label: "Live parties", value: (b) => b.liveParties },
            { label: "Authored", value: (b) => b.authoredParties },
            { label: "Live share", value: (b) => b.liveShareBp, rate: true },
            { label: "Caravans", value: (b) => b.caravans },
            { label: "Served", value: (b) => b.served },
            { label: "Served authored (window)", value: (b) => b.servedAuthoredShareBp, rate: true },
            { label: "Matchmaker's share", value: (b) => b.matchmakerWindow.shareBp, rate: true },
            { label: "Status", value: (b) => T.alarm(b.alarm) },
          ]}
        />
      </Panel>

      <Panel id="grindWall">
        <p className="hint">
          Week {p.grindWall.weekIndex} ({p.grindWall.weekFrom.slice(0, 10)}): WEEKLY_PAY_CEILING {p.grindWall.weeklyPayCeiling}, FREE_WEEKLY_EARN_ESTIMATE {p.grindWall.freeWeeklyEarnEstimate}
        </p>
        <p className="hint" data-testid="grind-note">
          {p.grindWall.note}
        </p>
        <Table
          rows={p.grindWall.deciles}
          columns={[
            { label: "Decile", value: (d) => d.decile },
            { label: "Players", value: (d) => d.players },
            { label: "Free earn (min–max)", value: (d) => `${d.minFree}–${d.maxFree}` },
            { label: "Free earn (avg)", value: (d) => d.avgFree },
            { label: "Paid (avg)", value: (d) => d.avgPaid },
            { label: "Payers", value: (d) => d.payers },
            { label: "Ceiling ÷ free", value: (d) => d.ceilingToFreeBp, rate: true },
          ]}
        />
      </Panel>

      <Panel id="tripLength">
        <Table rows={p.tripLength} columns={[{ label: "Ended", value: (r) => r.endReason }, { label: "Encounters", value: (r) => r.encounters }, { label: "Trips", value: (r) => r.trips }]} />
      </Panel>
      <Panel id="bankVsPush">
        <Table
          rows={p.bankVsPush}
          columns={[
            { label: "Encounter", value: (r) => r.encounterIndex },
            { label: "Settled", value: (r) => r.settled },
            { label: "Held", value: (r) => r.held },
            { label: "Overrun", value: (r) => r.overrun },
            { label: "Stalemate", value: (r) => r.stalemate },
            { label: "Pushed", value: (r) => r.pushed },
            { label: "Banked", value: (r) => r.banked },
            { label: "Push rate", value: (r) => r.pushRateBp, rate: true },
            { label: "Overrun rate", value: (r) => r.overrunRateBp, rate: true },
          ]}
        />
      </Panel>
      <Panel id="overrunByBand">
        <Table rows={p.overrunByBand} columns={[{ label: "Band", value: (r) => r.band }, { label: "Encounters", value: (r) => r.encounters }, { label: "Overrun", value: (r) => r.overrun }, { label: "Stalemate", value: (r) => r.stalemate }, { label: "Overrun rate", value: (r) => r.overrunRateBp, rate: true }]} />
      </Panel>
      <Panel id="defenderUnits">
        <Table rows={p.defenderUnits.rows} columns={typed("held")} />
      </Panel>
      <Panel id="attackerUnits">
        <Table rows={p.attackerUnits.rows} columns={[...typed("overrun"), { label: "In live parties", value: (r) => r.live ?? null }]} />
      </Panel>
      <Panel id="matchups">
        <Table testId="matchups" rows={p.matchups} columns={[{ label: "Posted affinity", value: (r) => r.defender }, { label: "Raider affinity", value: (r) => r.attacker }, { label: "Encounters", value: (r) => r.encounters }, { label: "Held", value: (r) => r.held }, { label: "Overrun", value: (r) => r.overrun }, { label: "Held rate", value: (r) => r.heldRateBp, rate: true }]} />
      </Panel>
      <Panel id="mergeLevels">
        <Table rows={p.mergeLevels} columns={[{ label: "Side", value: (r) => r.side }, { label: "Merge level", value: (r) => r.level }, { label: "Encounters", value: (r) => r.encounters }, { label: "Held rate", value: (r) => r.heldRateBp, rate: true }]} />
      </Panel>
      <Panel id="fences">
        <Table testId="fences" rows={p.fences} columns={[{ label: "Tier", value: (r) => r.tierId }, { label: "Placed", value: (r) => r.placed }, { label: "Broken", value: (r) => r.broken }, { label: "Damaged", value: (r) => r.damaged }, { label: "HP lost", value: (r) => r.hpLost }, { label: "Broken rate", value: (r) => r.brokenRateBp, rate: true }]} />
      </Panel>
      <Panel id="stances">
        <Table rows={p.stances} columns={[{ label: "Stance", value: (r) => r.stance }, { label: "Posts", value: (r) => r.posts }, { label: "Held", value: (r) => r.held }, { label: "Held rate", value: (r) => r.heldRateBp, rate: true }]} />
      </Panel>
      <Panel id="slots">
        <Table rows={p.slots} columns={[{ label: "Slot", value: (r) => r.side }, { label: "Count", value: (r) => r.count }, { label: "Encounters", value: (r) => r.encounters }, { label: "Held rate", value: (r) => r.heldRateBp, rate: true }]} />
      </Panel>
      <Panel id="traps">
        <Table rows={p.traps.rows} columns={typed("held")} />
      </Panel>
      <Panel id="siege">
        <Table rows={p.siege.rows} columns={typed("overrun")} />
      </Panel>
      <Panel id="tickCap">
        <p className="hint">
          Cap {p.tickCap.capTicks} ticks; near = at least {p.tickCap.nearCapTicks}
        </p>
        <Table rows={p.tickCap.rows} columns={[{ label: "Outcome", value: (r) => r.outcomeKind }, { label: "Fights", value: (r) => r.fights }, { label: "Near cap", value: (r) => r.nearCap }, { label: "At cap (stalemate)", value: (r) => r.atCap }, { label: "Median end tick", value: (r) => r.medianEndTick }, { label: "Max end tick", value: (r) => r.maxEndTick }]} />
      </Panel>
      <Panel id="ladder">
        <Table rows={p.ladder.gained} columns={[{ label: "Pool", value: (r) => r.pool }, { label: "Gains", value: (r) => r.events }, { label: "Points", value: (r) => r.points }, { label: "Rungs crossed", value: (r) => r.rungs }]} />
        <Table rows={p.ladder.levels} columns={[{ label: "Pool", value: (r) => r.pool }, { label: "Rung", value: (r) => r.level }, { label: "Owners now", value: (r) => r.owners }]} />
      </Panel>
      <Panel id="unlockPurchases">
        <Table rows={p.unlockPurchases} columns={[{ label: "Pool", value: (r) => r.pool }, { label: "Node", value: (r) => r.nodeId }, { label: "Purchases", value: (r) => r.purchases }, { label: "Points", value: (r) => r.points }]} />
      </Panel>
      <Panel id="mergeSpend">
        <Table rows={p.mergeSpend.byDay} columns={[{ label: "Day", value: (r) => r.day }, { label: "Merges", value: (r) => r.merges }, { label: "Coin", value: (r) => r.coin }]} />
        <Table rows={p.mergeSpend.byLevel} columns={[{ label: "To level", value: (r) => r.toLevel }, { label: "Merges", value: (r) => r.merges }, { label: "Coin", value: (r) => r.coin }]} />
      </Panel>
      <Panel id="spendByReason">
        <Table rows={p.spendByReason} columns={[{ label: "Reason", value: (r) => r.reason }, { label: "Spends", value: (r) => r.events }, { label: "Coin", value: (r) => r.coin }]} />
      </Panel>
      <Panel id="refugees">
        <Table rows={p.refugees} columns={[{ label: "Day", value: (r) => r.day }, { label: "Free menus", value: (r) => r.freeMenus }, { label: "Rerolls", value: (r) => r.rerolls }, { label: "Claims", value: (r) => r.claims }, { label: "Caravans", value: (r) => r.caravans }]} />
      </Panel>
      <Panel id="earnBySource">
        <Table rows={p.earnBySource} columns={[{ label: "Event", value: (r) => r.type }, { label: "Reason", value: (r) => r.reason }, { label: "Credits", value: (r) => r.events }, { label: "Coin", value: (r) => r.coin }, { label: "Discarded at cap", value: (r) => r.discarded }]} />
      </Panel>
      <Panel id="storageCap">
        <Table
          rows={[p.storageCap]}
          columns={[
            { label: "Cap", value: (r) => r.cap },
            { label: "Players", value: (r) => r.accounts },
            { label: `≥ ${p.storageCap.nearCapPercent}% of cap`, value: (r) => r.nearCap },
            { label: "At cap", value: (r) => r.atCap },
            { label: "Discarded in window", value: (r) => r.discarded },
          ]}
        />
      </Panel>
      <Panel id="tripCap">
        <Table rows={[p.tripCap]} columns={[{ label: "Cap per hour", value: (r) => r.capPerHour }, { label: "Starts", value: (r) => r.starts }, { label: "Accounts", value: (r) => r.accounts }, { label: "Took the last use", value: (r) => r.tookLastUse }, { label: "Share", value: (r) => r.tookLastUseBp, rate: true }]} />
      </Panel>
      <Panel id="packFunnel">
        {!p.packFunnel.counted && (
          <p className="hint" data-testid="admin-funnel-off">
            The store is off on this server (STORE_MODE=off): packs are previewed but not sold, so no funnel is counted.
          </p>
        )}
        <p className="hint" data-testid="admin-funnel">
          Opened the game {p.packFunnel.viewers} → opened the store {p.packFunnel.storeViewers} → bought {p.packFunnel.buyers}
        </p>
        <p className="hint">One population: players who have not opted out of usage data. Per tier, the store viewers&apos; purchases.</p>
        <p className="hint" data-testid="admin-all-buyers">
          Not part of the funnel: {p.packFunnel.allBuyers} buyers in all (opted-out players included).
        </p>
        <Table rows={p.packFunnel.tiers} columns={[{ label: "Tier", value: (r) => r.tier }, { label: "Reserved", value: (r) => r.reserved }, { label: "Settled", value: (r) => r.settled }, { label: "Buyers", value: (r) => r.buyers }, { label: "Cents", value: (r) => r.cents }]} />
      </Panel>
      <Panel id="sessionLength">
        <p className="hint">
          {p.sessionLength.sessions} sessions by {p.sessionLength.players} players; median {T.ms(p.sessionLength.medianMs)}, longest {T.ms(p.sessionLength.maxMs)} (a gap over {T.ms(p.sessionLength.gapMs)} starts a new session)
        </p>
        <Table rows={p.sessionLength.buckets} columns={[{ label: "Length", value: (r) => r.label }, { label: "Sessions", value: (r) => r.sessions }]} />
      </Panel>
      <Panel id="retention">
        <Table rows={p.retention.days} columns={[{ label: "Day", value: (r) => r.day }, { label: "Eligible", value: (r) => r.eligible }, { label: "Returned", value: (r) => r.returned }, { label: "Rate", value: (r) => r.rateBp, rate: true }]} />
      </Panel>
      <Panel id="screens">
        <Table rows={p.screens} columns={[{ label: "Screen", value: (r) => r.screen }, { label: "Views", value: (r) => r.views }, { label: "Viewers", value: (r) => r.viewers }]} />
      </Panel>
      <Panel id="crashes">
        <Table rows={p.crashes} columns={[{ label: "Class", value: (r) => r.errorName }, { label: "Stack hash", value: (r) => r.stackHash }, { label: "Screen", value: (r) => r.screen }, { label: "Reports", value: (r) => r.reports }, { label: "Reporters", value: (r) => r.reporters }]} />
      </Panel>
      <button type="button" className="btn" onClick={() => void load()}>
        {T.reload}
      </button>
    </section>
  );
}
