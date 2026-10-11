import { Suspense, lazy, useEffect, useState } from "react";
import { useSession, SessionProvider } from "./auth/session.tsx";
import { LoginScreen } from "./screens/login/LoginScreen.tsx";
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
const CosmeticsScreen = lazy(() => import("./screens/store/CosmeticsScreen.tsx").then((m) => ({ default: m.CosmeticsScreen })));
import { AppShell } from "./shell/AppShell.tsx";
import { ErrorBoundary } from "./shell/ErrorBoundary.tsx";
import { navigate, useRoute } from "./shell/router.tsx";

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
  if (!session) {
    return (
      <div className="shell">
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
    case "town":
    case "login":
    default:
      screen = <TownScreen />;
  }
  // Chunk 24: a new account's first screen (which side is played live, which runs while away) comes before any tab.
  const welcome = onboarding?.step === "welcome";
  if (welcome) screen = <WelcomeScreen api={api} />;
  return (
    <AppShell route={route === "login" || route === "packs" || route === "cosmetics" ? "town" : route} username={session.account.username} onSignOut={() => void signOut()}>
      {!welcome && <ShellGuide api={api} route={route} onPartySaved={() => setPartyEpoch((n) => n + 1)} />}
      <Suspense
        fallback={
          <p className="hint" role="status">
            {STRINGS.app.loading}
          </p>
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

export function App({ fetchImpl }: { fetchImpl?: typeof fetch } = {}): JSX.Element {
  return (
    <SessionProvider {...(fetchImpl ? { fetchImpl } : {})}>
      <ErrorBoundary>
        <GuideScope>
          <Routed />
        </GuideScope>
      </ErrorBoundary>
    </SessionProvider>
  );
}
