/**
 * Sign in / register against chunk 01's auth routes. Registration needs a region: it is
 * chosen once per caravan and never swapped, and the hint says so before the player commits.
 */
import { REGIONS } from "@caravan/content";
import { useState, type FormEvent } from "react";
import { ApiError } from "../../api/client.ts";
import { useSession } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";

type Mode = "signIn" | "register";

export function LoginScreen(): JSX.Element {
  const { api, signIn } = useSession();
  const [mode, setMode] = useState<Mode>("signIn");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState<string>(REGIONS[0].id);
  const [caravanName, setCaravanName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const s = STRINGS.auth;

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
      setError(err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>{STRINGS.app.title}</h1>
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
            <label className="field">
              <span className="field__label">{s.region}</span>
              <select name="region" value={region} onChange={(e) => setRegion(e.target.value)}>
                {REGIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                  </option>
                ))}
              </select>
              <span className="hint">{s.regionHint}</span>
            </label>
            <label className="field">
              <span className="field__label">{s.caravanName}</span>
              <input name="caravanName" value={caravanName} onChange={(e) => setCaravanName(e.target.value)} maxLength={60} />
            </label>
          </>
        )}
        {error && (
          <div className="error" role="alert">
            <div>{error.status === 0 ? STRINGS.app.networkError : error.message}</div>
            <div className="error__code">{error.code}</div>
          </div>
        )}
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
