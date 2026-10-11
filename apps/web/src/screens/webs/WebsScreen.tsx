/**
 * The unlock webs screen (chunk 06). Three pools, each a whole web with every node and
 * every cost visible before a point is spent. The client renders SERVER state only:
 * reached / affordable / locked come from GET /me/unlocks, the spend goes to
 * POST /me/unlocks/spend behind a confirm step, and after any spend the screen re-fetches
 * rather than updating optimistically. A refusal (409 etc.) is shown with the server's
 * exact code and message.
 */
import { REGIONS } from "@caravan/content";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client.ts";
import type { CaravanSummary, PoolProgressView, SpendRequest, UnlockNodeView, UnlockPool, UnlockWebView } from "../../api/types.ts";
import { useSession } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";
import { displayNameOf } from "./catalogue.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { NodeDetail } from "./NodeDetail.tsx";
import { PointsPanel } from "./PointsPanel.tsx";
import { WebGraph } from "./WebGraph.tsx";

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

export function ErrorBox({ error, heading }: { error: ApiError; heading?: string }): JSX.Element {
  return (
    <div className="error" role="alert" data-testid="api-error">
      {heading && <div>{heading}</div>}
      <div data-testid="api-error-message">{error.status === 0 ? STRINGS.app.networkError : error.message}</div>
      <div className="error__code">
        {error.status > 0 ? `${error.status} ` : ""}
        {error.code}
      </div>
    </div>
  );
}

export function WebsScreen(): JSX.Element {
  const { api } = useSession();
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [pool, setPool] = useState<UnlockPool>("living");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<UnlockNodeView | null>(null);
  const [spending, setSpending] = useState(false);
  const [spendError, setSpendError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const [unlocks, progression, me] = await Promise.all([api.unlocks(), api.progression(), api.me()]);
      setData({ webs: unlocks.webs, progress: progression.pools, caravans: me.caravans });
    } catch (err) {
      setLoadError(err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const w = STRINGS.webs;
  // v1 has exactly one caravan, so at most one living web; the first is shown.
  const web = data?.webs.find((x) => x.pool === pool);
  const selected = web?.nodes.find((n) => n.id === selectedId) ?? null;

  function choosePool(next: UnlockPool): void {
    setPool(next);
    setSelectedId(null);
    setSpendError(null);
    setNotice(null);
  }

  async function confirmSpend(): Promise<void> {
    if (!web || !pending) return;
    setSpending(true);
    setSpendError(null);
    setNotice(null);
    const req: SpendRequest = web.scope === "caravan" ? { pool: web.pool, nodeId: pending.id, caravanId: web.caravanId } : { pool: web.pool, nodeId: pending.id };
    try {
      await api.spendUnlock(req);
      setNotice(w.spendDone(displayNameOf(pending.id)));
      setPending(null);
      // No optimistic update: the server's answer is the only truth, so read it back.
      await load();
    } catch (err) {
      setSpendError(err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));
      setPending(null);
      await load();
    } finally {
      setSpending(false);
    }
  }

  return (
    <section>
      <h1>{w.title}</h1>
      <p className="hint">{w.intro}</p>

      <div className="pooltabs" role="tablist" aria-label={w.title}>
        {POOLS.map((p) => (
          <button key={p} type="button" role="tab" className="pooltabs__tab" aria-selected={pool === p} onClick={() => choosePool(p)}>
            {w.poolName(p)}
          </button>
        ))}
      </div>

      {loadError && (
        <>
          <ErrorBox error={loadError} heading={w.fetchFailed} />
          <button type="button" className="btn btn--block" onClick={() => void load()}>
            {STRINGS.app.retry}
          </button>
        </>
      )}
      {!data && !loadError && <p className="hint">{STRINGS.app.loading}</p>}
      {data && !web && <p className="hint">{w.noCaravan}</p>}

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {spendError && <ErrorBox error={spendError} heading={w.spendFailed} />}

      {web && (
        <div role="tabpanel" data-testid={`web-${web.pool}`}>
          <PointsPanel web={web} progress={progressFor(web, data!.progress)} scopeLine={scopeLineFor(web, data!.caravans)} />
          <WebGraph web={web} selectedId={selectedId} onSelect={(id) => setSelectedId(id === selectedId ? null : id)} />
        </div>
      )}

      {web && selected && (
        <NodeDetail
          node={selected}
          available={web.points.available}
          onUnlock={(n) => {
            setSpendError(null);
            setPending(n);
          }}
          onClose={() => setSelectedId(null)}
        />
      )}

      {web && pending && (
        <ConfirmDialog
          title={w.confirmTitle}
          body={w.confirmBody(displayNameOf(pending.id), pending.cost, web.points.available)}
          confirmLabel={spending ? w.spending : w.confirmYes}
          cancelLabel={w.confirmNo}
          busy={spending}
          onConfirm={() => void confirmSpend()}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
