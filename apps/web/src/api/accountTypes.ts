/**
 * Chunk 30: the account lifecycle routes' bodies (apps/server/src/routes/account.ts).
 */
import type { AccountPublic } from "./types.ts";

export interface DeviceView {
  readonly id: string;
  /** "Firefox on Android": browser and platform, nothing finer. */
  readonly label: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  /** The device this request came from. */
  readonly current: boolean;
}

export interface AccountDetail extends AccountPublic {
  readonly guest: boolean;
  readonly linkedAt: string | null;
}

export interface AccountView {
  readonly account: AccountDetail;
  readonly devices: readonly DeviceView[];
  /** What the delete request must carry: the phrase always, the password once one exists. */
  readonly deletion: { readonly confirmPhrase: string; readonly requiresPassword: boolean };
}

export interface LinkResult {
  readonly account: AccountDetail;
}

export interface DevicesView {
  readonly devices: readonly DeviceView[];
}

export interface RevokeOthersResult {
  readonly revoked: number;
}

export interface DeleteResult {
  readonly deleted: true;
  readonly counts: Readonly<Record<string, number>>;
}

/** The export is the player's own file: the client checks its envelope and hands the rest over untouched. */
export interface AccountExport {
  readonly format: "caravan-vaults-account-export";
  readonly version: number;
  readonly exportedAt: string;
  readonly account: { readonly id: string; readonly username: string | null; readonly guest: boolean };
}
