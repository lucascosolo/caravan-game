/**
 * The Inbox (chunk 29, PHASE-2 §29): what happened while the player was away. Everything on it
 * is the server's — the items (derived from the ledger and the existing timers), which are
 * unread, and which categories are shown. The screen renders that and sends read marks; it
 * never decides what is read, and nothing is stored in the browser.
 *
 * Every item says what happened, where, and what it cost or earned. A party strike — batched
 * per hour with a count — lists each fight with its own "Watch the fight", which opens the
 * replay player over this screen (chunk 22) and marks the batch read. Only the newest batches
 * arrive with their fights listed; an older batch fetches them when opened (chunk 29 QA S4).
 * When batches fall past the 30th or outside the horizon, the list ends by saying so, with the
 * way to the results feed (QA D2). No item links to the store or suggests spending anything.
 *
 * "Mark all read" sends the key and version of every unread item ON SCREEN, so a strike that
 * landed after this render stays unread (QA S1).
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { InboxCategoryView, InboxItemView, InboxStrikeView, InboxView, StrikeDetailView } from "../../api/inboxTypes.ts";
import { useApi } from "../../auth/session.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { publishUnread } from "../../shell/inboxSignal.ts";
import { formatWhen } from "../../shell/issues.ts";
import { navigate } from "../../shell/router.tsx";
import { defenderLabel } from "../../shell/defender.ts";
import { STRINGS } from "../../strings.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Note } from "../../ui/Note.tsx";
import { WatchFight } from "../replay/WatchFight.tsx";
import { AnalyticsToggle } from "./AnalyticsToggle.tsx";
import { KitSwitch } from "./KitSwitch.tsx";
import "./inbox.css";

const T = STRINGS.inbox;

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

export interface InboxScreenProps {
  readonly api?: Api;
}

export function InboxScreen(props: InboxScreenProps = {}): JSX.Element {
  const api = useApi(props.api);
  const [inbox, setInbox] = useState<InboxView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const accept = useCallback((view: InboxView): void => {
    setInbox(view);
    publishUnread(view.unreadCount);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      accept(await api.inbox());
    } catch (err) {
      setLoadError(asApiError(err));
    }
  }, [api, accept]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<InboxView>, done: string): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setStatus(null);
    try {
      accept(await fn());
      setStatus(done);
    } catch (err) {
      setActionError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const markOne = (item: InboxItemView): Promise<void> => act(() => api.markInboxRead({ marks: [{ key: item.key, version: item.version }] }), T.marked);
  const markAll = (): Promise<void> => {
    const marks = (inbox?.items ?? []).filter((i) => i.unread).map((i) => ({ key: i.key, version: i.version }));
    return marks.length === 0 ? Promise.resolve() : act(() => api.markInboxRead({ marks }), T.marked);
  };
  const setPref = (category: InboxCategoryView, enabled: boolean): Promise<void> => act(() => api.setInboxPreferences({ [category]: enabled }), T.prefsSaved);

  if (loadError) return <ErrorBox error={loadError} onRetry={() => void load()} />;
  if (!inbox) {
    return (
      <p className="hint" role="status">
        {STRINGS.app.loading}
      </p>
    );
  }

  return (
    <section aria-labelledby="inbox-heading" className="inbox" data-testid="inbox-screen">
      <div className="inbox__head">
        <h1 id="inbox-heading" className="cv-title">
          <Icon name="letter" /> {T.title}
        </h1>
        {inbox.unreadCount > 0 && (
          <Button variant="secondary" disabled={busy} onClick={() => void markAll()} testId="inbox-mark-all">
            {T.markAll}
          </Button>
        )}
      </div>
      <p className="hint">{T.intro}</p>
      <p className="hint">{T.noPush}</p>
      {actionError && <ErrorBox error={actionError} />}
      <p className="visually-hidden" role="status" aria-live="polite">
        {status ?? ""}
      </p>

      {inbox.items.length === 0 ? (
        <p className="hint" data-testid="inbox-empty">
          {T.empty}
        </p>
      ) : (
        <ul className="inbox__list" data-testid="inbox-items">
          {inbox.items.map((item) => (
            <li key={item.key} data-testid={`inbox-item-${item.category}`} data-unread={item.unread ? "true" : "false"}>
              <Note nail={item.unread ? "brass" : "iron"} className="inbox__note">
                <ItemBody item={item} api={api} onWatch={() => (item.unread ? void markOne(item) : undefined)} />
                <div className="inbox-actions">
                  {item.unread && (
                    <Button variant="secondary" disabled={busy} onClick={() => void markOne(item)} testId={`inbox-mark-${item.key}`}>
                      {T.markRead}
                    </Button>
                  )}
                  <ItemLink item={item} />
                </div>
              </Note>
            </li>
          ))}
        </ul>
      )}
      {inbox.olderStrikes && (
        <div className="inbox-older" data-testid="inbox-older">
          <p className="hint">{T.olderStrikes(inbox.olderStrikes.batchesPastLimit, inbox.olderStrikes.beforeHorizon)}</p>
          <Button variant="secondary" onClick={() => navigate("party")}>
            {T.openFeed}
          </Button>
        </div>
      )}

      <details className="disclosure" data-testid="inbox-prefs">
        <summary className="inbox__summary cv-label">{T.prefsHeading}</summary>
        <p className="hint">{T.prefsIntro}</p>
        <div className="inbox__prefs">
          {inbox.preferences.map((p) => (
            <KitSwitch
              key={p.category}
              label={
                <>
                  {T.category(p.category)} <span className="hint">({T.prefDefault(p.defaultEnabled)})</span>
                </>
              }
              checked={p.enabled}
              disabled={busy}
              onChange={(v) => void setPref(p.category, v)}
              testId={`inbox-pref-${p.category}`}
            />
          ))}
        </div>
        {/* Chunk 32: the usage-data opt-out lives with the other settings. */}
        <AnalyticsToggle api={api} />
      </details>
    </section>
  );
}

function Head({ title, item }: { readonly title: string; readonly item: InboxItemView }): JSX.Element {
  return (
    <div className="inbox__top">
      <div className="inbox__name">
        {item.unread && (
          <>
            <span className="cv-pill cv-pill--brass cv-pill--sm inbox__stamp">{T.unread}</span>{" "}
          </>
        )}
        {title}
      </div>
      <div className="inbox__line hint">{T.when(formatWhen(item.occurredAt))}</div>
    </div>
  );
}

function ItemBody({ item, api, onWatch }: { readonly item: InboxItemView; readonly api: Api; readonly onWatch: () => void }): JSX.Element {
  switch (item.category) {
    case "party_strike": {
      const d = item.detail;
      return (
        <>
          <Head title={T.strikeTitle(d.count)} item={item} />
          <div className="inbox__line">{T.strikeOutcomes(d.overran, d.held, d.stalemate, d.other)}</div>
          <div className="inbox__line">{T.strikeEarned(d.coinEarned, d.reputationDelta, d.ladderPointsGained)}</div>
          {d.coinTransferred > 0 && <div className="inbox__line hint">{T.strikeTransferred(d.coinTransferred)}</div>}
          {d.coinDiscardedAtCap > 0 && <div className="inbox__line hint">{T.strikeDiscarded(d.coinDiscardedAtCap)}</div>}
          <div className="inbox__line hint">{d.windowOpen === true ? T.strikeWindowOpen(formatWhen(d.windowStartMs)) : T.strikeWindow(formatWhen(d.windowStartMs), formatWhen(d.windowEndMs))}</div>
          <StrikeLines itemKey={item.key} detail={d} api={api} onWatch={onWatch} />
          {d.notListed > 0 && <p className="hint">{T.strikeNotListed(d.notListed)}</p>}
        </>
      );
    }
    case "refugees_arrived":
      return (
        <>
          <Head title={T.refugeesTitle} item={item} />
          <div className="inbox__line">{T.refugeesBody(item.detail.caravanName)}</div>
          {item.detail.currentMenuUnclaimed && <div className="inbox__line hint">{T.refugeesUnclaimed}</div>}
        </>
      );
    case "trip_cap_refilled":
      return (
        <>
          <Head title={T.tripCapTitle} item={item} />
          <div className="inbox__line">{T.tripCapBody(item.detail.cap)}</div>
        </>
      );
    case "mine_near_cap":
      return (
        <>
          <Head title={T.mineTitle(item.detail.atCap)} item={item} />
          <div className="inbox__line">{T.mineBody(item.detail.balance, item.detail.cap)}</div>
          {item.detail.capReachedAtMs !== null && <div className="inbox__line hint">{T.mineStops(item.detail.ratePerHour, formatWhen(item.detail.capReachedAtMs))}</div>}
        </>
      );
    case "packs_rotated":
      return (
        <>
          <Head title={T.packsTitle} item={item} />
          <div className="inbox__line">{T.packsBody(formatWhen(item.detail.startsAtMs))}</div>
        </>
      );
    case "party_changed":
      return (
        <>
          <Head title={item.detail.empty ? T.partyChangedEmptyTitle : T.partyChangedTitle} item={item} />
          <div className="inbox__line">{T.partyChangedBody(item.detail.reason, item.detail.carriedOver, item.detail.dropped, item.detail.unitsNow, item.detail.changes ?? 1)}</div>
        </>
      );
  }
}

/** The window index in a strike item's key (`strike:<window>`). */
const windowOf = (key: string): number => Number(key.slice("strike:".length));

/** A batch's fights: listed when the inbox sent them, else fetched on request (QA S4). */
function StrikeLines({ itemKey, detail, api, onWatch }: { readonly itemKey: string; readonly detail: StrikeDetailView; readonly api: Api; readonly onWatch: () => void }): JSX.Element | null {
  const [fetched, setFetched] = useState<readonly InboxStrikeView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const lines = detail.linesIncluded ? detail.strikes : fetched;
  if (lines === null) {
    const show = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        setFetched((await api.inboxStrikes(windowOf(itemKey))).strikes);
      } catch (err) {
        setError(asApiError(err));
      } finally {
        setLoading(false);
      }
    };
    return (
      <div className="inbox-actions">
        {error && <ErrorBox error={error} />}
        <Button variant="secondary" disabled={loading} onClick={() => void show()} testId={`inbox-show-${itemKey}`}>
          {loading ? T.loadingStrikes : T.showStrikes(detail.count)}
        </Button>
      </div>
    );
  }
  return (
    <ul className="inbox-strikes">
      {lines.map((s) => (
        <li key={s.seq} data-testid={`inbox-strike-${s.seq}`}>
          <div className="inbox__line">{T.strikeLine(defenderLabel(s.defender), s.encounterIndex)}</div>
          <div className="inbox__line">{T.strikeOutcome(s.outcomeKind)}</div>
          <div className="inbox__line hint">
            {T.strikeLineEarned(s.coinEarned, s.reputationDelta)}
            {s.coinDiscardedAtCap > 0 ? ` ${T.strikeLineDiscarded(s.coinDiscardedAtCap)}` : ""} · {formatWhen(s.occurredAt)}
          </div>
          {s.jobId !== null && s.encounterIndex !== null && (
            <span onClickCapture={onWatch}>
              <WatchFight
                jobId={s.jobId}
                encounterIndex={s.encounterIndex}
                label={T.watch}
                api={api}
                settled={{ coin: s.coinEarned, reputation: s.reputationDelta, ladder: s.ladderPointsGained }}
                testId={`inbox-watch-${s.seq}`}
              />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Where an item's "go there" leads. Never the store, never a spend. */
function ItemLink({ item }: { readonly item: InboxItemView }): JSX.Element | null {
  const link = (label: string, route: "party" | "town" | "trail"): JSX.Element => (
    <Button variant="secondary" onClick={() => navigate(route)}>
      {label}
    </Button>
  );
  switch (item.category) {
    case "party_strike":
      return link(T.openFeed, "party");
    case "refugees_arrived":
      return link(T.openTown, "town");
    case "trip_cap_refilled":
      return link(T.openTrail, "trail");
    case "party_changed":
      return link(T.openParty, "party");
    // Stated, not sold: neither the mine nor a pack rotation points anywhere a Coin could be spent.
    case "mine_near_cap":
    case "packs_rotated":
      return null;
  }
}
