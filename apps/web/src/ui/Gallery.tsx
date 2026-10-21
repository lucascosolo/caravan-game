/**
 * Dev-only visual check of the kit components (C4a): `pnpm dev:web`, then /gallery.html. Not part of the
 * production build (vite builds index.html only). ?sheet=1 opens the confirm sheet.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../theme.css";
import "./kit.css";
import { SessionProvider } from "../auth/session.tsx";
import { AppShell } from "../shell/AppShell.tsx";
import { HudPortal } from "../shell/HudPortal.tsx";
import { Button, CommitBanner } from "./Button.tsx";
import { Chip } from "./ChipStrap.tsx";
import { Icon } from "./Icon.tsx";
import { Medallion } from "./Medallion.tsx";
import { Note } from "./Note.tsx";
import { Pop } from "./Pop.tsx";
import { Poster } from "./Poster.tsx";
import { Sheet } from "./Sheet.tsx";
import { Sign } from "./Sign.tsx";
import { Toast } from "./Toast.tsx";

function Gallery(): JSX.Element {
  const [sheet, setSheet] = useState(new URLSearchParams(location.search).has("sheet"));
  const [stance, setStance] = useState("hold");
  return (
    <AppShell route="town" username="dusty_pete">
      <HudPortal>
        <Chip kind="badge" icon="strongbox" label="Vault" value="3" />
        <Chip kind="purse" icon="coin" label="Coin" value="1,693" />
      </HudPortal>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Sign onClick={() => undefined}>Mercenaries</Sign>
          <Sign variant="rope" onClick={() => undefined} badge={3} badgeLabel="3 offers">
            Refugees
          </Sign>
          <Sign variant="dark">Outfit</Sign>
          <Sign variant="nailed">Closed</Sign>
        </div>
        <Pop tail="top" at={20} who="Store">
          Packs and supplies. Open till dusk.
        </Pop>
        <Note title="Refugees · 3 offers">
          <p className="cv-small">
            <b>Take one, free.</b>
          </p>
          <span className="cv-timer cv-small">
            <Icon name="hourglass" />
            <span className="cv-num">1:29:59</span>
          </span>
        </Note>
        <Poster kicker="Wanted · 5 raiders" title="Dry Gulch Boys" flavour="Fast on the flats, slow to quit." plaque="Band 2" bounty={<><Icon name="coin" /><span className="cv-num">+808</span></>} />
        <div style={{ display: "flex", gap: 10 }}>
          {(["guard", "hold", "reserve"] as const).map((s) => (
            <Medallion key={s} label={s} caption={s} icon={`stance-${s}`} size="sm" pressed={stance === s} onClick={() => setStance(s)} />
          ))}
          <Medallion label="Locked" icon="padlock" disabled disabledReason="Reputation 3" />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button>Scout</Button>
          <Button variant="leather">Log</Button>
          <Button variant="tertiary">Skip</Button>
          <Button disabled disabledReason="Pack a crate">
            Reroll
          </Button>
        </div>
        <Toast tone="ok">Layout saved as <b>North wall</b>.</Toast>
        <Toast tone="error" title="Could not reach town" onDismiss={() => undefined}>
          Check your connection and try again.
        </Toast>
        <div style={{ width: "100%" }}>
          <CommitBanner icon="wheel" onClick={() => setSheet(true)}>
            Ride out
          </CommitBanner>
        </div>
      </div>
      {sheet && (
        <Sheet
          title="Ride out?"
          question
          onClose={() => setSheet(false)}
          footer={
            <div className="cv-pair">
              <Button onClick={() => setSheet(false)}>Not yet</Button>
              <Button variant="primary" icon="wheel" onClick={() => setSheet(false)}>
                Ride out
              </Button>
            </div>
          }
        >
          <div className="cv-facts">
            <div className="cv-fact">
              <Icon name="crate" />
              <span>
                <b>8 crates</b> packed, worth <span className="cv-num">640</span>
              </span>
            </div>
            <div className="cv-fact">
              <Icon name="hat" />
              <span>
                <b>4 posts</b>, nothing repaired on the trail
              </span>
            </div>
          </div>
        </Sheet>
      )}
    </AppShell>
  );
}

const stubFetch = (async () => new Response(JSON.stringify({ unreadCount: 2 }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider fetchImpl={stubFetch} autoResume={false}>
      <Gallery />
    </SessionProvider>
  </StrictMode>,
);
