# ysocial im Orchestrator

Eigener Temporal-Worker im Prozess des Postiz-Orchestrators (PLAN Phase 1, E21, E33, E35). Er erkennt Fehler und meldet Rohereignisse an den Hub. Der Hub entscheidet, wer einen Alarm bekommt, und versendet ihn.

Vorgabe: Übergabe §5, §7.1 und §11 im Hub-Repo, lokal `../social-hub/docs/HANDOVER.md`. Plan: `PLAN.md` im Hub, Phase 1, Abschnitt 3.3.

## Aufbau

| Datei | Inhalt |
|---|---|
| `ysocial.orchestrator.module.ts` | `YsocialOrchestratorModule`. Eingehängt in `apps/orchestrator/src/app.module.ts` (Patch 2) |
| `ysocial.worker.service.ts` | Startet und stoppt den Worker, schreibt den Zustand nach Redis, legt die Schedules an |
| `ysocial.schedules.ts` | Temporal-Schedules des Workers |
| `ysocial.temporal.client.ts` | Temporal-Client im Namespace `ysocial` für Schedules und Workflow-Starts |
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

Ohne Schlüssel oder in einem anderen Zustand: `"running": false, "label": "Worker aus"` mit Grund. Zustände: `starting`, `running`, `off`, `error`, ohne Meldung `unknown`. Läuft der Worker, steht dort auch `"schedules": "ready"` oder `"error"`.

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

Arten in diesem Stand:

| Art | Gegenstand | Wann | Kennung |
|---|---|---|---|
| `ping` | `system` | Testereignis, von Hand | `ping:ysocial-worker:<Workflow-ID>` |
| `post.failed` | `post` | Postiz setzt `ERROR`. Grund: Fehlertext von Postiz, bereinigt | `post.failed:<postId>:<Termin in ms>` |
| `post.not_published` | `post` | 3 Minuten nach dem Termin noch `QUEUE` | `post.not_published:<postId>:<Termin>` |
| `post.not_found` | `post` | `PUBLISHED`, aber 4 Minuten nach dem Termin auf der Plattform nicht auffindbar | `post.not_found:<postId>:<Termin>` |
| `post.verified` | `post` | Auf der Plattform gefunden. `data.releaseURL` ist der Link | `post.verified:<postId>:<Termin>` |
| `post.unverifiable` | `post` | Veröffentlicht, aber nicht prüfbar. Kein Alarm | `post.unverifiable:<postId>:<Termin>` |
| `post.resolved` | `post` | Ein gemeldeter Post wurde gelöscht, ist wieder Entwurf oder hat einen neuen Termin. `data.resolution`: `deleted`, `draft`, `rescheduled` | `post.resolved:<postId>:<Termin>` |

`post.verified`, `post.unverifiable` und `post.resolved` schließen offene Alarme desselben Posts. Meldet derselbe Prüflauf eine Art ein zweites Mal, hängt an der Kennung `-2`, `-3` und so weiter. Bei Post-Ereignissen steht in `data` immer `publishDate` und `state`. Weitere Arten kommen mit PR 18.

Zustellung: Jedes Ereignis bekommt einen eigenen Workflow `ysocial-event-<id>`. Die Aktivität `ysocialDeliverEvent` wiederholt ab 10 s mit doppelter Pause bis 15 Minuten, insgesamt bis 24 Stunden. Jede Wiederholung sendet dasselbe Ereignis mit derselben Kennung. Der Hub soll mit 202 antworten, auch für eine Kennung, die er schon kennt. 409 gilt ebenfalls als zugestellt. 400, 404, 405, 410, 413, 415 und 422 beenden die Zustellung, alle anderen Antworten und Netzfehler werden wiederholt. Ein zugestelltes Ereignis stellt Temporal kein zweites Mal zu. Eine gescheiterte Zustellung darf neu starten.

## PostVerification (PR 17, E22)

- Schedule `ysocial-post-verification` startet jede Minute `ysocialPostVerificationWorkflow`. Die Aktivität liest alle Posts mit Termin in den letzten 60 Minuten: nur der erste Post eines Threads, ohne Entwürfe, ohne gelöschte. Für jeden startet sie `ysocial-verify-<postId>`. Temporal lehnt eine zweite Prüfung desselben Posts ab, solange es den Lauf aufbewahrt. Eine eigene Tabelle gibt es nicht.
- `ysocialVerifyPostWorkflow` liest den Post jede Minute und entscheidet nach `libraries/ysocial/src/verification/post.verification.ts`:

| Zustand | Ergebnis |
|---|---|
| `ERROR` | sofort `post.failed` |
| `QUEUE` ab Termin + 3 min | `post.not_published` |
| `PUBLISHED` | Prüfung auf der Plattform: gefunden `post.verified`, nicht prüfbar `post.unverifiable`, nicht gefunden ab Termin + 4 min `post.not_found` |
| gelöscht, Entwurf, neuer Termin | ohne Meldung vorher nichts, sonst `post.resolved` |

- Nach einer Meldung schaut der Workflow nach 1, 2, 5, 10, 15 und 30 Minuten wieder nach, dann stündlich, 24 Stunden lang. Geht der Post in dieser Zeit raus, kommt `post.verified` und der Alarm schließt sich.
- Die Plattformprüfung ruft nur `postAnalytics` des Providers mit dem gespeicherten Token auf, ohne Token-Refresh. Je Aufruf steht im Log `provider call postAnalytics provider=<id> post=<postId> result=<found|not_found>`. Höchstens 5 Aufrufe laufen gleichzeitig.
- Antwortet die Plattform dreimal nicht, gilt der Post als nicht prüfbar, ohne Alarm.

Welche Antwort was heißt (`libraries/ysocial/src/verification/provider.rules.ts`):

| Provider | „gibt es“ | „gibt es nicht“ | nicht prüfbar |
|---|---|---|---|
| `facebook` | Liste mit mindestens einer Kennzahl | leere Liste (auch bei unbekannter ID oder entzogenem Zugang) | Video, Reel, Story (ID ohne `_`) |
| `instagram`, `instagram-standalone` | Liste mit mindestens einer Kennzahl | leere Liste | Story (`post_type: story`) |
| alle anderen | – | – | immer, kein Alarm |

Außerdem nicht prüfbar: kein `releaseId` oder `releaseId = 'missing'`, Kanal getrennt (`disabled`, `refreshNeeded`, `inBetweenSteps`, gelöscht), Zugang abgelaufen.

Lauf von Hand mit größerem Fenster (PR 17, QA 3), hier 3 Tage:

    temporal workflow start --namespace ysocial --task-queue ysocial-postiz --type ysocialPostVerificationWorkflow --workflow-id ysocial-post-verification-hand --input '{"windowMinutes": 4320}'

Höchstens 7 Tage. Posts, die schon geprüft wurden, prüft er nicht noch einmal.

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
- Gegen einen echten Temporal-Server, sonst übersprungen: `YSOCIAL_IT_TEMPORAL_ADDRESS=127.0.0.1:7233 pnpm exec jest -c libraries/ysocial/jest.config.js ysocial.worker.integration`. Der Namespace `ysocial` muss existieren (`temporal operator namespace create --namespace ysocial`). Der Test startet den echten Worker, einen Mock-Hub, der beim ersten Versuch 503 antwortet, einen Ping und eine PostVerification mit zwei erfundenen Posts aus einem gestellten Dienst, ohne Datenbank. Er legt den Schedule an und löscht ihn am Ende wieder.
- Zeitraffer für PostVerification: `ysocial.verify.post.workflow.spec.ts`. `sleep` stellt dort die Uhr vor, statt zu warten.
- Der Bundler von Temporal liest beim Test die TypeScript-Quellen. Die `.swcrc` von Postiz in `apps/orchestrator/` hat einen `baseUrl` von einem fremden Rechner, der Test schaltet sie für den Bundler ab. Im Betrieb bündelt der Worker das kompilierte JavaScript aus `dist`, dort spielt die Datei keine Rolle.
