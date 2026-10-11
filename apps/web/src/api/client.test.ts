import { describe, expect, it } from "vitest";
import { fakeFetch } from "../test/fixtures.ts";
import { ApiError, createApi } from "./client.ts";

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

  it("does not persist the token anywhere", () => {
    const ff = fakeFetch({});
    createApi({ getToken: () => "secret", fetchImpl: ff.fetch });
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(document.cookie).toBe("");
  });
});
