# ysocial im Orchestrator

Eigener Temporal-Worker im Prozess des Postiz-Orchestrators (PLAN Phase 1, E21, E33, E35). Er erkennt Fehler und meldet Rohereignisse an den Hub. Der Hub entscheidet, wer einen Alarm bekommt, und versendet ihn.

Vorgabe: Übergabe §5, §7.1 und §11 im Hub-Repo, lokal `../social-hub/docs/HANDOVER.md`. Plan: `PLAN.md` im Hub, Phase 1, Abschnitt 3.3.

## Aufbau

| Datei | Inhalt |
|---|---|
| `ysocial.orchestrator.module.ts` | `YsocialOrchestratorModule`. Eingehängt in `apps/orchestrator/src/app.module.ts` (Patch 2) |
| `ysocial.worker.service.ts` | Startet und stoppt den Worker, schreibt den Zustand nach Redis |
| `ysocial.activities.ts` | Aktivitäten, alle mit Präfix `ysocial` |
| `workflows/` | Workflows des Workers, alle mit Präfix `ysocial` |

- Namespace aus `YSOCIAL_TEMPORAL_NAMESPACE` (auf Staging und Prod `ysocial`), Task-Queue `ysocial-postiz`. Der Hub-Worker nutzt im selben Namespace die Queue `ysocial-hub`.
- Höchstens 5 Aktivitäten gleichzeitig.
- Temporal-Adresse, `TEMPORAL_TLS` und `TEMPORAL_API_KEY` kommen aus denselben Variablen wie bei Postiz.
- `apps/orchestrator/src/workflows/index.ts` von Postiz bleibt unverändert (E6). Die Postiz-Worker laufen weiter im Namespace aus `TEMPORAL_NAMESPACE` (Standard `default`).

## Starten und Abschalten

Der Worker startet nur, wenn alle drei Variablen gesetzt sind (fail-closed):

| Variable | Wert |
|---|---|
| `HUB_INTERNAL_URL` | Adresse des Hubs im Docker-Netz, zum Beispiel `http://hub-web:3000`. Nur `http` oder `https`, ohne Zugangsdaten |
| `HUB_INTERNAL_TOKEN` | Gleicher Wert wie im Hub, mindestens 32 Zeichen |
| `YSOCIAL_TEMPORAL_NAMESPACE` | `ysocial`. Nie der Namespace von Postiz, sonst bleibt der Worker aus |

`YSOCIAL_WORKER_ENABLED=false` schaltet ihn ab, auch wenn alles gesetzt ist.

Fehlt etwas, startet Postiz normal. Im Log steht einmal `ysocial worker off:` mit den fehlenden Namen, nie mit Werten. Schlägt der Start fehl oder bricht der Worker ab, startet er nach 30 s neu, danach mit doppelter Pause bis höchstens 10 Minuten. Ein Fehler des ysocial-Workers beendet nie den Orchestrator.

## Zustand

Der Worker schreibt alle 30 s den Schlüssel `ysocial:worker:status` nach Redis (Ablauf nach 90 s). `GET /ysocial/status` im Backend liest ihn:

    "worker": { "running": true, "label": "Worker an", "state": "running", "namespace": "ysocial", "taskQueue": "ysocial-postiz", "since": "…", "updatedAt": "…" }

Ohne Schlüssel oder in einem anderen Zustand: `"running": false, "label": "Worker aus"` mit Grund. Zustände: `starting`, `running`, `off`, `error`, ohne Meldung `unknown`.

## Ereignisse an den Hub (E35)

Jedes Ereignis geht als `POST {HUB_INTERNAL_URL}/api/internal/events` an den Hub, mit `Authorization: Bearer {HUB_INTERNAL_TOKEN}` und `Idempotency-Key: {id}`.

    {
      "id": "ping:ysocial-worker:ysocial-ping-qa",
      "version": 1,
      "kind": "ping",
      "occurredAt": "2026-10-19T07:00:00.000Z",
      "source": "postiz",
      "subject": { "type": "system", "id": "ysocial-worker" },
      "postiz": {},
      "reason": "Ping aus dem ysocial-Worker"
    }

| Feld | Inhalt |
|---|---|
| `id` | Feste Kennung `<kind>:<subject.id>:<Zustand>`. Gleiches Ereignis, gleiche Kennung. Der Hub zählt jede Kennung einmal |
| `kind` | Art des Ereignisses, Liste unten |
| `subject` | Worum es geht: `post`, `channel` oder `system`, mit ID |
| `postiz` | IDs aus Postiz: `organizationId`, `integrationId`, `postId`, `customerId`, `providerIdentifier`, soweit vorhanden |
| `reason` | Ein kurzer Satz, höchstens 300 Zeichen. Alles, was wie ein Token aussieht, ist durch `***` ersetzt |
| `data` | Kleine Zusatzwerte. Nie `token`, `refreshToken`, `content`, `settings` oder `customInstanceDetails` |

Arten in diesem Stand: `ping` (Testereignis). Weitere Arten kommen mit PR 17 und PR 18.

Zustellung: Jedes Ereignis bekommt einen eigenen Workflow `ysocial-event-<id>`. Die Aktivität `ysocialDeliverEvent` wiederholt ab 10 s mit doppelter Pause bis 15 Minuten, insgesamt bis 24 Stunden. Jede Wiederholung sendet dasselbe Ereignis mit derselben Kennung. Der Hub soll mit 202 antworten, auch für eine Kennung, die er schon kennt. 409 gilt ebenfalls als zugestellt. 400, 404, 405, 410, 413, 415 und 422 beenden die Zustellung, alle anderen Antworten und Netzfehler werden wiederholt. Ein zugestelltes Ereignis stellt Temporal kein zweites Mal zu. Eine gescheiterte Zustellung darf neu starten.

## Ping von Hand (PR 16, QA 4)

Im Temporal-Container von Staging oder lokal:

    temporal workflow start --namespace ysocial --task-queue ysocial-postiz --type ysocialPingWorkflow --workflow-id ysocial-ping-qa

Ergebnis: `{"eventId":"ping:ysocial-worker:ysocial-ping-qa","delivery":"started"}`. Der Workflow `ysocial-event-ping:ysocial-worker:ysocial-ping-qa` stellt das Ereignis zu. Ein zweiter Ping mit derselben Workflow-ID meldet `"delivery":"duplicate"`.

## Regeln

- Postiz-Workflows nie ändern, sondern versionieren.
- Aktivitäten werden nach Methodennamen registriert. Eigene Aktivitäten tragen das Präfix `ysocial`. `YsocialActivities` hat bewusst keinen `@Activity`-Dekorator, sonst würde `nestjs-temporal-core` sie auch auf den Postiz-Workern registrieren.
- ysocial-Workflows setzen kein Suchattribut, nie `postId`. Postiz beendet sonst beim Umplanen und Löschen fremde Workflows (E13). Ein Test prüft jede Quelldatei.
- Nur lesende Plattformaufrufe. Gesendet wird nur an den Hub.
- Gemeinsamer Code liegt in `libraries/ysocial/` und wird mit relativen Pfaden importiert.

## Tests

- Alle: `pnpm exec jest -c libraries/ysocial/jest.config.js` (Node 22).
- Gegen einen echten Temporal-Server, sonst übersprungen: `YSOCIAL_IT_TEMPORAL_ADDRESS=127.0.0.1:7233 pnpm exec jest -c libraries/ysocial/jest.config.js ysocial.worker.integration`. Der Namespace `ysocial` muss existieren (`temporal operator namespace create --namespace ysocial`). Der Test startet den echten Worker, einen Mock-Hub, der beim ersten Versuch 503 antwortet, und einen Ping.
- Der Bundler von Temporal liest beim Test die TypeScript-Quellen. Die `.swcrc` von Postiz in `apps/orchestrator/` hat einen `baseUrl` von einem fremden Rechner, der Test schaltet sie für den Bundler ab. Im Betrieb bündelt der Worker das kompilierte JavaScript aus `dist`, dort spielt die Datei keine Rolle.
