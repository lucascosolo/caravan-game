/**
 * Final play-test review r2 D2: the Town's "Your standing party is down" banner, with one-tap
 * "Raise from my roster" through the server's suggested party and the ordinary PUT /me/party.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../api/client.ts";
import { expectShape } from "../../api/shape.ts";
import { partyShape } from "../../api/shapes.ts";
import type { PartyConfigBody, PartyView } from "../../api/types.ts";
import partyJson from "../../test/contract/party.json";
import { STRINGS } from "../../strings.ts";
import { PartyDownBanner, raiseConfig } from "./PartyDownBanner.tsx";

const T = STRINGS.town;
const recorded = expectShape(partyShape, (partyJson as { body: unknown }).body).party;
const down = (over: Partial<PartyView> = {}): PartyView => ({ ...recorded, config: { ...recorded.config, units: [], siege: [] }, ...over });

function fakeApi(view: PartyView) {
  const saved: PartyConfigBody[] = [];
  const api = {
    party: vi.fn(async () => ({ party: view })),
    saveParty: vi.fn(async (config: PartyConfigBody) => {
      saved.push(config);
      return { party: { ...view, config } };
    }),
  } as unknown as Api;
  return { api, saved };
}

describe("PartyDownBanner (r2 D2)", () => {
  it("says the party is down and raises it in one tap with the server's suggested party", async () => {
    const user = userEvent.setup();
    const view = down();
    const { api, saved } = fakeApi(view);
    render(<PartyDownBanner api={api} guideActive={false} rosterVersion={1} />);
    const banner = await screen.findByTestId("party-down-banner");
    expect(banner).toHaveTextContent(T.partyDownTitle);
    await user.click(screen.getByTestId("party-down-raise"));
    expect(await screen.findByTestId("party-raised-banner")).toHaveTextContent("Your standing party is up again");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(view.suggested);
  });

  it("falls back to the guide's own prefill when the server sends no suggestion (an older server)", () => {
    const config = raiseConfig(down({ suggested: undefined }));
    expect(config!.units.length).toBeGreaterThan(0);
  });

  it("is silent while the party fields a unit, while the guide runs, and when the read fails", async () => {
    const { api } = fakeApi(recorded);
    const { unmount } = render(<PartyDownBanner api={api} guideActive={false} rosterVersion={1} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("party-down-banner")).toBeNull();
    unmount();
    const guided = fakeApi(down());
    const r2 = render(<PartyDownBanner api={guided.api} guideActive rosterVersion={1} />);
    expect(screen.queryByTestId("party-down-banner")).toBeNull();
    expect(guided.api.party).not.toHaveBeenCalled();
    r2.unmount();
    const broken = { party: vi.fn(async () => Promise.reject(new Error("down"))), saveParty: vi.fn() } as unknown as Api;
    render(<PartyDownBanner api={broken} guideActive={false} rosterVersion={1} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("party-down-banner")).toBeNull();
  });

  it("with no unlocked unit to raise from, says so and offers no raise button", async () => {
    const view = down({ suggested: null, roster: [] });
    const { api } = fakeApi(view);
    render(<PartyDownBanner api={api} guideActive={false} rosterVersion={0} />);
    expect(await screen.findByTestId("party-down-banner")).toHaveTextContent(T.partyDownNoUnits);
    expect(screen.queryByTestId("party-down-raise")).toBeNull();
  });
});
