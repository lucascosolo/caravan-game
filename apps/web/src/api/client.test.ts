import { describe, expect, it } from "vitest";
import { survivorsManifest } from "../test/circleFixtures.ts";
import { fakeFetch } from "../test/fixtures.ts";
import { ApiError, BAD_PAYLOAD, createApi } from "./client.ts";

describe("api client", () => {
  it("sends the bearer token and surfaces the server's error body", async () => {
    const ff = fakeFetch({
      "GET /me/unlocks": (call) => (call.headers["Authorization"] === "Bearer tok" ? { status: 200, body: { webs: [] } } : { status: 401, body: { error: "unauthorized", message: "unauthorized" } }),
      "POST /me/unlocks/spend": () => ({ status: 409, body: { error: "prerequisites_unmet", message: "'x' requires 'y' first" } }),
    });
    let unauthorized = 0;
    const api = createApi({ getToken: () => "tok", fetchImpl: ff.fetch, onUnauthorized: () => unauthorized++ });
    expect(await api.unlocks()).toEqual({ webs: [] });
    const err = await api.spendUnlock({ pool: "trap", nodeId: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("prerequisites_unmet");
    expect((err as ApiError).message).toBe("'x' requires 'y' first");
    expect(unauthorized).toBe(0);

    const anon = createApi({ getToken: () => null, fetchImpl: ff.fetch, onUnauthorized: () => unauthorized++ });
    await expect(anon.unlocks()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(unauthorized).toBe(1);
  });

  it("final play-test review r4 N4: a keepalive formation save asks fetch to outlive the page; an ordinary one does not", async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response(JSON.stringify({ error: "x", message: "x" }), { status: 400 });
    }) as typeof fetch;
    const api = createApi({ getToken: () => "tok", fetchImpl });
    const f = { v: 3 as const, fences: [], traps: [], posts: [] };
    await api.saveFormation("c1", 1, f, { keepalive: true }).catch(() => undefined);
    await api.saveFormation("c1", 1, f).catch(() => undefined);
    expect(inits[0]!.keepalive).toBe(true);
    expect(inits[1]!.keepalive).toBeUndefined();
  });

  it("does not persist the token anywhere", () => {
    const ff = fakeFetch({});
    createApi({ getToken: () => "secret", fetchImpl: ff.fetch });
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(document.cookie).toBe("");
  });

  it("carries the server's issue list and whole error body (chunk 07 issues, chunk 14 reroll_cooldown)", async () => {
    const ff = fakeFetch({
      "PUT /caravans/c1/encounters/1/formation": () => ({
        status: 400,
        body: { error: "invalid_formation", message: "the formation is not legal", issues: [{ code: "unit_not_posted", message: "living unit 'u1' has no post", subject: "u1" }, { nope: true }] },
      }),
      "POST /me/caravans/c1/encounters/1/search": () => ({ status: 409, body: { error: "reroll_cooldown", message: "the next free search opens in 42 s", availableAtMs: 1_700_000_000_000, gate: "time" } }),
    });
    const api = createApi({ getToken: () => "tok", fetchImpl: ff.fetch });
    const bad = (await api.saveFormation("c1", 1, { v: 3, fences: [], traps: [], posts: [] }).catch((e: unknown) => e)) as ApiError;
    expect(bad).toBeInstanceOf(ApiError);
    expect(bad.status).toBe(400);
    expect(bad.issues).toEqual([{ code: "unit_not_posted", message: "living unit 'u1' has no post", subject: "u1" }]);
    expect(bad.body["error"]).toBe("invalid_formation");
    const gated = (await api.searchCandidates("c1", 1).catch((e: unknown) => e)) as ApiError;
    expect(gated.code).toBe("reroll_cooldown");
    expect(gated.body["availableAtMs"]).toBe(1_700_000_000_000);
    expect(gated.issues).toEqual([]);
    expect(gated.detail).toBeUndefined();
    expect(new ApiError(0, "x", "y").issues).toEqual([]);
    expect(new ApiError(0, "x", "y").body).toEqual({});
  });

  it("guards the circle and matchmaking routes: a manifest body circle refuses, or a menu of the wrong shape, is bad_payload with the path", async () => {
    const survivors = survivorsManifest();
    const good = { id: "m1", caravanId: "c1", encountersResolved: 0, createdAt: "2026-10-11T00:00:00.000Z", closedAt: null, packed: survivors, survivors, summary: { unitsAlive: 2, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 19, fencesDestroyed: 1 }, formations: [] };
    const ff = fakeFetch({
      "GET /caravans/c1/manifest": () => ({ status: 200, body: { manifest: good } }),
      "GET /caravans/c2/manifest": () => ({ status: 200, body: { manifest: { ...good, survivors: { ...survivors, units: [{ ...survivors.units[0]!, hp: 1.5 }] } } } }),
      "GET /me/caravans/c1/encounters/1/candidates": () => ({ status: 200, body: { menu: { tripId: "t1", candidates: "nope" } } }),
      "GET /caravans/c1/encounters/1/formation": () => ({ status: 200, body: { formation: { manifestId: "m1", encounterIndex: 1, formation: { v: 3, fences: [], traps: [], posts: [{ ref: "u-rider", cell: { x: 12, y: 12 } }] }, hash: "h", gaps: [], committedAt: null } } }),
    });
    const api = createApi({ getToken: () => "tok", fetchImpl: ff.fetch });
    const ok = await api.manifest("c1");
    expect(ok.manifest!.survivors).toEqual(survivors);
    const fractional = (await api.manifest("c2").catch((e: unknown) => e)) as ApiError;
    expect(fractional.status).toBe(0);
    expect(fractional.code).toBe(BAD_PAYLOAD);
    expect(fractional.detail).toMatch(/^GET \/caravans\/c2\/manifest manifest\.survivors: expected manifest body/);
    const menu = (await api.candidates("c1", 1).catch((e: unknown) => e)) as ApiError;
    expect(menu.code).toBe(BAD_PAYLOAD);
    expect(menu.detail).toContain("menu.encounterIndex");
    // A post without a stance is legal (defaults to guard) and comes back canonical.
    const f = await api.formation("c1", 1);
    expect(f.formation.formation.posts).toEqual([{ ref: "u-rider", cell: { x: 12, y: 12 }, stance: "guard" }]);
  });
});
