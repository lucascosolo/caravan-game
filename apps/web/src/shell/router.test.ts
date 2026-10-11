import { describe, expect, it } from "vitest";
import { hashFor, navigate, parseHash, readRoute } from "./router.tsx";

describe("hash router", () => {
  it("maps hashes to routes and falls back to town", () => {
    expect(parseHash("#/webs")).toBe("webs");
    expect(parseHash("#webs")).toBe("webs");
    expect(parseHash("#/trail?x=1")).toBe("trail");
    expect(parseHash("#/party/extra")).toBe("party");
    expect(parseHash("")).toBe("town");
    expect(parseHash("#/nope")).toBe("town");
    // QA-06 N5: spelling variants the address bar can carry.
    expect(parseHash("#/WEBS")).toBe("webs");
    expect(parseHash("#//webs")).toBe("webs");
    expect(parseHash("#/webs#x")).toBe("webs");
    expect(parseHash("#/")).toBe("town");
    expect(parseHash("#")).toBe("town");
  });

  it("normalises the address bar to the canonical hash without adding history", () => {
    const len = window.history.length;
    for (const [raw, route] of [
      ["#/nope", "town"],
      ["#/WEBS", "webs"],
      ["#//webs", "webs"],
      ["#/webs#x", "webs"],
      ["#/trail?a=b", "trail"],
      ["#", "town"],
      ["#/webs", "webs"],
    ] as const) {
      window.history.replaceState(null, "", raw);
      expect(readRoute()).toBe(route);
      expect(window.location.hash).toBe(hashFor(route));
    }
    expect(window.history.length).toBe(len);
  });

  it("navigate({replace}) rewrites the hash in place and announces the change", () => {
    window.history.replaceState(null, "", "#/login");
    let changes = 0;
    const onChange = (): void => {
      changes++;
    };
    window.addEventListener("hashchange", onChange);
    const len = window.history.length;
    navigate("town", { replace: true });
    expect(window.location.hash).toBe("#/town");
    expect(window.history.length).toBe(len);
    expect(changes).toBe(1);
    window.removeEventListener("hashchange", onChange);
  });
});
