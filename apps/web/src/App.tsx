import { useSession, SessionProvider } from "./auth/session.tsx";
import { LoginScreen } from "./screens/login/LoginScreen.tsx";
import { Placeholder } from "./screens/Placeholder.tsx";
import { TrailScreen } from "./screens/trail/TrailScreen.tsx";
import { WebsScreen } from "./screens/webs/WebsScreen.tsx";
import { AppShell } from "./shell/AppShell.tsx";
import { useRoute } from "./shell/router.tsx";
import { STRINGS } from "./strings.ts";

function Routed(): JSX.Element {
  const { session, signOut } = useSession();
  const route = useRoute();
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
      <Routed />
    </SessionProvider>
  );
}
