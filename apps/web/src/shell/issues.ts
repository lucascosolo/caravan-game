/**
 * Player-facing wording for server facts (chunk 08 QA S8 / S15, adopted by chunk 17).
 *
 * A server issue names things by id (`unit instance '0000…'`, `'desert.dust_rider'`). The
 * message is the server's and is shown, but every id the screen knows is replaced by the
 * name the player sees on screen, and the subject (when the server set one) leads the line.
 * A timestamp is shown in the player's locale, never as a raw ISO string.
 */
import type { IssueView } from "../api/types.ts";

export function humanizeText(text: string, names: ReadonlyMap<string, string>): string {
  let out = text;
  // Longest ids first so an id that prefixes another is not replaced inside it.
  for (const id of [...names.keys()].sort((a, b) => b.length - a.length)) {
    if (id.length === 0) continue;
    out = out.split(`'${id}'`).join(names.get(id)!).split(id).join(names.get(id)!);
  }
  return out;
}

export function humanizeIssue(issue: IssueView, names: ReadonlyMap<string, string>): string {
  const message = humanizeText(issue.message, names);
  const subject = issue.subject !== undefined ? names.get(issue.subject) : undefined;
  return subject && !message.includes(subject) ? `${subject}: ${message}` : message;
}

/** An ISO timestamp or epoch ms in the player's locale. */
export function formatWhen(when: string | number): string {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return String(when);
  try {
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return d.toLocaleString();
  }
}
