/**
 * A tiny typed `fetch` wrapper over the server's routes.
 *
 * The bearer token lives in memory only (the session context, src/auth/session.tsx) and is
 * read through `getToken` on every call. Nothing here touches localStorage or cookies.
 * Chunk 30: a reload gets back in through the server's HttpOnly device cookie, which this
 * code can neither read nor write — `resume()` asks the server to trade it for a fresh
 * bearer token (same-origin requests carry it; the page never sees its value).
 *
 * Every non-2xx response becomes an `ApiError` carrying the server's exact `{error,
 * message}` body, so a screen can surface the real reason (a 409 `insufficient_points`
 * says how many points the node costs and how many are available). The error's `issues`
 * (chunk 07's per-entry validation list) and the whole `body` (chunk 14's `reroll_cooldown`
 * carries `availableAtMs`) ride along, so a screen can show every particular exactly.
 *
 * Every 2xx body is checked against its shape (shapes.ts, QA-06 B1) before a screen sees
 * it: a body that is not JSON, or JSON of the wrong shape, becomes `ApiError(0,
 * "bad_payload")` with the offending path in `detail`. Screens render that like any other
 * error, with a Retry. Status 0 means "no usable answer from the server": `network` (fetch
 * threw) or `bad_payload`; `ErrorBox` (src/shell) words both for the player.
 */
import { ShapeError, expectShape, type Guard } from "./shape.ts";
import {
  authShape,
  choiceShape,
  economyShape,
  formationShape,
  manifestShape,
  meShape,
  menuShape,
  mergePreviewShape,
  mergeResultShape,
  partyFeedShape,
  partyShape,
  progressionShape,
  recruitResultShape,
  recruitViewShape,
  refugeeClaimShape,
  refugeeRefreshShape,
  refugeeRerollShape,
  refugeeViewShape,
  spendResultShape,
  unlocksShape,
  cosmeticsShape,
  equipResultShape,
  purchaseResultShape,
  purchasesShape,
  storeShape,
  unequipResultShape,
} from "./shapes.ts";
import { bankResultShape, encounterCommitShape, pushResultShape, stakesPreviewShape, tripStartShape, tripStatusShape } from "./tripShapes.ts";
import { recentFightsShape, replayShape } from "./replayShapes.ts";
import { inboxMarkResultShape, inboxShape, inboxStrikeLinesShape, inboxUnreadShape } from "./inboxShapes.ts";
import { analyticsSettingsShape, dashboardShape, telemetryIngestShape } from "./telemetryShapes.ts";
import type { AnalyticsSettings, DashboardView, TelemetryBatch, TelemetryIngestResult } from "./telemetryTypes.ts";
import type { InboxCategoryView, InboxMarkRequest, InboxMarkResult, InboxStrikeLinesView, InboxUnreadView, InboxView } from "./inboxTypes.ts";
import { onboardingChangeShape, onboardingShape, type OnboardingChange, type OnboardingResponse } from "../onboarding/shapes.ts";
import type { OnboardingStep } from "../onboarding/steps.ts";
import type { RecentFightsView, ReplayView } from "./replayTypes.ts";
import { accountViewShape, deleteResultShape, devicesShape, exportShape, linkResultShape, revokeOthersShape } from "./accountShapes.ts";
import type { AccountExport, AccountView, DeleteResult, DevicesView, LinkResult, RevokeOthersResult } from "./accountTypes.ts";
import type { BankResult, EncounterCommitResult, PushResult, StakesPreview, TripStartResult, TripStatusView } from "./tripTypes.ts";
import type {
  AuthResponse,
  ApiErrorBody,
  CandidateMenuResponse,
  ChoiceView,
  EconomyView,
  FormationBody,
  FormationResponse,
  IssueView,
  ManifestResponse,
  MeResponse,
  MergePreview,
  MergeRequest,
  MergeResultView,
  PackManifestRequest,
  PartyConfigBody,
  PartyFeedPage,
  PartyResponse,
  ProgressionResponse,
  RecruitResult,
  RecruitView,
  RefugeeClaimResult,
  RefugeeRefreshResult,
  RefugeeRerollResult,
  RefugeeView,
  SpendRequest,
  SpendResult,
  UnlocksResponse,
  CosmeticsView,
  EquipResult,
  PurchaseRequest,
  PurchaseResult,
  PurchasesList,
  StoreView,
  UnequipResult,
} from "./types.ts";

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "/api";

/** `code` of an `ApiError` with status 0 when `fetch` itself failed. */
export const NETWORK = "network";
/** `code` of an `ApiError` with status 0 when a 2xx body did not match its shape. */
export const BAD_PAYLOAD = "bad_payload";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Developer-facing particulars (a payload path, a thrown error's text); shown small under the code. */
    public readonly detail?: string,
    /** Chunk 07's validation errors carry every issue at once; surfaced exactly, never summarized. */
    public readonly issues: readonly IssueView[] = [],
    /** The whole error body as the server sent it (chunk 14's `reroll_cooldown` carries `availableAtMs`). */
    public readonly body: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  readonly getToken: () => string | null;
  /** Called on any 401 so the session can be dropped. */
  readonly onUnauthorized?: () => void;
  readonly fetchImpl?: typeof fetch;
  readonly base?: string;
}

export interface RegisterInput {
  readonly username: string;
  readonly password: string;
  readonly region: string;
  readonly caravanName?: string;
}

export interface Api {
  register(input: RegisterInput): Promise<AuthResponse>;
  login(username: string, password: string): Promise<AuthResponse>;
  /** Chunk 30: a guest's sign-out needs `abandon` (409 `guest_sign_out` otherwise — it would lose the account). */
  logout(abandon?: boolean): Promise<void>;
  // Account lifecycle (chunk 30 routes).
  /** First launch: a guest account (no username or password) with its first caravan in `region`. */
  guest(region: string, caravanName?: string): Promise<AuthResponse>;
  /** A reload: the server's device cookie for a fresh session. 401 `no_device` when there is none (never drops a session). */
  resume(): Promise<AuthResponse>;
  account(): Promise<AccountView>;
  linkAccount(username: string, password: string): Promise<LinkResult>;
  devices(): Promise<DevicesView>;
  revokeDevice(deviceId: string): Promise<void>;
  revokeOtherDevices(): Promise<RevokeOthersResult>;
  /** The whole export as the server sent it (its envelope checked), for the player to save. */
  exportAccount(): Promise<AccountExport & Record<string, unknown>>;
  /** 403 `wrong_password` / `password_required` (never 401: a wrong password does not sign anyone out). */
  deleteAccount(confirm: string, password?: string): Promise<DeleteResult>;
  me(): Promise<MeResponse>;
  unlocks(): Promise<UnlocksResponse>;
  progression(): Promise<ProgressionResponse>;
  spendUnlock(req: SpendRequest): Promise<SpendResult>;
  // Wagon circle (chunk 07 routes). All owner-only; a foreign caravan is a 404.
  packManifest(caravanId: string, req: PackManifestRequest): Promise<ManifestResponse>;
  manifest(caravanId: string): Promise<ManifestResponse>;
  saveFormation(caravanId: string, encounterIndex: number, formation: FormationBody): Promise<FormationResponse>;
  formation(caravanId: string, encounterIndex: number): Promise<FormationResponse>;
  commitFormation(caravanId: string, encounterIndex: number): Promise<FormationResponse>;
  // Matchmaking & scouting (chunk 14 routes). The reroll is free and time-gated: a 409
  // `reroll_cooldown` carries `availableAtMs` in `ApiError.body`; nothing here can shorten it.
  searchCandidates(caravanId: string, encounterIndex: number): Promise<CandidateMenuResponse>;
  candidates(caravanId: string, encounterIndex: number): Promise<CandidateMenuResponse>;
  chooseCandidate(caravanId: string, encounterIndex: number, candidateId: string): Promise<ChoiceView>;
  // The trip loop (chunk 15 routes, chunk 23 client). Start consumes one trip-cap use (409
  // `trip_cap_exhausted` carries `cap` + `retryAfterSeconds` in `ApiError.body`); commit freezes
  // the circle and queues its resolution; push / bank name the survived encounter they decide.
  tripStatus(caravanId: string): Promise<TripStatusView>;
  startTrip(caravanId: string): Promise<TripStartResult>;
  commitEncounter(caravanId: string, encounterIndex: number): Promise<EncounterCommitResult>;
  tripPreview(caravanId: string): Promise<StakesPreview>;
  pushTrip(caravanId: string, tripId: string, encounterIndex: number): Promise<PushResult>;
  bankTrip(caravanId: string, tripId: string, encounterIndex: number): Promise<BankResult>;
  // Economy & merging (chunk 16 routes), read by the Town tab (chunk 17). The preview is the
  // legibility contract: cost, balance (with pending trickle) and resulting stats before commit.
  // `prospectiveEarn` asks for the overflow forecast of a trip expected to earn that much.
  economy(prospectiveEarn?: number): Promise<EconomyView>;
  previewMerge(caravanId: string, instanceIds: readonly string[]): Promise<MergePreview>;
  commitMerge(caravanId: string, req: MergeRequest): Promise<MergeResultView>;
  // Unit acquisition (chunk 18 routes). GET never writes; `sequence` / `fromSequence` are
  // required on every write and come from the GET (chunk 18 QA S1).
  refugees(caravanId: string): Promise<RefugeeView>;
  claimRefugee(caravanId: string, unitTypeId: string, sequence: number): Promise<RefugeeClaimResult>;
  refreshRefugees(caravanId: string, fromSequence: number): Promise<RefugeeRefreshResult>;
  rerollRefugees(caravanId: string, fromSequence: number): Promise<RefugeeRerollResult>;
  recruitList(caravanId: string): Promise<RecruitView>;
  recruit(caravanId: string, unitTypeId: string, requestId: string): Promise<RecruitResult>;
  // Standing raid party (chunk 09 routes). Saving is free and instant; a 400 `invalid_party`
  // carries the full issue list in `ApiError.issues`.
  party(): Promise<PartyResponse>;
  saveParty(config: PartyConfigBody): Promise<PartyResponse>;
  partyFeed(before?: number): Promise<PartyFeedPage>;
  // Store & cosmetics (chunk 20 routes). SANDBOX: no real money moves. The purchase sends
  // back the previewed week and `contentsHash`; a 409 `offer_changed` means what would be
  // granted is no longer what was shown. A repeat of a tier in the same week answers 200
  // `{ replayed: true }` with the stored purchase, so resending the same body is safe.
  store(): Promise<StoreView>;
  purchasePack(req: PurchaseRequest): Promise<PurchaseResult>;
  storePurchases(): Promise<PurchasesList>;
  cosmetics(): Promise<CosmeticsView>;
  equipCosmetic(cosmeticId: string): Promise<EquipResult>;
  unequipCosmetic(slot: string): Promise<UnequipResult>;
  // The replay of a resolved encounter (chunk 13 route, chunk 22 player), for either
  // participant. 409 `not_resolved`, 410 `replay_expired`, 404 for anyone else.
  replay(jobId: string): Promise<ReplayView>;
  // Chunk 22 QA D2: the caravan's fights still kept by the replay retention rule, newest first.
  recentFights(): Promise<RecentFightsView>;
  // The in-app inbox (chunk 29 routes). Derived by the server; read state is the server's.
  inbox(): Promise<InboxView>;
  inboxUnread(): Promise<InboxUnreadView>;
  markInboxRead(req: InboxMarkRequest): Promise<InboxMarkResult>;
  /** One older strike batch's lines (the inbox itemizes only the newest batches). */
  inboxStrikes(window: number): Promise<InboxStrikeLinesView>;
  setInboxPreferences(preferences: Partial<Record<InboxCategoryView, boolean>>): Promise<InboxView>;
  // The first-session guide (chunk 24 routes). Account-level, forward-only; a marker of what the
  // player has seen, never a grant. Skip is refused (409 `onboarding_first_screen`) on the first screen.
  onboarding(): Promise<OnboardingResponse>;
  advanceOnboarding(step: OnboardingStep): Promise<OnboardingChange>;
  skipOnboarding(): Promise<OnboardingChange>;
  // Chunk 32: telemetry. Screen flow and crash reports only, keyed server-side by an opaque id;
  // the opt-out is an account setting the server honours (an opted-out batch is dropped).
  analyticsSettings(): Promise<AnalyticsSettings>;
  setAnalyticsOptOut(optedOut: boolean): Promise<AnalyticsSettings>;
  sendTelemetry(batch: TelemetryBatch): Promise<TelemetryIngestResult>;
  // The admin dashboard (404 for anyone who is not an admin).
  adminDashboard(days?: number): Promise<DashboardView>;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null && typeof (value as ApiErrorBody).error === "string";
}

function isIssue(value: unknown): value is IssueView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["code"] === "string" && typeof v["message"] === "string" && (v["subject"] === undefined || typeof v["subject"] === "string");
}

export function createApi(opts: ApiOptions): Api {
  const base = opts.base ?? API_BASE;
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  /** `shape` is the guard for a 2xx body; `null` for routes whose answer carries nothing. */
  async function request<T>(method: string, path: string, shape: Guard<T> | null, body?: unknown, flags: { readonly quiet401?: boolean; readonly keepBody?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = opts.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      // Chunk 30: same-origin requests carry the server's HttpOnly device cookie (resume / logout read it).
      const init: RequestInit = { method, headers, credentials: "same-origin" };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
      throw new ApiError(0, NETWORK, err instanceof Error ? err.message : "network error");
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      if (res.status === 401 && !flags.quiet401) opts.onUnauthorized?.();
      if (isErrorBody(parsed)) {
        const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isIssue) : [];
        throw new ApiError(res.status, parsed.error, parsed.message, undefined, issues, parsed as unknown as Record<string, unknown>);
      }
      throw new ApiError(res.status, "http_error", `${res.status} ${res.statusText}`.trim());
    }
    if (shape === null) return undefined as T;
    try {
      const checked = expectShape(shape, parsed);
      return flags.keepBody ? (parsed as T) : checked;
    } catch (err) {
      if (err instanceof ShapeError) throw new ApiError(0, BAD_PAYLOAD, `${method} ${path} ${err.message}`, `${method} ${path} ${err.message}`);
      throw err;
    }
  }

  const caravans = (caravanId: string): string => `/caravans/${encodeURIComponent(caravanId)}`;

  return {
    register: (input) => request("POST", "/auth/register", authShape, input),
    login: (username, password) => request("POST", "/auth/login", authShape, { username, password }),
    logout: (abandon) => request("POST", "/auth/logout", null, abandon ? { abandon: true } : undefined),
    guest: (region, caravanName) => request("POST", "/auth/guest", authShape, caravanName ? { region, caravanName } : { region }),
    resume: () => request("POST", "/auth/resume", authShape, undefined, { quiet401: true }),
    account: () => request("GET", "/me/account", accountViewShape),
    linkAccount: (username, password) => request("POST", "/me/account/link", linkResultShape, { username, password }),
    devices: () => request("GET", "/me/devices", devicesShape),
    revokeDevice: (deviceId) => request("DELETE", `/me/devices/${encodeURIComponent(deviceId)}`, null),
    revokeOtherDevices: () => request("POST", "/me/devices/revoke-others", revokeOthersShape),
    exportAccount: () => request("GET", "/me/export", exportShape, undefined, { keepBody: true }) as Promise<AccountExport & Record<string, unknown>>,
    deleteAccount: (confirm, password) => request("POST", "/me/account/delete", deleteResultShape, password === undefined ? { confirm } : { confirm, password }),
    me: () => request("GET", "/me", meShape),
    unlocks: () => request("GET", "/me/unlocks", unlocksShape),
    progression: () => request("GET", "/me/progression", progressionShape),
    spendUnlock: (req) => request("POST", "/me/unlocks/spend", spendResultShape, req),
    packManifest: (caravanId, req) => request("POST", `${caravans(caravanId)}/manifest`, manifestShape, req),
    manifest: (caravanId) => request("GET", `${caravans(caravanId)}/manifest`, manifestShape),
    saveFormation: (caravanId, n, formation) => request("PUT", `${caravans(caravanId)}/encounters/${n}/formation`, formationShape, formation),
    formation: (caravanId, n) => request("GET", `${caravans(caravanId)}/encounters/${n}/formation`, formationShape),
    commitFormation: (caravanId, n) => request("POST", `${caravans(caravanId)}/encounters/${n}/formation/commit`, formationShape),
    searchCandidates: (caravanId, n) => request("POST", `/me${caravans(caravanId)}/encounters/${n}/search`, menuShape),
    candidates: (caravanId, n) => request("GET", `/me${caravans(caravanId)}/encounters/${n}/candidates`, menuShape),
    chooseCandidate: (caravanId, n, candidateId) => request("POST", `/me${caravans(caravanId)}/encounters/${n}/choose`, choiceShape, { candidateId }),
    tripStatus: (caravanId) => request("GET", `/me${caravans(caravanId)}/trip`, tripStatusShape),
    startTrip: (caravanId) => request("POST", `/me${caravans(caravanId)}/trip/start`, tripStartShape),
    commitEncounter: (caravanId, n) => request("POST", `/me${caravans(caravanId)}/trip/encounters/${n}/commit`, encounterCommitShape),
    tripPreview: (caravanId) => request("GET", `/me${caravans(caravanId)}/trip/preview`, stakesPreviewShape),
    pushTrip: (caravanId, tripId, encounterIndex) => request("POST", `/me${caravans(caravanId)}/trip/push`, pushResultShape, { tripId, encounterIndex }),
    bankTrip: (caravanId, tripId, encounterIndex) => request("POST", `/me${caravans(caravanId)}/trip/bank`, bankResultShape, { tripId, encounterIndex }),
    economy: (prospectiveEarn) => request("GET", prospectiveEarn === undefined ? "/me/economy" : `/me/economy?prospectiveEarn=${Math.trunc(prospectiveEarn)}`, economyShape),
    previewMerge: (caravanId, instanceIds) => request("POST", `/me${caravans(caravanId)}/merge/preview`, mergePreviewShape, { instanceIds }),
    commitMerge: (caravanId, req) => request("POST", `/me${caravans(caravanId)}/merge`, mergeResultShape, req),
    refugees: (caravanId) => request("GET", `/me${caravans(caravanId)}/refugees`, refugeeViewShape),
    claimRefugee: (caravanId, unitTypeId, sequence) => request("POST", `/me${caravans(caravanId)}/refugees/claim`, refugeeClaimShape, { unitTypeId, sequence }),
    refreshRefugees: (caravanId, fromSequence) => request("POST", `/me${caravans(caravanId)}/refugees/refresh`, refugeeRefreshShape, { fromSequence }),
    rerollRefugees: (caravanId, fromSequence) => request("POST", `/me${caravans(caravanId)}/refugees/reroll`, refugeeRerollShape, { fromSequence }),
    recruitList: (caravanId) => request("GET", `/me${caravans(caravanId)}/recruit`, recruitViewShape),
    recruit: (caravanId, unitTypeId, requestId) => request("POST", `/me${caravans(caravanId)}/recruit`, recruitResultShape, { unitTypeId, requestId }),
    party: () => request("GET", "/me/party", partyShape),
    saveParty: (config) => request("PUT", "/me/party", partyShape, config),
    partyFeed: (before) => request("GET", before === undefined ? "/me/party/feed" : `/me/party/feed?before=${Math.trunc(before)}`, partyFeedShape),
    store: () => request("GET", "/me/store", storeShape),
    purchasePack: (req) => request("POST", "/me/store/purchase", purchaseResultShape, { tier: req.tier, weekIndex: req.weekIndex, contentsHash: req.contentsHash }),
    storePurchases: () => request("GET", "/me/store/purchases", purchasesShape),
    cosmetics: () => request("GET", "/me/cosmetics", cosmeticsShape),
    equipCosmetic: (cosmeticId) => request("POST", "/me/cosmetics/equip", equipResultShape, { cosmeticId }),
    unequipCosmetic: (slot) => request("POST", "/me/cosmetics/unequip", unequipResultShape, { slot }),
    replay: (jobId) => request("GET", `/me/encounters/${encodeURIComponent(jobId)}/replay`, replayShape),
    recentFights: () => request("GET", "/me/encounters", recentFightsShape),
    inbox: () => request("GET", "/me/inbox", inboxShape),
    inboxUnread: () => request("GET", "/me/inbox/unread", inboxUnreadShape),
    markInboxRead: (req) => request("POST", "/me/inbox/read", inboxMarkResultShape, req),
    inboxStrikes: (window) => request("GET", `/me/inbox/strikes/${encodeURIComponent(String(window))}`, inboxStrikeLinesShape),
    setInboxPreferences: (preferences) => request("PUT", "/me/inbox/preferences", inboxShape, { preferences }),
    onboarding: () => request("GET", "/me/onboarding", onboardingShape),
    advanceOnboarding: (step) => request("POST", "/me/onboarding/advance", onboardingChangeShape, { step }),
    skipOnboarding: () => request("POST", "/me/onboarding/skip", onboardingChangeShape),
    analyticsSettings: () => request("GET", "/me/analytics", analyticsSettingsShape),
    setAnalyticsOptOut: (optedOut) => request("PUT", "/me/analytics", analyticsSettingsShape, { optedOut }),
    sendTelemetry: (batch) => request("POST", "/me/telemetry", telemetryIngestShape, { session: batch.session, seq: batch.seq, events: batch.events }),
    adminDashboard: (days) => request("GET", days === undefined ? "/admin/dashboard" : `/admin/dashboard?days=${Math.trunc(days)}`, dashboardShape),
  };
}
