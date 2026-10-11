import { useEffect } from "react";
import { useSession, SessionProvider } from "./auth/session.tsx";
import { LoginScreen } from "./screens/login/LoginScreen.tsx";
import { Placeholder } from "./screens/Placeholder.tsx";
import { TrailScreen } from "./screens/trail/TrailScreen.tsx";
import { WebsScreen } from "./screens/webs/WebsScreen.tsx";
import { AppShell } from "./shell/AppShell.tsx";
import { ErrorBoundary } from "./shell/ErrorBoundary.tsx";
import { navigate, useRoute } from "./shell/router.tsx";
import { STRINGS } from "./strings.ts";

function Routed(): JSX.Element {
  const { session, signOut } = useSession();
  const route = useRoute();
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
      screen = <Placeholder title={STRINGS.tabs.party} body={STRINGS.placeholder.party} />;
      break;
    case "town":
    case "login":
    default:
      screen = <Placeholder title={STRINGS.tabs.town} body={STRINGS.placeholder.town} />;
  }
  return (
    <AppShell route={route === "login" ? "town" : route} username={session.account.username} onSignOut={() => void signOut()}>
      {screen}
    </AppShell>
  );
}

export function App({ fetchImpl }: { fetchImpl?: typeof fetch } = {}): JSX.Element {
  return (
    <SessionProvider {...(fetchImpl ? { fetchImpl } : {})}>
      <ErrorBoundary>
        <Routed />
      </ErrorBoundary>
    </SessionProvider>
  );
}
