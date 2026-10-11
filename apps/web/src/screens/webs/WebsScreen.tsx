/**
 * The unlock webs screen (chunk 06). Three pools, each a whole web with every node and
 * every cost visible before a point is spent. The client renders SERVER state only:
 * reached / affordable / locked come from GET /me/unlocks, the spend goes to
 * POST /me/unlocks/spend behind a confirm step, and after any spend the screen re-fetches
 * rather than updating optimistically. A refusal (409 etc.) is shown with the server's
 * exact code and message.
 *
 * QA-06 N8 / S7: tapping Unlock re-fetches first, so the confirm quotes the server's
 * current cost and balance; if the fresh read no longer calls the node affordable, no
 * confirm opens. The client never computes a remainder: the balance after a spend is the
 * one the spend response carries, and the screen then re-reads everything.
 */
import { REGIONS } from "@caravan/content";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "../../api/client.ts";
import type { CaravanSummary, PoolProgressView, SpendRequest, UnlockNodeView, UnlockPool, UnlockWebView } from "../../api/types.ts";
import { useSession } from "../../auth/session.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { displayNameOf } from "./catalogue.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { NodeDetail } from "./NodeDetail.tsx";
import { PointsPanel } from "./PointsPanel.tsx";
import { WebGraph } from "./WebGraph.tsx";

// Re-exported so existing imports keep working; the component lives in src/shell now.
export { ErrorBox } from "../../shell/ErrorBox.tsx";

const POOLS: readonly UnlockPool[] = ["living", "trap", "siege"];

interface Loaded {
  readonly webs: readonly UnlockWebView[];
  readonly progress: readonly PoolProgressView[];
  readonly caravans: readonly CaravanSummary[];
}

function progressFor(web: UnlockWebView, progress: readonly PoolProgressView[]): PoolProgressView | undefined {
  return progress.find((p) => p.pool === web.pool && (web.scope === "account" ? p.scope === "account" : p.caravanId === web.caravanId));
}

function scopeLineFor(web: UnlockWebView, caravans: readonly CaravanSummary[]): string {
  if (web.scope === "account") return STRINGS.webs.scopeAccount;
  const caravan = caravans.find((c) => c.id === web.caravanId);
  const region = REGIONS.find((r) => r.id === web.regionId)?.displayName ?? web.regionId ?? "";
  return STRINGS.webs.scopeCaravan(region, caravan?.name ?? "");
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError, err instanceof Error ? err.message : undefined);
}

export function WebsScreen(): JSX.Element {
  const { api } = useSession();
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [pool, setPool] = useState<UnlockPool>("living");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The confirm step's quote: the node and the balance as the pre-confirm re-fetch returned them. */
  const [pending, setPending] = useState<{ readonly node: UnlockNodeView; readonly available: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [spending, setSpending] = useState(false);
  const [spendError, setSpendError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tabRefs = useRef<Partial<Record<UnlockPool, HTMLButtonElement | null>>>({});

  /** Reads all three server views; resolves to the fresh data, or null when a read failed (the error is shown). */
  const load = useCallback(async (): Promise<Loaded | null> => {
    setLoadError(null);
    try {
      const [unlocks, progression, me] = await Promise.all([api.unlocks(), api.progression(), api.me()]);
      const next: Loaded = { webs: unlocks.webs, progress: progression.pools, caravans: me.caravans };
      setData(next);
      return next;
    } catch (err) {
      setLoadError(toApiError(err));
      return null;
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const w = STRINGS.webs;
  // v1 has exactly one caravan, so at most one living web; the first is shown.
  const web = data?.webs.find((x) => x.pool === pool);
  const selected = web?.nodes.find((n) => n.id === selectedId) ?? null;

  function choosePool(next: UnlockPool, focus = false): void {
    setPool(next);
    setSelectedId(null);
    setSpendError(null);
    setNotice(null);
    if (focus) tabRefs.current[next]?.focus();
  }

  // Roving tabindex (QA-06 S3): one tab stop for the tablist, arrows move between pools.
  function onTabKey(e: KeyboardEvent<HTMLDivElement>): void {
    const i = POOLS.indexOf(pool);
    let next: UnlockPool | null = null;
    if (e.key === "ArrowRight") next = POOLS[(i + 1) % POOLS.length]!;
    else if (e.key === "ArrowLeft") next = POOLS[(i - 1 + POOLS.length) % POOLS.length]!;
    else if (e.key === "Home") next = POOLS[0]!;
    else if (e.key === "End") next = POOLS[POOLS.length - 1]!;
    if (next === null) return;
    e.preventDefault();
    choosePool(next, true);
  }

  /** Unlock tapped: re-fetch, then confirm against the fresh server state (N8). */
  async function beginSpend(node: UnlockNodeView): Promise<void> {
    setSpendError(null);
    setNotice(null);
    setChecking(true);
    try {
      const fresh = await load();
      const freshWeb = fresh?.webs.find((x) => x.pool === pool);
      const freshNode = freshWeb?.nodes.find((n) => n.id === node.id);
      if (!freshWeb || !freshNode) return;
      if (freshNode.affordable) setPending({ node: freshNode, available: freshWeb.points.available });
      else setNotice(w.spendStale(displayNameOf(node.id)));
    } finally {
      setChecking(false);
    }
  }

  async function confirmSpend(): Promise<void> {
    if (!web || !pending) return;
    setSpending(true);
    setSpendError(null);
    setNotice(null);
    const nodeId = pending.node.id;
    const req: SpendRequest = web.scope === "caravan" ? { pool: web.pool, nodeId, caravanId: web.caravanId } : { pool: web.pool, nodeId };
    // The dialog stays up (busy) until the re-read lands, so when it closes the page
    // already shows the new state and focus can settle on what is actually there.
    try {
      const result = await api.spendUnlock(req);
      // The balance quoted after the spend is the server's answer, not cost arithmetic.
      setNotice(w.spendDone(displayNameOf(nodeId), result.points.available));
      // No optimistic update: the server's answer is the only truth, so read it all back.
      await load();
    } catch (err) {
      setSpendError(toApiError(err));
      await load();
    } finally {
      setPending(null);
      setSpending(false);
    }
  }

  return (
    <section>
      <h1>{w.title}</h1>
      <p className="hint">{w.intro}</p>

      <div className="pooltabs" role="tablist" aria-label={w.title} onKeyDown={onTabKey}>
        {POOLS.map((p) => (
          <button
            key={p}
            ref={(el) => {
              tabRefs.current[p] = el;
            }}
            type="button"
            role="tab"
            id={`pooltab-${p}`}
            aria-controls={`poolpanel-${p}`}
            className="pooltabs__tab"
            aria-selected={pool === p}
            tabIndex={pool === p ? 0 : -1}
            onClick={() => choosePool(p)}
          >
            {w.poolName(p)}
          </button>
        ))}
      </div>

      {loadError && <ErrorBox error={loadError} heading={w.fetchFailed} onRetry={() => void load()} />}
      {!data && !loadError && <p className="hint">{STRINGS.app.loading}</p>}
      {data && !web && <p className="hint">{w.noCaravan}</p>}

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {spendError && <ErrorBox error={spendError} heading={w.spendFailed} />}

      {web && (
        <div role="tabpanel" id={`poolpanel-${web.pool}`} aria-labelledby={`pooltab-${web.pool}`} data-testid={`web-${web.pool}`}>
          <PointsPanel web={web} progress={progressFor(web, data!.progress)} scopeLine={scopeLineFor(web, data!.caravans)} />
          <WebGraph web={web} selectedId={selectedId} onSelect={(id) => setSelectedId(id === selectedId ? null : id)} />
        </div>
      )}

      {web && selected && <NodeDetail node={selected} onUnlock={(n) => void beginSpend(n)} onClose={() => setSelectedId(null)} />}
      {checking && (
        <p className="hint" data-testid="checking">
          {w.checking}
        </p>
      )}

      {web && pending && (
        <ConfirmDialog
          title={w.confirmTitle}
          body={w.confirmBody(displayNameOf(pending.node.id), pending.node.cost, pending.available)}
          confirmLabel={spending ? w.spending : w.confirmYes}
          cancelLabel={w.confirmNo}
          busy={spending}
          onConfirm={() => void confirmSpend()}
          onCancel={() => setPending(null)}
          restoreFocusTo={() => document.querySelector<HTMLElement>(".sheet__title")}
        />
      )}
    </section>
  );
}
