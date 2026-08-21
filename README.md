# omadia Facilitator (`@omadia/agent-facilitator`)

Moderiert Gruppen-Chats zu einem definierten Ergebnis — wie ein professioneller
Facilitator, transparent und announced. Workstream C (Slice C1) des Epics
[byte5ai/omadia#330](https://github.com/byte5ai/omadia/issues/330).

**Das Modell:** EIN sichtbarer **Convener** mit Modi (moderieren,
protokollieren, Zeit halten) — nie ein Bot pro Funktion, nie ein verdeckter
Beobachter. Die Facilitation läuft als **ephemerer Conductor-Workflow**
(kuratiertes Pattern `facilitation`, Workstream A): Moderation ist kreativ
(der Agent), Terminierung/Deadline/Report/Cleanup sind deterministisch (der
Conductor).

## Voraussetzungen

| Was | Version |
|---|---|
| omadia Kernel | main ≥ `1fa8eda7` (#330 A `conductorEphemeralRuns` + B1 `targetedSend`/`conversationEvents`/`conversationRosters`) |
| Teams-Channel-Plugin | `@omadia/channel-teams` ≥ 0.13.0 (B2: `bot_added`-Events, Roster, Targeted Send) |
| Postgres | ja (Conductor) — ohne DB degradieren die Tools mit ehrlichen Meldungen |

Alle Kernel-Services sind `optional_requires`: auf älteren Kernels aktiviert
das Plugin und antwortet mit klaren Degradations-Hinweisen statt zu brechen.

## Betriebs-Setup (einmalig, Operator)

1. **Plugin installieren** (Hub-ZIP oder Upload) und für einen Agenten
   enablen; Setup-Felder prüfen (Defaults sind lauffähig).
2. **Top-Level-Agent `facilitator` anlegen** (Operator-UI). In dessen
   Instructions gehört die Moderations-Persona — als Startpunkt den Inhalt
   von `skills/facilitator-playbook.md` übernehmen. (Die `prompt_partial`-
   Skills dieses Plugins speisen den Sub-Agenten hinter `query_facilitation`,
   nicht automatisch den Top-Level-Agenten.)
3. **Conversation-Binding setzen:** Der Teams-Bot wird in den Gruppen-Chat
   eingeladen (`bot_added` wird geloggt und als pending Facilitation
   vorgemerkt); danach die Conversation über
   `PUT /api/v1/operator/agents/facilitator/bindings` (channel_type `teams`,
   channel_key = conversationId) an den Facilitator-Agenten binden.
4. **Initiator-Rolle besetzen:** Der Conductor-Rolle
   `facilitation-initiator` (konfigurierbar) die Initiator(en) als Holder
   zuweisen — sie bestätigen das Ergebnis (confirm-Step, Deadline PT24H im
   Pattern) und empfangen die Reports (`role:`-Fan-out an alle Holder).

## Ablauf

1. Initiator lädt den Bot ein und nennt Ziel + machine-checkable
   Definition-of-Done.
2. Agent ruft `facilitation_start` → genau EIN ephemerer Run
   (TTL-gedeckelt, Kernel-Quotas) → sichtbarer Opening-Handshake (Ziel, DoD,
   Deadline, Report-Ziel-Offenlegung, `/facilitator stop`).
3. Moderation im Chat (Round-Robin, stille Stimmen, reflektierendes
   Zusammenfassen, Timeboxing, Neutralität — siehe Playbook).
4. Ergebnis → Bestätigung durch die Initiator-Rolle (Conductor human-step)
   → `facilitation_report` (final) an `role:<initiator_role_key>`;
   Fehlschlag/Deadline → ehrlicher Abort-Report. Der ephemere Workflow wird
   danach vom Kernel-Reaper entsorgt — Run-Historie bleibt als Audit-Trace.

## Grenzen (C1, bewusst)

- **Kein proaktives Posten** in den Gruppen-Chat — alles Sichtbare ist
  Turn-Antwort; Reports laufen als DM über `targetedSend`.
- **Eigene Teams-App-Identität** (zweiter Bot) ist C2 — bis dahin tritt der
  Facilitator über den gebundenen Teams-Bot auf.
- **`facilitation_stop` stoppt die Moderation, nicht den Workflow-Run** —
  der läuft bis Deadline/TTL (dann Abort-Report). Ein Cancel-Durchgriff ist
  ein A-Follow-up.
- **Lokaler Facilitation-State ist in-memory** — ein Middleware-Neustart
  verliert pending/active-Marker (der Conductor-Run selbst ist durabel);
  `facilitation_status` sagt das dann ehrlich.
- **Eine Facilitation zur Zeit empfohlen:** Tool-Aufrufe ohne
  `conversationId` fallen auf die zuletzt aktualisierte Facilitation zurück —
  bei mehreren parallelen Gruppen die `conversationId` explizit mitgeben.
- Confirm-Deadline ist im Pattern fix (`PT24H`); konfigurierbar ist die
  Workflow-TTL.

## Entwicklung

```bash
npm install                    # devDeps lösen @omadia/plugin-api aus ../odoo-bot auf (>= 1.7.0, gebaut)
npm run typecheck && npm run build && npm test
npm run package                # → out/@omadia-agent-facilitator-<version>.zip
```

Hub-Publish folgt den Hub-Regeln (Registry messen, ein Plugin pro Publish)
und bleibt bewusst ein manueller Schritt.
