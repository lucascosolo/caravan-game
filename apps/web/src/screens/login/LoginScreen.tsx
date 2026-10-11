/**
 * The first screen when no session is running.
 *
 * Chunk 30, guest-first: the top card starts a caravan with NO username or password — the
 * player picks the region (chosen once per caravan and never swapped, and the hint says so
 * before they commit) and plays the whole tutorial as a guest; the Account screen links a
 * username and password later, to the same account. Below it, the chunk 01 sign-in form for a
 * returning player on a new device, and registration with a username up front for anyone who
 * prefers it.
 *
 * On a reload the session provider has already asked the server to resume from its HttpOnly
 * device cookie; while that answer is out a status line says so, and on success this screen
 * is replaced by the game.
 */
import { REGIONS } from "@caravan/content";
import { useState, type FormEvent } from "react";
import { ApiError } from "../../api/client.ts";
import { useSession } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";

type Mode = "signIn" | "register";

function RegionField({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  const s = STRINGS.auth;
  return (
    <label className="field">
      <span className="field__label">{s.region}</span>
      <select name="region" value={value} onChange={(e) => onChange(e.target.value)}>
        {REGIONS.map((r) => (
          <option key={r.id} value={r.id}>
            {r.displayName}
          </option>
        ))}
      </select>
      <span className="hint">{s.regionHint}</span>
    </label>
  );
}

function ErrorLine({ error }: { error: ApiError | null }): JSX.Element | null {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <div>{error.status === 0 ? STRINGS.app.networkError : error.message}</div>
      <div className="error__code">{error.code}</div>
    </div>
  );
}

export function LoginScreen(): JSX.Element {
  const { api, signIn, resuming } = useSession();
  const [mode, setMode] = useState<Mode>("signIn");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState<string>(REGIONS[0].id);
  const [caravanName, setCaravanName] = useState("");
  const [guestRegion, setGuestRegion] = useState<string>(REGIONS[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [guestError, setGuestError] = useState<ApiError | null>(null);
  const s = STRINGS.auth;

  const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth =
        mode === "signIn"
          ? await api.login(username, password)
          : await api.register({ username, password, region, ...(caravanName.trim() ? { caravanName: caravanName.trim() } : {}) });
      signIn(auth);
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function startAsGuest(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setGuestError(null);
    try {
      signIn(await api.guest(guestRegion));
    } catch (err) {
      setGuestError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>{STRINGS.app.title}</h1>
      {resuming && (
        <p className="hint" role="status">
          {s.resuming}
        </p>
      )}
      {mode === "signIn" && (
        <form className="card" onSubmit={startAsGuest} aria-busy={busy} aria-labelledby="start-title" data-testid="guest-start">
          <h2 id="start-title">{s.start}</h2>
          <p className="hint">{s.startIntro}</p>
          <RegionField value={guestRegion} onChange={setGuestRegion} />
          <ErrorLine error={guestError} />
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? s.working : s.submitStart}
          </button>
        </form>
      )}
      <h2>{mode === "signIn" ? s.signIn : s.register}</h2>
      <form onSubmit={submit} aria-busy={busy}>
        <label className="field">
          <span className="field__label">{s.username}</span>
          <input name="username" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field__label">{s.password}</span>
          <input
            name="password"
            type="password"
            autoComplete={mode === "signIn" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {mode === "register" && (
          <>
            <RegionField value={region} onChange={setRegion} />
            <label className="field">
              <span className="field__label">{s.caravanName}</span>
              <input name="caravanName" value={caravanName} onChange={(e) => setCaravanName(e.target.value)} maxLength={60} />
            </label>
          </>
        )}
        <ErrorLine error={error} />
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? s.working : mode === "signIn" ? s.submitSignIn : s.submitRegister}
        </button>
      </form>
      <p>
        <button type="button" className="btn btn--block" onClick={() => setMode(mode === "signIn" ? "register" : "signIn")}>
          {mode === "signIn" ? s.switchToRegister : s.switchToSignIn}
        </button>
      </p>
    </section>
  );
}
