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
import { REGIONS, getUnitType, unlockWebFor, type RegionId } from "@caravan/content";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client.ts";
import { useSession } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";

type Mode = "signIn" | "register";

/** Final play-test review N4: a region's starting units (its living web's tier-0 nodes) and their affinities, from content. */
export function regionStarters(region: string): string {
  if (!REGIONS.some((r) => r.id === region)) return "";
  const names = unlockWebFor("living", region as RegionId)
    .nodes.filter((n) => n.tier === 0)
    .map((n) => {
      const u = getUnitType(n.id);
      return u ? `${u.displayName} (${STRINGS.webs.affinityName(u.affinity)})` : n.id;
    });
  return STRINGS.auth.regionStarters(names.join(", "));
}

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
      <span className="hint" data-testid="region-starters" style={{ display: "block" }}>
        {regionStarters(value)}
      </span>
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

/** QA-30 S4: the sign-in that was asked about (a guest is on this device), to re-send with replaceGuest. */
type Pending = { kind: "guest" } | { kind: "signIn" } | { kind: "register" };

export function LoginScreen(): JSX.Element {
  const { api, signIn, resuming, resumeError, retryResume, notice } = useSession();
  const [pending, setPending] = useState<Pending | null>(null);
  /**
   * Final play-test review r2 S1: "Continue the guest caravan" was asked for. If the resume it
   * starts finds no device after all, say so on its own card instead of silently dropping back to
   * the start screen (the loop that left "Delete it…" as the only button that did anything).
   */
  const [continuing, setContinuing] = useState(false);
  const [continueStarted, setContinueStarted] = useState(false);
  useEffect(() => {
    if (continuing && resuming) setContinueStarted(true);
  }, [continuing, resuming]);
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

  async function run(kind: Pending["kind"], replaceGuest: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    setGuestError(null);
    try {
      const auth =
        kind === "guest"
          ? // r4 N11: no client-side name; the server generates one (1,024 names, re-rolled so it never shares a first part with another caravan's).
            await api.guest(guestRegion, undefined, replaceGuest)
          : kind === "signIn"
            ? await api.login(username, password, replaceGuest)
            : await api.register({ username, password, region, ...(caravanName.trim() ? { caravanName: caravanName.trim() } : {}) }, replaceGuest);
      setPending(null);
      signIn(auth);
    } catch (err) {
      const e = asApiError(err);
      // QA-30 S4: this device holds a guest caravan — ask before anything replaces it.
      if (e.status === 409 && e.code === "guest_on_device") setPending({ kind });
      else if (kind === "guest") setGuestError(e);
      else setError(e);
    } finally {
      setBusy(false);
    }
  }

  function continueGuest(): void {
    setPending(null);
    setContinuing(true);
    setContinueStarted(false);
    retryResume();
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    await run(mode === "signIn" ? "signIn" : "register", false);
  }

  async function startAsGuest(e: FormEvent): Promise<void> {
    e.preventDefault();
    await run("guest", false);
  }

  // QA-30 S4: a resume that failed for any reason but "no device here" is a retry, never the start
  // screen (a guest pressing "Start playing" there would lose the caravan).
  if (resumeError && !resuming) {
    return (
      <section>
        <h1 className="cv-sign cv-sign--title">{STRINGS.app.title}</h1>
        <div className="card" role="alert" data-testid="resume-failed">
          <h2>{s.resumeFailedTitle}</h2>
          <p>{s.resumeFailedBody}</p>
          <ErrorLine error={resumeError} />
          <button type="button" className="btn btn--primary btn--block" onClick={retryResume}>
            {STRINGS.app.retry}
          </button>
        </div>
      </section>
    );
  }

  if (continuing && continueStarted && !resuming && !pending) {
    return (
      <section>
        <h1 className="cv-sign cv-sign--title">{STRINGS.app.title}</h1>
        <div className="card" role="alert" data-testid="continue-failed">
          <h2>{s.continueFailedTitle}</h2>
          <p>{s.continueFailedBody}</p>
          <button type="button" className="btn btn--primary btn--block" onClick={retryResume}>
            {STRINGS.app.retry}
          </button>
          <button type="button" className="btn btn--block" onClick={() => { setContinuing(false); setContinueStarted(false); }}>
            {STRINGS.account.back}
          </button>
        </div>
      </section>
    );
  }

  if (pending) {
    return (
      <section>
        <h1 className="cv-sign cv-sign--title">{STRINGS.app.title}</h1>
        <div className="card card--danger" role="alertdialog" aria-labelledby="guest-on-device-title" data-testid="guest-on-device">
          <h2 id="guest-on-device-title">{s.guestOnDeviceTitle}</h2>
          <p>{s.guestOnDeviceBody}</p>
          <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={continueGuest}>
            {s.continueGuest}
          </button>
          <button type="button" className="btn btn--block btn--danger" disabled={busy} onClick={() => void run(pending.kind, true)}>
            {pending.kind === "guest" ? s.replaceGuestStart : s.replaceGuestSignIn}
          </button>
          <button type="button" className="btn btn--block" disabled={busy} onClick={() => setPending(null)}>
            {STRINGS.account.back}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1 className="cv-sign cv-sign--title">{STRINGS.app.title}</h1>
      {resuming && (
        <p className="hint" role="status">
          {s.resuming}
        </p>
      )}
      {notice && (
        <p className="notice" role="status" data-testid="start-notice">
          {notice}
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
