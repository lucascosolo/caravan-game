import { Suspense, lazy, useEffect, useState } from "react";
import { useSession, SessionProvider } from "./auth/session.tsx";
import { LoginScreen } from "./screens/login/LoginScreen.tsx";
import { AccountScreen } from "./screens/account/AccountScreen.tsx";
import { GuestSavePrompt } from "./screens/account/GuestSavePrompt.tsx";
import { WebsScreen } from "./screens/webs/WebsScreen.tsx";
import { STRINGS } from "./strings.ts";
import { OnboardingProvider, useOnboarding } from "./onboarding/OnboardingProvider.tsx";
import { ShellGuide } from "./onboarding/ShellGuide.tsx";
import { WelcomeScreen } from "./onboarding/WelcomeScreen.tsx";

// The screens that draw on the iso canvas are lazy chunks (chunk 08 QA S3): PixiJS stays
// out of the login chunk and loads only once a canvas screen is opened.
const TownScreen = lazy(() => import("./screens/town/TownScreen.tsx").then((m) => ({ default: m.TownScreen })));
const PartyScreen = lazy(() => import("./screens/party/PartyScreen.tsx").then((m) => ({ default: m.PartyScreen })));
const TrailScreen = lazy(() => import("./screens/trail/TrailScreen.tsx").then((m) => ({ default: m.TrailScreen })));
// Chunk 20: the storefront and the cosmetics screen are lazy chunks too (kept out of the login chunk).
const PacksScreen = lazy(() => import("./screens/store/PacksScreen.tsx").then((m) => ({ default: m.PacksScreen })));
// Chunk 29: the inbox (lazy: its "Watch the fight" opens the replay player, which draws on the canvas).
const InboxScreen = lazy(() => import("./screens/inbox/InboxScreen.tsx").then((m) => ({ default: m.InboxScreen })));
const CosmeticsScreen = lazy(() => import("./screens/store/CosmeticsScreen.tsx").then((m) => ({ default: m.CosmeticsScreen })));
// Chunk 32: the admin dashboard, a lazy chunk no player ever loads (no link to it anywhere).
const AdminScreen = lazy(() => import("./screens/admin/AdminScreen.tsx").then((m) => ({ default: m.AdminScreen })));
import { AppShell } from "./shell/AppShell.tsx";
import { ErrorBoundary } from "./shell/ErrorBoundary.tsx";
import { navigate, useRoute } from "./shell/router.tsx";
import { reportCrash } from "./telemetry/telemetry.ts";
import { useTelemetry } from "./telemetry/useTelemetry.ts";

function Routed(): JSX.Element {
  const { session, signOut, api } = useSession();
  const route = useRoute();
  const onboarding = useOnboarding();
  // Chunk 24: after the guide raised the standing party, a Party screen already open re-reads it.
  const [partyEpoch, setPartyEpoch] = useState(0);
  // `#/login` is not a screen once signed in (QA-06 N5): it becomes `#/town`, replaced so
  // Back does not bounce through it. A deep link to any other route is kept across sign-in.
  useEffect(() => {
    if (session && route === "login") navigate("town", { replace: true });
  }, [session, route]);
  // Chunk 32: screen flow (and crashes) for this session; the server honours the opt-out.
  const welcomeShown = onboarding?.step === "welcome";
  useTelemetry(api, session !== null, session === null ? null : welcomeShown ? "welcome" : route === "login" ? "town" : route);
  if (!session) {
    return (
      <div className="shell cv-root">
        <main className="shell__main">
          <LoginScreen />
        </main>
      </div>
    );
  }
  let screen: JSX.Element;
  switch (route) {
    case "webs":
      screen = <WebsScreen />;
      break;
    case "trail":
      screen = <TrailScreen />;
      break;
    case "party":
      screen = <PartyScreen key={partyEpoch} />;
      break;
    case "packs":
      screen = <PacksScreen />;
      break;
    case "cosmetics":
      screen = <CosmeticsScreen />;
      break;
    case "inbox":
      screen = <InboxScreen />;
      break;
    case "account":
      screen = <AccountScreen />;
      break;
    case "admin":
      screen = <AdminScreen />;
      break;
    case "town":
    case "login":
    default:
      screen = <TownScreen />;
  }
  // Chunk 24: a new account's first screen (which side is played live, which runs while away) comes before any tab.
  const welcome = onboarding?.step === "welcome";
  if (welcome) screen = <WelcomeScreen api={api} />;
  return (
    <AppShell route={route === "login" || route === "packs" || route === "cosmetics" ? "town" : route} username={session.account.username} onSignOut={() => void signOut()} hideTabs={welcome}>
      {!welcome && <ShellGuide api={api} route={route} onPartySaved={() => setPartyEpoch((n) => n + 1)} />}
      {/* QA-30 D1: a guest is reminded to save their progress in town (never blocking). */}
      {/* Final play-test review N3: not while the first-session guide is still running. */}
      {!welcome && !onboarding?.active && (route === "town" || route === "login") && <GuestSavePrompt place="town" />}
      <Suspense
        fallback={
          <div className="cv-loadtick" role="status">
            <span className="cv-spinner" aria-hidden="true" />
            <span className="cv-loadtick__word">{STRINGS.app.loading}</span>
          </div>
        }
      >
        {screen}
      </Suspense>
    </AppShell>
  );
}

/** Chunk 24: the guide's state, read once per signed-in session (a new sign-in is a new provider). */
function GuideScope({ children }: { children: JSX.Element }): JSX.Element {
  const { session, api } = useSession();
  if (!session) return children;
  return (
    <OnboardingProvider key={session.token} api={api}>
      {children}
    </OnboardingProvider>
  );
}

/** The render error boundary's report: logged as before, and sent as a crash (class + stack hash only). */
function onRenderError(error: unknown, info: { componentStack?: string | null }): void {
  reportCrash(error);
  console.error("render error", error, info.componentStack);
}

export function App({ fetchImpl, autoResume }: { fetchImpl?: typeof fetch; autoResume?: boolean } = {}): JSX.Element {
  return (
    <SessionProvider {...(fetchImpl ? { fetchImpl } : {})} {...(autoResume !== undefined ? { autoResume } : {})}>
      <ErrorBoundary onError={onRenderError}>
        <GuideScope>
          <Routed />
        </GuideScope>
      </ErrorBoundary>
    </SessionProvider>
  );
}
