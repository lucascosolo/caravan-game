import { describe, expect, it } from "vitest";
import { parseHash } from "./router.tsx";

describe("hash router", () => {
  it("maps hashes to routes and falls back to town", () => {
    expect(parseHash("#/webs")).toBe("webs");
    expect(parseHash("#webs")).toBe("webs");
    expect(parseHash("#/trail?x=1")).toBe("trail");
    expect(parseHash("#/party/extra")).toBe("party");
    expect(parseHash("")).toBe("town");
    expect(parseHash("#/nope")).toBe("town");
  });
});
