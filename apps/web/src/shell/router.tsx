/**
 * A hand-rolled hash router: `#/town`, `#/trail`, `#/party`, `#/webs`, `#/login`. Four
 * screens and a login do not justify a dependency; a later chunk can swap this for
 * react-router without changing screens, which only use `useRoute` / `navigate`.
 */
import { useEffect, useState } from "react";

export const ROUTES = ["town", "trail", "party", "webs", "login"] as const;
export type Route = (typeof ROUTES)[number];
export const DEFAULT_ROUTE: Route = "town";

export function parseHash(hash: string): Route {
  const name = hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : DEFAULT_ROUTE;
}

export function navigate(route: Route): void {
  if (typeof window === "undefined") return;
  const next = `#/${route}`;
  if (window.location.hash === next) return;
  window.location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => (typeof window === "undefined" ? DEFAULT_ROUTE : parseHash(window.location.hash)));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    onChange();
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
