/**
 * Chunk 30: guest-first launch, the reload resume, and the Account screen (link, devices,
 * export, sign-out, delete). Bodies are the server's recorded contract fixtures where one
 * exists. No browser storage is written by any of it.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectShape } from "../../api/shape.ts";
import { accountViewShape, devicesShape } from "../../api/accountShapes.ts";
import { App } from "../../App.tsx";
import accountGuestJson from "../../test/contract/account-guest.json";
import accountJson from "../../test/contract/account.json";
import authGuestJson from "../../test/contract/auth-guest.json";
import linkJson from "../../test/contract/account-link.json";
import deleteJson from "../../test/contract/account-delete.json";
import exportJson from "../../test/contract/export.json";
import { fakeFetch, meResponse, type Call, type Handler } from "../../test/fixtures.ts";
import { STRINGS } from "../../strings.ts";
import { ONBOARDING_STEPS } from "../../onboarding/steps.ts";

// The town draws on the canvas; here it is a stand-in so the shell and the account flow are what is under test.
vi.mock("../town/TownScreen.tsx", () => ({ TownScreen: () => <section data-testid="town-screen">town</section> }));

const A = STRINGS.account;
const done = { onboarding: { step: "done", steps: [...ONBOARDING_STEPS], enrolled: true, completed: true, skipped: false, canSkip: false, updatedAt: null } };

function server(extra: Record<string, Handler> = {}) {
  return fakeFetch({
    "POST /auth/resume": () => ({ status: 401, body: { error: "no_device", message: "no signed-in device here" } }),
    "POST /auth/guest": () => ({ status: 201, body: authGuestJson.body }),
    "GET /me/onboarding": () => ({ status: 200, body: done }),
    "GET /me": () => ({ status: 200, body: { ...meResponse(), account: { id: "g", username: null, guest: true } } }),
    "GET /me/inbox/unread": () => ({ status: 200, body: { unreadCount: 0, latestAtMs: null } }),
    "GET /me/account": () => ({ status: 200, body: accountGuestJson.body }),
    ...extra,
  });
}

let setItem: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  window.history.replaceState(null, "", "#/town");
  setItem = vi.spyOn(Storage.prototype, "setItem");
});
afterEach(() => vi.restoreAllMocks());

describe("first launch is guest-first (chunk 30)", () => {
  it("with no device cookie: the start card asks only for the region, and one tap makes a guest account — no username, no password, nothing stored", async () => {
    const user = userEvent.setup();
    const s = server();
    render(<App fetchImpl={s.fetch} autoResume />);
    const start = await screen.findByTestId("guest-start");
    expect(within(start).queryByLabelText(STRINGS.auth.username)).toBeNull();
    expect(within(start).queryByLabelText(STRINGS.auth.password)).toBeNull();
    expect(within(start).getByText(STRINGS.auth.regionHint)).toBeInTheDocument();
    await user.selectOptions(within(start).getByRole("combobox"), "badlands");
    await user.click(within(start).getByRole("button", { name: STRINGS.auth.submitStart }));
    expect(await screen.findByTestId("guest-badge")).toHaveTextContent(A.guestBadge);
    // Final play-test review N8: the caravan gets a generated name; still no username, no password.
    expect(s.calls.find((c) => c.path === "/auth/guest")!.body).toEqual({ region: "badlands", caravanName: expect.any(String) });
    // A guest has no one-tap sign-out (it would lose the account); the Account screen is offered instead.
    expect(screen.queryByRole("button", { name: STRINGS.app.signOut })).toBeNull();
    expect(screen.getByRole("button", { name: A.open })).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("final play-test review r3 N10a: the cold resume asks ?ifNone=null, and 200 { session: null } is the start screen with no 401 and no retry card", async () => {
    const s = server({ "POST /auth/resume": () => ({ status: 200, body: { session: null } }) });
    render(<App fetchImpl={s.fetch} autoResume />);
    expect(await screen.findByTestId("guest-start")).toBeInTheDocument();
    expect(screen.queryByTestId("resume-failed")).toBeNull();
    expect(s.calls.find((c) => c.path.split("?")[0] === "/auth/resume")!.path).toBe("/auth/resume?ifNone=null");
  });

  it("a reload with a device cookie resumes straight into the game; the page never sees the cookie", async () => {
    const s = server({ "POST /auth/resume": () => ({ status: 200, body: authGuestJson.body }) });
    render(<App fetchImpl={s.fetch} autoResume />);
    expect(await screen.findByTestId("guest-badge")).toBeInTheDocument();
    expect(s.calls.filter((c) => c.path === "/auth/guest")).toHaveLength(0);
    const resume = s.calls.find((c) => c.path.split("?")[0] === "/auth/resume")!;
    expect(resume.method).toBe("POST");
    expect(Object.keys(resume.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
  });
});

describe("Account screen", () => {
  async function openAccount(extra: Record<string, Handler> = {}) {
    window.history.replaceState(null, "", "#/account");
    const s = server({ "POST /auth/resume": () => ({ status: 200, body: authGuestJson.body }), ...extra });
    render(<App fetchImpl={s.fetch} autoResume />);
    await screen.findByTestId("account-screen");
    return s;
  }

  it("a guest is warned and links a username + password to the same account; the header then names it", async () => {
    const user = userEvent.setup();
    const s = await openAccount({ "POST /me/account/link": () => ({ status: 200, body: linkJson.body }) });
    const card = screen.getByTestId("link-card");
    expect(card).toHaveTextContent(A.guestWarning);
    await user.type(within(card).getByLabelText(STRINGS.auth.username), "contract_guest");
    await user.type(within(card).getByLabelText(STRINGS.auth.password), "correct horse battery");
    await user.click(within(card).getByRole("button", { name: A.linkSubmit }));
    expect(await screen.findByText(A.linked("contract_guest"))).toBeInTheDocument();
    expect(s.calls.find((c) => c.path === "/me/account/link")!.body).toEqual({ username: "contract_guest", password: "correct horse battery" });
    await waitFor(() => expect(screen.queryByTestId("guest-badge")).toBeNull());
    expect(screen.getByText("contract_guest", { selector: ".shell__who" })).toBeInTheDocument();
    // Now deletion asks for the password too.
    expect(within(screen.getByTestId("delete-card")).getByLabelText(A.deletePassword)).toBeInTheDocument();
  });

  it("shows the server's link refusal exactly", async () => {
    const user = userEvent.setup();
    await openAccount({ "POST /me/account/link": () => ({ status: 409, body: { error: "username_taken", message: "username 'x' is taken" } }) });
    const card = screen.getByTestId("link-card");
    await user.type(within(card).getByLabelText(STRINGS.auth.username), "x_taken");
    await user.type(within(card).getByLabelText(STRINGS.auth.password), "correct horse battery");
    await user.click(within(card).getByRole("button", { name: A.linkSubmit }));
    expect(await within(card).findByText("username 'x' is taken")).toBeInTheDocument();
  });

  it("lists devices, flags this one, and signs another out (then re-reads the list from the server)", async () => {
    const user = userEvent.setup();
    const two = { ...accountJson.body, devices: [...accountJson.body.devices, { id: "00000000-0000-4000-8000-0000000000aa", label: "Safari on iOS", createdAt: "2026-10-11T12:00:00.000Z", lastSeenAt: "2026-10-11T12:00:00.000Z", expiresAt: "2027-04-11T12:00:00.000Z", current: false }] };
    const s = await openAccount({
      "GET /me/account": () => ({ status: 200, body: two }),
      "DELETE /me/devices/00000000-0000-4000-8000-0000000000aa": () => ({ status: 204 }),
      "GET /me/devices": () => ({ status: 200, body: { devices: accountJson.body.devices } }),
    });
    const rows = screen.getAllByTestId("device-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(A.thisDevice);
    await user.click(screen.getByRole("button", { name: `${A.revoke}: Safari on iOS` }));
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(1));
    expect(s.calls.some((c: Call) => c.method === "DELETE")).toBe(true);
    expect(screen.getByText(A.noOtherDevices)).toBeInTheDocument();
  });

  it("downloads the export as the server sent it", async () => {
    const user = userEvent.setup();
    const saved: { name: string; text: string }[] = [];
    window.history.replaceState(null, "", "#/account");
    const s = server({ "POST /auth/resume": () => ({ status: 200, body: authGuestJson.body }), "GET /me/export": () => ({ status: 200, body: exportJson.body }) });
    const { AccountScreen } = await import("./AccountScreen.tsx");
    const { SessionProvider } = await import("../../auth/session.tsx");
    render(
      <SessionProvider fetchImpl={s.fetch} autoResume>
        <AccountScreen saveFile={(name, text) => saved.push({ name, text })} />
      </SessionProvider>,
    );
    await user.click(await screen.findByRole("button", { name: A.exportSubmit }));
    expect(await screen.findByText(A.exported)).toBeInTheDocument();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/^caravan-vaults-export-.+\.json$/);
    // The whole body, not just the checked envelope.
    expect(JSON.parse(saved[0]!.text)).toEqual(exportJson.body);
  });

  it("delete stays disabled until the exact phrase is typed; then it deletes and the start screen comes back", async () => {
    const user = userEvent.setup();
    const s = await openAccount({ "POST /me/account/delete": () => ({ status: 200, body: deleteJson.body }) });
    const card = screen.getByTestId("delete-card");
    const button = within(card).getByRole("button", { name: A.deleteSubmit });
    expect(button).toBeDisabled();
    await user.type(within(card).getByLabelText(A.deleteConfirmLabel("delete my account")), "delete my");
    expect(button).toBeDisabled();
    await user.type(within(card).getByLabelText(A.deleteConfirmLabel("delete my account")), " account");
    expect(button).toBeEnabled();
    await user.click(button);
    expect(await screen.findByTestId("guest-start")).toBeInTheDocument();
    // QA-30 D5: the player is told, not dropped silently on the start card.
    expect(screen.getByTestId("start-notice")).toHaveTextContent(A.deleted);
    expect(s.calls.find((c) => c.path === "/me/account/delete")!.body).toEqual({ confirm: "delete my account" });
  });

  it("a wrong password on delete is shown and keeps the player signed in", async () => {
    const user = userEvent.setup();
    await openAccount({
      "GET /me/account": () => ({ status: 200, body: accountJson.body }),
      "POST /me/account/delete": () => ({ status: 403, body: { error: "wrong_password", message: "that password is not this account's" } }),
    });
    const card = screen.getByTestId("delete-card");
    await user.type(within(card).getByLabelText(A.deleteConfirmLabel("delete my account")), "delete my account");
    await user.type(within(card).getByLabelText(A.deletePassword), "nope nope");
    await user.click(within(card).getByRole("button", { name: A.deleteSubmit }));
    expect(await within(card).findByText("that password is not this account's")).toBeInTheDocument();
    expect(screen.getByTestId("account-screen")).toBeInTheDocument();
  });

  it("leaving a guest account asks first, and only then sends abandon: true", async () => {
    const user = userEvent.setup();
    const s = await openAccount({ "POST /auth/logout": () => ({ status: 204 }) });
    await user.click(screen.getByRole("button", { name: A.signOutGuest }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(A.signOutGuestConfirm);
    expect(s.calls.some((c) => c.path === "/auth/logout")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: A.signOutGuest }));
    await screen.findByTestId("guest-start");
    expect(s.calls.find((c) => c.path === "/auth/logout")!.body).toEqual({ abandon: true });
    // QA-30 D2: leaving a guest account deletes it, and the copy says so.
    expect(dialog).toHaveTextContent(/deletes it/);
    expect(screen.getByTestId("start-notice")).toHaveTextContent(A.guestLeft);
  });
});

describe("QA-30 S4 / D1 / N4: resume failures, many tabs, a guest already on the device, the save prompt", () => {
  it("a resume that fails with a 5xx (or the network) shows a retry state, never the start screen; Retry gets back in", async () => {
    const user = userEvent.setup();
    let down = true;
    const s = server({ "POST /auth/resume": () => (down ? { status: 503, body: { error: "unavailable", message: "try later" } } : { status: 200, body: authGuestJson.body }) });
    render(<App fetchImpl={s.fetch} autoResume />);
    expect(await screen.findByTestId("resume-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("guest-start")).toBeNull();
    expect(screen.queryByRole("button", { name: STRINGS.auth.submitStart })).toBeNull();
    down = false;
    await user.click(screen.getByRole("button", { name: STRINGS.app.retry }));
    expect(await screen.findByTestId("guest-badge")).toBeInTheDocument();
  });

  it("parallel 401s on one evicted token cost ONE resume, and the tab is back in the game, not on the start card", async () => {
    window.history.replaceState(null, "", "#/account");
    let resumes = 0;
    const tokenOf = (c: Call) => (c.headers["Authorization"] ?? "").replace("Bearer ", "");
    const guarded = (body: unknown): Handler => (c) => (tokenOf(c) === "t1" ? { status: 401, body: { error: "unauthorized", message: "unauthorized" } } : { status: 200, body });
    const s = server({
      "POST /auth/resume": () => {
        resumes += 1;
        return { status: 200, body: { ...authGuestJson.body, token: resumes === 1 ? "t1" : "t2" } };
      },
      "GET /me/account": guarded(accountGuestJson.body),
      "GET /me/inbox/unread": guarded({ unreadCount: 0, latestAtMs: null }),
      "GET /me/onboarding": guarded(done),
    });
    render(<App fetchImpl={s.fetch} autoResume />);
    expect(await screen.findByTestId("account-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("guest-start")).toBeNull();
    expect(resumes).toBe(2);
  });

  it("five resumes in a row (five tabs) each get in", async () => {
    for (let i = 0; i < 5; i++) {
      const s = server({ "POST /auth/resume": () => ({ status: 200, body: { ...authGuestJson.body, token: `tab${i}` } }) });
      const { unmount } = render(<App fetchImpl={s.fetch} autoResume />);
      expect(await screen.findByTestId("guest-badge")).toBeInTheDocument();
      expect(s.calls.filter((c) => c.path.split("?")[0] === "/auth/resume")[0]!.body).toEqual({});
      unmount();
    }
  });

  it("'Start playing' on a device that holds a guest asks first; deleting it re-sends with replaceGuest, continuing resumes", async () => {
    const user = userEvent.setup();
    let asked = 0;
    const s = server({
      "POST /auth/guest": (c: Call) => {
        if ((c.body as { replaceGuest?: boolean }).replaceGuest !== true) {
          asked += 1;
          return { status: 409, body: { error: "guest_on_device", message: "this device holds a guest caravan" } };
        }
        return { status: 201, body: authGuestJson.body };
      },
    });
    render(<App fetchImpl={s.fetch} autoResume />);
    await user.click(within(await screen.findByTestId("guest-start")).getByRole("button", { name: STRINGS.auth.submitStart }));
    const card = await screen.findByTestId("guest-on-device");
    expect(card).toHaveTextContent(STRINGS.auth.guestOnDeviceBody);
    await user.click(within(card).getByRole("button", { name: STRINGS.auth.replaceGuestStart }));
    expect(await screen.findByTestId("guest-badge")).toBeInTheDocument();
    expect(asked).toBe(1);
    expect(s.calls.filter((c) => c.path === "/auth/guest").map((c) => (c.body as { replaceGuest?: boolean }).replaceGuest ?? false)).toEqual([false, true]);
  });

  it("a guest sees the non-blocking save prompt in town (Not now hides it); a linked player never does; the welcome screen has no Account button", async () => {
    const user = userEvent.setup();
    const s = server({ "POST /auth/resume": () => ({ status: 200, body: authGuestJson.body }) });
    const { unmount } = render(<App fetchImpl={s.fetch} autoResume />);
    const prompt = await screen.findByTestId("guest-save-prompt");
    expect(prompt).toHaveTextContent(A.savePromptTitle);
    expect(screen.getByTestId("town-screen")).toBeInTheDocument();
    await user.click(within(prompt).getByRole("button", { name: A.savePromptDismiss }));
    expect(screen.queryByTestId("guest-save-prompt")).toBeNull();
    unmount();
    const linked = server({ "POST /auth/resume": () => ({ status: 200, body: { ...authGuestJson.body, account: { ...authGuestJson.body.account, username: "dev", guest: false } } }) });
    const r2 = render(<App fetchImpl={linked.fetch} autoResume />);
    await screen.findByTestId("town-screen");
    expect(screen.queryByTestId("guest-save-prompt")).toBeNull();
    r2.unmount();
    const welcome = server({
      "POST /auth/resume": () => ({ status: 200, body: authGuestJson.body }),
      "GET /me/onboarding": () => ({ status: 200, body: { onboarding: { ...done.onboarding, step: "welcome", completed: false } } }),
    });
    render(<App fetchImpl={welcome.fetch} autoResume />);
    await screen.findByTestId("onboarding-welcome");
    expect(screen.queryByRole("button", { name: A.open })).toBeNull();
  });
});

describe("final play-test review r2 S1: sign-outs", () => {
  const unauthorized = { status: 401, body: { error: "unauthorized", message: "unauthorized" } };

  it("a resume that answers 200 but whose sessions keep dying ends on the retry card, never the start screen; Retry gets back in", async () => {
    const user = userEvent.setup();
    let evicting = true;
    let resumes = 0;
    const live = (body: unknown): Handler => () => (evicting ? unauthorized : { status: 200, body });
    const s = server({
      "POST /auth/resume": () => {
        resumes += 1;
        return { status: 200, body: { ...authGuestJson.body, token: `t${resumes}` } };
      },
      "GET /me": live({ ...meResponse(), account: { id: "g", username: null, guest: true } }),
      "GET /me/onboarding": live(done),
      "GET /me/inbox/unread": live({ unreadCount: 0, latestAtMs: null }),
    });
    render(<App fetchImpl={s.fetch} autoResume />);
    expect(await screen.findByTestId("resume-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("guest-start")).toBeNull();
    expect(screen.queryByRole("button", { name: STRINGS.auth.submitStart })).toBeNull();
    const before = resumes;
    expect(before).toBeLessThanOrEqual(5);
    evicting = false;
    await user.click(screen.getByRole("button", { name: STRINGS.app.retry }));
    expect(await screen.findByTestId("guest-badge")).toBeInTheDocument();
  });

  it("only a 401 no_device shows the start screen; any other resume refusal (a 401 of another kind, a 429) is a retry", async () => {
    for (const refusal of [unauthorized, { status: 429, body: { error: "rate_limited", message: "slow down" } }]) {
      const s = server({ "POST /auth/resume": () => refusal });
      const { unmount } = render(<App fetchImpl={s.fetch} autoResume />);
      expect(await screen.findByTestId("resume-failed")).toBeInTheDocument();
      expect(screen.queryByTestId("guest-start")).toBeNull();
      unmount();
    }
  });

  it("asks the server to resume once per launch, even under StrictMode's double effects", async () => {
    const { StrictMode } = await import("react");
    const s = server({ "POST /auth/resume": () => ({ status: 200, body: authGuestJson.body }) });
    render(
      <StrictMode>
        <App fetchImpl={s.fetch} autoResume />
      </StrictMode>,
    );
    expect(await screen.findByTestId("guest-badge")).toBeInTheDocument();
    expect(s.calls.filter((c) => c.path.split("?")[0] === "/auth/resume")).toHaveLength(1);
  });

  it("'Continue the guest caravan' never silently drops back to the start screen: a failed continue says so, and Retry gets in", async () => {
    const user = userEvent.setup();
    let resumeOk = false;
    const s = server({
      "POST /auth/resume": () => (resumeOk ? { status: 200, body: authGuestJson.body } : { status: 401, body: { error: "no_device", message: "no signed-in device here" } }),
      "POST /auth/guest": () => ({ status: 409, body: { error: "guest_on_device", message: "this device holds a guest caravan" } }),
    });
    render(<App fetchImpl={s.fetch} autoResume />);
    await user.click(within(await screen.findByTestId("guest-start")).getByRole("button", { name: STRINGS.auth.submitStart }));
    const card = await screen.findByTestId("guest-on-device");
    await user.click(within(card).getByRole("button", { name: STRINGS.auth.continueGuest }));
    expect(await screen.findByTestId("continue-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("guest-start")).toBeNull();
    resumeOk = true;
    await user.click(screen.getByRole("button", { name: STRINGS.app.retry }));
    expect(await screen.findByTestId("guest-badge")).toBeInTheDocument();
  });

  it("'Continue the guest caravan' resumes straight into the game when the device answers", async () => {
    const user = userEvent.setup();
    let resumes = 0;
    const s = server({
      "POST /auth/resume": () => {
        resumes += 1;
        return resumes === 1 ? { status: 401, body: { error: "no_device", message: "no signed-in device here" } } : { status: 200, body: authGuestJson.body };
      },
      "POST /auth/guest": () => ({ status: 409, body: { error: "guest_on_device", message: "this device holds a guest caravan" } }),
    });
    render(<App fetchImpl={s.fetch} autoResume />);
    await user.click(within(await screen.findByTestId("guest-start")).getByRole("button", { name: STRINGS.auth.submitStart }));
    await user.click(within(await screen.findByTestId("guest-on-device")).getByRole("button", { name: STRINGS.auth.continueGuest }));
    expect(await screen.findByTestId("guest-badge")).toBeInTheDocument();
    expect(s.calls.filter((c) => c.path === "/auth/guest")).toHaveLength(1);
  });
});

describe("account guards", () => {
  it("accept the recorded bodies and refuse a device row that carries a credential", () => {
    expect(expectShape(accountViewShape, accountGuestJson.body).account.guest).toBe(true);
    expect(() => expectShape(devicesShape, { devices: [{ ...accountJson.body.devices[0], token_hash: "abc" }] })).toThrow(/credential/);
  });
});
