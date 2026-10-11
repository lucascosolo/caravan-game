/**
 * "Watch the fight" (chunk 22): the one entry point to the replay player, used by both
 * participants' screens — the caravan's encounter results on the Trail (chunk 23) and the
 * standing party's results feed on the Party tab (chunk 09). It opens the player in a
 * full-viewport dialog over the screen it was opened from, so closing it lands the player
 * back exactly where they were (the trip flow is never left).
 */
import { useState } from "react";
import type { Api } from "../../api/client.ts";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";
import { ReplayPlayer, type ReplaySettled } from "./ReplayPlayer.tsx";

const T = STRINGS.replay;

export interface WatchFightProps {
  readonly jobId: string;
  readonly encounterIndex: number;
  readonly label: string;
  readonly api?: Api;
  readonly settled?: ReplaySettled | null;
  readonly testId?: string;
  readonly className?: string;
  readonly describedBy?: string;
}

export function WatchFight({ jobId, encounterIndex, label, api, settled = null, testId = "watch-fight", className = "btn btn--block", describedBy }: WatchFightProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} data-testid={testId} aria-describedby={describedBy} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <Modal
          title={T.title(encounterIndex)}
          busy={false}
          size="full"
          testId="replay-dialog"
          onCancel={() => setOpen(false)}
          actions={
            <button type="button" className="btn" data-testid="replay-close" onClick={() => setOpen(false)}>
              {T.close}
            </button>
          }
        >
          <ReplayPlayer jobId={jobId} settled={settled} {...(api ? { api } : {})} />
        </Modal>
      )}
    </>
  );
}
