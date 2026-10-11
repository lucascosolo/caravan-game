/**
 * Guards for chunk 30's account routes, typed against accountTypes.ts. Same rules as shapes.ts:
 * lists bounded, extra fields ignored. A device row that carries a token or hash is REFUSED:
 * the server must never send a credential back, and a client that quietly accepted one would
 * hide the leak.
 */
import { ShapeError, array, boolean, integer, literal, nullable, object, string, type Guard } from "./shape.ts";
import type { AccountDetail, AccountExport, AccountView, DeleteResult, DeviceView, DevicesView, LinkResult, RevokeOthersResult } from "./accountTypes.ts";

const ID = string({ maxLength: 128 });
const NAME = string({ maxLength: 256 });
const TIMESTAMP = string({ maxLength: 64 });

const device: Guard<DeviceView> = (v, path) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of ["token", "tokenHash", "token_hash"]) {
      if (k in v) throw new ShapeError(`${path}.${k}`, "no credential in a device row", "(redacted)");
    }
  }
  return object({ id: ID, label: string({ maxLength: 120 }), createdAt: TIMESTAMP, lastSeenAt: TIMESTAMP, expiresAt: TIMESTAMP, current: boolean() })(v, path);
};

const accountDetail: Guard<AccountDetail> = object({ id: ID, username: nullable(NAME), guest: boolean(), linkedAt: nullable(TIMESTAMP) });

export const accountViewShape: Guard<AccountView> = object({
  account: accountDetail,
  devices: array(device, { maxLength: 64 }),
  deletion: object({ confirmPhrase: string({ maxLength: 64 }), requiresPassword: boolean() }),
});

export const linkResultShape: Guard<LinkResult> = object({ account: accountDetail });

export const devicesShape: Guard<DevicesView> = object({ devices: array(device, { maxLength: 64 }) });

export const revokeOthersShape: Guard<RevokeOthersResult> = object({ revoked: integer({ min: 0, max: 10_000 }) });

const counts: Guard<Readonly<Record<string, number>>> = (v, path) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ShapeError(path, "an object of counts", v);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) out[k] = integer({ min: 0 })(n, `${path}.${k}`);
  return out;
};

export const deleteResultShape: Guard<DeleteResult> = object({ deleted: literal(true), counts });

export const exportShape: Guard<AccountExport> = object({
  format: literal("caravan-vaults-account-export"),
  version: integer({ min: 1, max: 1000 }),
  exportedAt: TIMESTAMP,
  account: object({ id: ID, username: nullable(NAME), guest: boolean() }),
});
