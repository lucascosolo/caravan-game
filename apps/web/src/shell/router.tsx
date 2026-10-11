/**
 * A hand-rolled hash router: `#/town`, `#/trail`, `#/party`, `#/webs`, `#/login`. Four
 * screens and a login do not justify a dependency; a later chunk can swap this for
 * react-router without changing screens, which only use `useRoute` / `navigate`.
 *
 * The hash is normalised (QA-06 N5): whatever is in the address bar, once parsed, is
 * rewritten to its canonical `#/<route>` form with `history.replaceState` (no history
 * entry, no hashchange), so an unknown or oddly spelled hash lands on Town AND reads
 * `#/town`. Route names are matched case-insensitively.
 */
import { useEffect, useState } from "react";

/** `packs` and `cosmetics` (chunk 20) are the Town's own sub-screens: the Town tab stays current on them. */
/** `inbox` (chunk 29) is opened from the header button; no tab is current on it. */
/** `admin` (chunk 32) is the operator dashboard: linked from nowhere, a 404 from the server for players. */
export const ROUTES = ["town", "trail", "party", "webs", "packs", "cosmetics", "inbox", "account", "login", "admin"] as const;
export type Route = (typeof ROUTES)[number];
export const DEFAULT_ROUTE: Route = "town";

export function parseHash(hash: string): Route {
  const name = (hash.replace(/^#\/*/, "").split(/[/?#]/)[0] ?? "").toLowerCase();
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : DEFAULT_ROUTE;
}

export function hashFor(route: Route): string {
  return `#/${route}`;
}

export function navigate(route: Route, opts: { readonly replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const next = hashFor(route);
  if (window.location.hash === next) return;
  if (opts.replace) {
    window.history.replaceState(null, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = next;
}

/** The current route, with the address bar's hash rewritten to its canonical form. */
export function readRoute(): Route {
  const route = parseHash(window.location.hash);
  if (window.location.hash !== hashFor(route)) window.history.replaceState(null, "", hashFor(route));
  return route;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => (typeof window === "undefined" ? DEFAULT_ROUTE : readRoute()));
  useEffect(() => {
    const onChange = (): void => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    onChange();
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
