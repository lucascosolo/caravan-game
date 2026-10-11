/**
 * Chunk 32: the admin dashboard page renders the server's recorded dashboard (the contract
 * fixture), every PROJECT.md §20 number with the panel(s) it is tuned against, one section per
 * panel, rates as text (a bar only beside the text), the band alarms in words; a 404 — what any
 * non-admin gets — shows "Not found." and nothing else. Nothing is stored in the browser.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.ts";
import { expectShape } from "../../api/shape.ts";
import { dashboardShape } from "../../api/telemetryShapes.ts";
import type { DashboardView } from "../../api/telemetryTypes.ts";
import { STRINGS } from "../../strings.ts";
import dashJson from "../../test/contract/admin-dashboard.json";
import { fakeApi } from "../../test/townFixtures.ts";
import { AdminScreen } from "./AdminScreen.tsx";

const dash = expectShape(dashboardShape, dashJson.body) as DashboardView;

afterEach(() => vi.restoreAllMocks());

describe("AdminScreen (chunk 32)", () => {
  it("renders the §20 table: all fourteen numbers, each naming panels that are on the page", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(<AdminScreen api={fakeApi({ adminDashboard: () => Promise.resolve(dash) })} />);
    const tuning = await screen.findByTestId("admin-tuning");
    const rows = within(tuning).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(14);
    expect(dash.tuning).toHaveLength(14);
    for (const t of dash.tuning) {
      expect(within(tuning).getByText(t.number)).toBeInTheDocument();
      for (const id of t.panels) {
        expect(screen.getByTestId(`panel-${id}`)).toBeInTheDocument();
        expect(STRINGS.admin.panels[id], id).toBeDefined();
      }
    }
    // Today's registry value is shown next to its key.
    expect(within(tuning).getByText(/WEEKLY_PAY_CEILING = 60000/)).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("has one section per panel the server sends, with the grind-wall deciles and the pool alarms in words", async () => {
    render(<AdminScreen api={fakeApi({ adminDashboard: () => Promise.resolve(dash) })} />);
    await screen.findByTestId("admin-screen");
    for (const id of Object.keys(dash.panels)) expect(screen.getByTestId(`panel-${id}`), id).toBeInTheDocument();
    const grind = screen.getByTestId("panel-grindWall");
    expect(within(grind).getAllByRole("row")).toHaveLength(1 + dash.panels.grindWall.deciles.length);
    expect(within(grind).getByText(/WEEKLY_PAY_CEILING 60000/)).toBeInTheDocument();
    const bands = screen.getByTestId("pool-bands");
    expect(within(bands).getAllByRole("row")).toHaveLength(1 + dash.panels.poolHealth.bands.length);
    expect(within(bands).getAllByText("ALARM: fewer than a full menu").length).toBe(dash.panels.poolHealth.bands.filter((b) => b.alarm === "empty").length);
    expect(screen.getByTestId("admin-alarms")).toHaveTextContent(STRINGS.admin.alarms(dash.panels.poolHealth.alarms));
    // A rate is always text; 2500 bp reads 25.00%.
    expect(within(screen.getByTestId("panel-overrunByBand")).getByText("25.00%")).toBeInTheDocument();
  });

  it("reloads with the chosen window", async () => {
    const calls: (number | undefined)[] = [];
    render(<AdminScreen api={fakeApi({ adminDashboard: (d) => (calls.push(d), Promise.resolve(dash)) })} />);
    await screen.findByTestId("admin-screen");
    await userEvent.setup().selectOptions(screen.getByTestId("admin-days"), "7");
    await waitFor(() => expect(calls).toEqual([30, 7]));
  });

  it("a 404 (anyone who is not an admin) says Not found and shows nothing of the dashboard", async () => {
    render(<AdminScreen api={fakeApi({ adminDashboard: () => Promise.reject(new ApiError(404, "not_found", "not found")) })} />);
    expect(await screen.findByTestId("admin-not-found")).toHaveTextContent("Not found.");
    expect(screen.queryByTestId("admin-tuning")).toBeNull();
    expect(screen.queryByText(STRINGS.admin.title)).toBeNull();
  });

  it("any other failure is the usual error box with a retry", async () => {
    let n = 0;
    render(<AdminScreen api={fakeApi({ adminDashboard: () => (n++ === 0 ? Promise.reject(new ApiError(0, "network", "offline")) : Promise.resolve(dash)) })} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("admin-screen")).toBeInTheDocument();
  });
});
