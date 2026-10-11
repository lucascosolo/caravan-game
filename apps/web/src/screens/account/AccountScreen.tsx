/**
 * Chunk 30: the Account screen — save a guest's progress (link a username + password to the
 * SAME account), the signed-in devices, a JSON export of the account's data, sign-out, and
 * deletion behind a typed confirmation (and the password, once there is one).
 *
 * Everything shown is the server's: whether the account is a guest, which devices exist,
 * whether deletion needs a password and the exact phrase to type. The client never decides
 * any of it. The export is handed to the browser as a download; nothing is kept.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { AccountView, DeviceView } from "../../api/accountTypes.ts";
import { useApi, useSession } from "../../auth/session.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { formatWhen } from "../../shell/issues.ts";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.account;
const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

export interface AccountScreenProps {
  readonly api?: Api;
  /** Tests: where the export goes (default: a browser download). */
  readonly saveFile?: (name: string, text: string) => void;
}

function browserDownload(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function AccountScreen({ api: apiOverride, saveFile = browserDownload }: AccountScreenProps = {}): JSX.Element {
  const api = useApi(apiOverride);
  const { session, updateAccount, signOut, forget } = useSession();
  const [view, setView] = useState<AccountView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setView(await api.account());
    } catch (err) {
      setLoadError(asApiError(err));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <ErrorBox error={loadError} onRetry={() => void load()} />;
  if (!view) {
    return (
      <p className="hint" role="status">
        {STRINGS.app.loading}
      </p>
    );
  }
  const guest = view.account.guest;
  return (
    <section data-testid="account-screen">
      <h1>{T.title}</h1>
      {guest ? (
        <LinkCard
          api={api}
          onLinked={(account) => {
            setView({ ...view, account, deletion: { ...view.deletion, requiresPassword: true } });
            if (session) updateAccount({ id: account.id, username: account.username, guest: account.guest });
          }}
        />
      ) : (
        <p className="notice">{T.linked(view.account.username ?? "")}</p>
      )}
      <DevicesCard api={api} guest={guest} devices={view.devices} onChanged={(devices) => setView({ ...view, devices })} />
      <ExportCard api={api} saveFile={saveFile} />
      <SignOutCard guest={guest} onSignOut={(abandon) => void signOut(abandon)} />
      <DeleteCard api={api} confirmPhrase={view.deletion.confirmPhrase} requiresPassword={view.deletion.requiresPassword} onDeleted={forget} />
    </section>
  );
}

function LinkCard({ api, onLinked }: { readonly api: Api; readonly onLinked: (a: AccountView["account"]) => void }): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.linkAccount(username, password);
      setDone(true);
      onLinked(r.account);
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={submit} aria-busy={busy} aria-labelledby="link-title" data-testid="link-card">
      <p className="badge">{T.guestBadge}</p>
      <h2 id="link-title">{T.linkTitle}</h2>
      <p className="error" role="note">
        {T.guestWarning}
      </p>
      <p className="hint">{T.linkIntro}</p>
      <label className="field">
        <span className="field__label">{STRINGS.auth.username}</span>
        <input name="username" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
      </label>
      <label className="field">
        <span className="field__label">{STRINGS.auth.password}</span>
        <input name="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <ErrorBox error={error} />}
      {done && (
        <p className="notice" role="status">
          {T.linkedDone}
        </p>
      )}
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? STRINGS.auth.working : T.linkSubmit}
      </button>
    </form>
  );
}

function DevicesCard({ api, guest, devices, onChanged }: { readonly api: Api; readonly guest: boolean; readonly devices: readonly DeviceView[]; readonly onChanged: (d: readonly DeviceView[]) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const others = devices.filter((d) => !d.current);
  async function run(f: () => Promise<string | null>): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setNote(await f());
      onChanged((await api.devices()).devices);
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card" data-testid="devices-card">
      <h2>{T.devicesTitle}</h2>
      <p className="hint">{T.devicesIntro}</p>
      <ul className="cards" aria-label={T.devicesTitle}>
        {devices.map((d) => (
          <li key={d.id} className="card" data-testid="device-row">
            <div className="card__name">
              {d.label} {d.current && <span className="badge">{T.thisDevice}</span>}
            </div>
            <div className="card__line hint">{T.lastSeen(formatWhen(d.lastSeenAt))}</div>
            <div className="card__line hint">{T.signedInAt(formatWhen(d.createdAt))}</div>
            {!d.current && (
              <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => (await api.revokeDevice(d.id), null))} aria-label={`${T.revoke}: ${d.label}`}>
                {T.revoke}
              </button>
            )}
          </li>
        ))}
      </ul>
      {others.length === 0 ? (
        <p className="hint">{T.noOtherDevices}</p>
      ) : (
        <button type="button" className="btn btn--block" disabled={busy} onClick={() => void run(async () => T.revokedOthers((await api.revokeOtherDevices()).revoked))}>
          {T.revokeOthers}
        </button>
      )}
      {guest && <p className="hint">{T.guestCannotRevoke}</p>}
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {error && <ErrorBox error={error} />}
    </div>
  );
}

function ExportCard({ api, saveFile }: { readonly api: Api; readonly saveFile: (name: string, text: string) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const data = await api.exportAccount();
      saveFile(`caravan-vaults-export-${data.account.id}.json`, `${JSON.stringify(data, null, 2)}\n`);
      setDone(true);
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card" data-testid="export-card">
      <h2>{T.exportTitle}</h2>
      <p className="hint">{T.exportIntro}</p>
      <button type="button" className="btn btn--block" disabled={busy} onClick={() => void run()}>
        {busy ? T.exporting : T.exportSubmit}
      </button>
      {done && (
        <p className="notice" role="status">
          {T.exported}
        </p>
      )}
      {error && <ErrorBox error={error} />}
    </div>
  );
}

function SignOutCard({ guest, onSignOut }: { readonly guest: boolean; readonly onSignOut: (abandon: boolean) => void }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="card">
      <button type="button" className="btn btn--block" onClick={() => (guest ? setConfirming(true) : onSignOut(false))}>
        {guest ? T.signOutGuest : T.signOut}
      </button>
      {confirming && (
        <Modal
          title={T.signOutGuest}
          busy={false}
          onCancel={() => setConfirming(false)}
          testId="leave-guest"
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                {T.back}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => onSignOut(true)}>
                {T.signOutGuest}
              </button>
            </>
          }
        >
          <p>{T.signOutGuestConfirm}</p>
        </Modal>
      )}
    </div>
  );
}

function DeleteCard({ api, confirmPhrase, requiresPassword, onDeleted }: { readonly api: Api; readonly confirmPhrase: string; readonly requiresPassword: boolean; readonly onDeleted: () => void }): JSX.Element {
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ready = phrase.trim().toLowerCase() === confirmPhrase && (!requiresPassword || password.length > 0);
  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(confirmPhrase, requiresPassword ? password : undefined);
      onDeleted();
    } catch (err) {
      setError(asApiError(err));
      setBusy(false);
    }
  }
  return (
    <form className="card card--danger" onSubmit={submit} aria-busy={busy} aria-labelledby="delete-title" data-testid="delete-card">
      <h2 id="delete-title">{T.deleteTitle}</h2>
      <p>{T.deleteIntro}</p>
      <label className="field">
        <span className="field__label">{T.deleteConfirmLabel(confirmPhrase)}</span>
        <input name="confirm" autoCapitalize="none" autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
      </label>
      {requiresPassword && (
        <label className="field">
          <span className="field__label">{T.deletePassword}</span>
          <input name="delete-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      )}
      {error && <ErrorBox error={error} />}
      <button type="submit" className="btn btn--block btn--danger" disabled={!ready || busy}>
        {busy ? T.deleting : T.deleteSubmit}
      </button>
    </form>
  );
}
