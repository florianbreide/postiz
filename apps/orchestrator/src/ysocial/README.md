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

Außerdem hängt `YsocialTokenKeyCheck` (aus `libraries/ysocial/src/tokens/`) im Modul, siehe „Verschlüsselte Kanal-Tokens“ unten.

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

Fehlt etwas, startet Postiz normal. Im Log steht einmal `ysocial worker off:` mit den fehlenden Namen, nie mit Werten. Schlägt der Start fehl oder bricht der Worker ab, startet er nach 30 s neu, danach mit doppelter Pause bis höchstens 10 Minuten. Ein Fehler des ysocial-Workers beendet nie den Orchestrator. Die einzige Ausnahme ist die Startprüfung des Token-Schlüssels (unten).

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
| `post.failed` | `post` | Postiz setzt `ERROR`. Grund: Fehlertext von Postiz, bereinigt. Scheitert ein neuer Versuch (zum Beispiel nach „Erneut versuchen“), kommt es noch einmal | `post.failed:<postId>:<Termin in ms>-<updatedAt des Posts in ms>` |
| `post.not_published` | `post` | 3 Minuten nach dem Termin noch `QUEUE` | `post.not_published:<postId>:<Termin>` |
| `post.not_found` | `post` | `PUBLISHED`, aber 4 Minuten nach dem Termin auf der Plattform nicht auffindbar | `post.not_found:<postId>:<Termin>` |
| `post.verified` | `post` | Auf der Plattform gefunden. `data.releaseURL` ist der Link | `post.verified:<postId>:<Termin>` |
| `post.unverifiable` | `post` | Veröffentlicht, aber nicht prüfbar. Kein Alarm | `post.unverifiable:<postId>:<Termin>` |
| `post.resolved` | `post` | Ein gemeldeter Post wurde gelöscht, ist wieder Entwurf oder hat einen neuen Termin. `data.resolution`: `deleted`, `draft`, `rescheduled` | `post.resolved:<postId>:<Termin>` |
| `channel.disconnected` | `channel` | In Postiz ist `refreshNeeded`, `inBetweenSteps` oder `disabled` gesetzt. `data.flag`: `refresh_needed`, `in_between_steps`, `disabled` | `channel.disconnected:<integrationId>:<flag>-<updatedAt in ms>` |
| `channel.auth_invalid` | `channel` | `DailyHealth`: Die Plattform lehnt den gespeicherten Zugang ab („Zugang ungültig“) | `channel.auth_invalid:<integrationId>:<updatedAt in ms>-<Beginn in ms>` |
| `channel.reconnected` | `channel` | Ein gemeldeter Kanal ist wieder in Ordnung. `data.previous`: die frühere Art | `channel.reconnected:<integrationId>:<updatedAt in ms>-<Beginn der früheren Meldung in ms>` |
| `channel.removed` | `channel` | Ein gemeldeter Kanal wurde in Postiz entfernt | `channel.removed:<integrationId>:<updatedAt beim Melden>` |
| `channel.token_expiring` | `channel` | `DailyHealth`: Der Zugang läuft in höchstens 7 Tagen ab oder ist abgelaufen. `data.expiresAt`, `data.expired` | `channel.token_expiring:<integrationId>:<Ablauf in ms>` |
| `health.daily` | `system` (`postiz`) | Sammelereignis von `DailyHealth`, Inhalt unten | `health.daily:postiz:<Tag in Berlin>` |

`post.verified`, `post.unverifiable` und `post.resolved` schließen offene Alarme desselben Posts, `channel.reconnected` und `channel.removed` die des Kanals. Meldet derselbe Prüflauf eine Art ein zweites Mal, hängt an der Kennung `-2`, `-3` und so weiter, außer bei `post.failed`. Bei Post-Ereignissen steht in `data` immer `publishDate` und `state`.

Kennungen ab 0.7.1:
- `post.failed`: Jeder Schreibzugriff von Postiz ändert `updatedAt` des Posts, auch ein neuer Versuch, der wieder scheitert. `PostVerification` und `DailyHealth` bilden die Kennung gleich (`postFailedStateKey` in `libraries/ysocial/src/verification/post.verification.ts`). Solange der Post unverändert auf `ERROR` steht, bleibt sie gleich. Eine neue Kennung, die der Hub beim offenen Alarm mitzählt, kommt auch, wenn jemand den Post auf `ERROR` ändert, ohne ihn neu zu versuchen, oder wenn Postiz im selben Lauf selbst neu versucht: `postWorkflowV112` setzt bei manchen Fehlern `ERROR`, versucht es bis zu fünfmal und schreibt am Ende noch einmal `ERROR` (`markUnconfirmed`). Fehlposts, die vor 0.7.1 gemeldet wurden, und laufende Prüfungen der alten Version (bis etwa 25 Stunden nach dem Deploy) tragen noch `<Termin in ms>`. Der erste Tageslauf danach meldet sie mit der neuen Kennung, der Hub zählt sie beim offenen Alarm mit.
- `channel.auth_invalid`: „Zugang ungültig“ ändert den Kanal in Postiz nicht, `updatedAt` bleibt. „Beginn“ ist der Lauf, der den Vorfall zuerst sieht (`since` in `ysocial:channel-problems`, siehe unten). Er bleibt, solange der Vorfall dauert. Ein neuer Vorfall nach `channel.reconnected` bekommt einen neuen Beginn. `channel.reconnected` trägt den Beginn der Meldung, die es schließt.

Zustellung: Jedes Ereignis bekommt einen eigenen Workflow `ysocial-event-<id>`. Die Aktivität `ysocialDeliverEvent` wiederholt ab 10 s mit doppelter Pause bis 15 Minuten, insgesamt bis 24 Stunden. Jede Wiederholung sendet dasselbe Ereignis mit derselben Kennung. Der Hub soll mit 202 antworten, auch für eine Kennung, die er schon kennt. 409 gilt ebenfalls als zugestellt. 400, 404, 405, 410, 413, 415 und 422 beenden die Zustellung, alle anderen Antworten und Netzfehler werden wiederholt. Ein zugestelltes Ereignis stellt Temporal kein zweites Mal zu. Eine gescheiterte Zustellung darf neu starten.

## PostVerification (PR 17, E22)

- Schedule `ysocial-post-verification` startet jede Minute `ysocialPostVerificationWorkflow`. Die Aktivität liest alle Posts mit Termin in den letzten 60 Minuten: nur der erste Post eines Threads, ohne Entwürfe, ohne gelöschte. Für jeden startet sie `ysocial-verify-<postId>`. Temporal lehnt eine zweite Prüfung desselben Posts ab, solange es den Lauf aufbewahrt. Eine eigene Tabelle gibt es nicht.
- `ysocialVerifyPostWorkflowV101` (ab 0.7.1) liest den Post jede Minute und entscheidet nach `libraries/ysocial/src/verification/post.verification.ts`. `ysocialVerifyPostWorkflow` bleibt unverändert für Läufe, die vorher gestartet wurden. Er meldet `post.failed` je Lauf nur einmal, mit der Kennung `post.failed:<postId>:<Termin in ms>`:

| Zustand | Ergebnis |
|---|---|
| `ERROR` | sofort `post.failed`. Steht der Post bei einer Nachschau mit anderem `updatedAt` auf `ERROR`, wieder `post.failed` mit neuer Kennung |
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

## Kanal-Prüfung und DailyHealth (PR 18, E23)

**Kanal-Prüfung**, Schedule `ysocial-channel-check`, jede Stunde um Viertel nach: liest nur die Felder der Kanäle in der Datenbank, ohne Plattformaufruf. Meldet `channel.disconnected`, `channel.reconnected` und `channel.removed`.

**DailyHealth**, Schedule `ysocial-daily-health`, täglich um 07:00 Uhr Europe/Berlin. War der Worker um 07:00 aus, holt der Schedule den Lauf bis 09:00 nach. Je Kanal ohne gelöschtes Datum:

- Felder wie bei der Kanal-Prüfung, dazu der Ablauf des Zugangs: `channel.token_expiring` ab 7 Tagen vorher.
- Genau ein lesender Plattformaufruf über die Provider-Methode `analytics` für einen Tag. Kanäle mit gesetztem Feld oder abgelaufenem Zugang und Provider ohne `analytics` bekommen keinen Aufruf. Bei Instagram macht die Provider-Methode intern zwei Anfragen an die Graph API.
- Posts im Zustand `ERROR` der letzten 7 Tage, je Post `post.failed` mit derselben Kennung wie in `PostVerification`.
- Zum Schluss `health.daily` mit `data`: `day`, `channels`, `platformCalls`, `skipped`, `disconnected`, `authInvalid`, `tokenExpiring`, `unclear`, `failedPosts` (Listen mit IDs).
- Inbox-Abrufe prüft `DailyHealth` erst ab Phase 3 (W33).

Was die Antwort von `analytics` heißt (`libraries/ysocial/src/health/channel.auth.rules.ts`):

| Antwort | Ergebnis |
|---|---|
| `RefreshToken` oder `Disconnect` aus `SocialAbstract`, jeder Provider | Zugang ungültig, `channel.auth_invalid` |
| `facebook`: Fehler mit einer OAuth-Meldung (Code 190, „Error validating access token“, „Session has expired“ …) | Zugang ungültig |
| `instagram`: leere Liste | unklar: Instagram antwortet auch bei ungültigem Zugang leer |
| jeder andere Fehler, etwa ein Limit | unklar, kein Alarm, im Sammelereignis unter `unclear` |
| sonst | in Ordnung |

Welche Kanäle gemeldet sind, merkt sich der Worker im Redis von Postiz unter `ysocial:channel-problems`, keine Tabelle. So kann er „wieder verbunden“ melden. „Zugang ungültig“ gilt als gelöst, wenn sich der Kanal danach ändert (neu verbunden) oder der nächste Tageslauf in Ordnung ist. Geht der Schlüssel verloren, meldet der nächste Lauf die aktuellen Probleme noch einmal. `channel.disconnected` hat dann dieselbe Kennung, der Hub zählt es einmal. `channel.auth_invalid` bekommt einen neuen Beginn und damit eine neue Kennung, der Hub zählt es beim offenen Alarm mit.

Im Log steht je Plattformaufruf `provider call analytics provider=<id> channel=<integrationId> result=<ok|auth_invalid|unclear>` und je Tageslauf `daily health: channels=<n> platform calls=<n> skipped=<n>`.

Läufe von Hand (A1, PR 18 QA 3):

    temporal workflow start --namespace ysocial --task-queue ysocial-postiz --type ysocialDailyHealthWorkflow --workflow-id ysocial-daily-health-hand
    temporal workflow start --namespace ysocial --task-queue ysocial-postiz --type ysocialChannelCheckWorkflow --workflow-id ysocial-channel-check-hand

Für einen zweiten Lauf eine neue Workflow-ID nehmen, zum Beispiel mit Uhrzeit.

## Verschlüsselte Kanal-Tokens (PR 25, E24)

Postiz speichert `Integration.token` und `refreshToken` verschlüsselt, sobald `YSOCIAL_TOKEN_KEY` gesetzt ist. Format `ys1:<kid>:<iv>:<tag>:<chiffre>`, AES-256-GCM. `<kid>` sind die ersten 8 Hex-Zeichen von SHA-256 über den Schlüssel. Die Erweiterung hängt über Patch 3 in `PrismaService`, die Logik liegt in `libraries/ysocial/src/tokens/`. Provider und Postiz-Code sehen weiter den Klartext.

**Startprüfung** (`YsocialTokenKeyCheck`, in Backend und Orchestrator). Nest wartet beim Aufbau der Provider auf sie. Schlägt sie fehl, beendet sich der Prozess mit Exit-Code 1, bevor ein Port oder ein Temporal-Worker startet. pm2 startet ihn neu, die Meldung steht dann bei jedem Versuch im Log. Sie schlägt fehl, wenn:
- `YSOCIAL_TOKEN_KEY` gesetzt ist, aber nicht genau 32 Byte als Base64 ergibt,
- der Schlüssel fehlt, es aber verschlüsselte Tokens gibt,
- Tokens mit einem anderen Schlüssel verschlüsselt sind. Die Meldung nennt beide `<kid>`, nie einen Token.

Läuft alles, steht im Log `token encryption on (key <kid>)`, ohne Schlüssel `token encryption off: …`.

**Migration** der Tokens, die noch Klartext sind. Läuft nur von Hand, beim Start wird nichts umgeschrieben. Voraussetzung: `YSOCIAL_TOKEN_KEY` ist in Backend und Orchestrator gesetzt, beide sind damit neu gestartet, und der ysocial-Worker läuft. Im Temporal-Container von Staging oder Prod:

    temporal workflow start --namespace ysocial --task-queue ysocial-postiz --type ysocialTokenMigrationWorkflow --workflow-id ysocial-token-migration-$(date +%Y%m%d-%H%M)
    temporal workflow result --namespace ysocial --workflow-id <ID von oben>

Ergebnis, nur Zahlen: `{"token":{"encrypted":…,"changedMeanwhile":…,"remaining":0},"refreshToken":{…}}`. `changedMeanwhile` zählt Tokens, die Postiz während des Laufs selbst neu geschrieben hat (Refresh), die sind schon verschlüsselt. Erfasst werden alle Kanäle, auch gelöschte. Ein zweiter Lauf ist ungefährlich und meldet `encrypted: 0`. Fehlt der Schlüssel, bricht der Lauf sofort ab (`YsocialTokenKey`, ohne Wiederholung). Optional `--input '{"batchSize": 100}'`, höchstens 500.

**Grenzen:**
- Der Temporal-Verlauf enthält weiter Klartext-Tokens. Postiz gibt ganze Kanal-Zeilen an seine Aktivitäten weiter (`refresh.token.workflow.ts`, `post.workflow.v1.0.1.ts` Z. 198–204), die Aktivität liest sie entschlüsselt. Das ist offen als Frage an Florian, Option für Phase 2: ein Payload-Codec für Temporal.
- Die Fluent-API von Prisma (`post.findUnique().integration()`) gibt die Chiffre zurück, Raw-Queries gehen an der Erweiterung vorbei. Postiz nutzt beides nicht. `ysocial.token.bypass.spec.ts` prüft die Quellen bei jedem PR.
- Ein Schlüsselwechsel (Rotation) gehört nicht zu PR 25.

## Lese-API für den Hub (Backend, PR 18)

Hinter `YsocialTokenGuard` wie `/ysocial/status`, von außen gesperrt (`/api/ysocial/*`):

| Route | Inhalt |
|---|---|
| `GET /ysocial/customers` | Postiz-Customers ohne gelöschte: `id`, `orgId`, `name`, `createdAt`, `updatedAt` |
| `GET /ysocial/integrations` | Kanäle ohne gelöschte: `id`, `organizationId`, `customerId`, `name`, `customName`, `picture`, `profile`, `providerIdentifier`, `type`, `disabled`, `refreshNeeded`, `inBetweenSteps`, `tokenExpiration`, `createdAt`, `updatedAt`, dazu `status` (`ok`, `refresh_needed`, `in_between_steps`, `disabled`) |
| `GET /ysocial/posts?from=&to=` | Posts ohne gelöschte mit Termin ab `from` bis vor `to` (ISO 8601, höchstens 31 Tage, höchstens 2000 Posts): `id`, `organizationId`, `integrationId`, `group`, `parentPostId`, `state`, `publishDate`, `releaseURL`, `error` (bereinigt), `createdAt`, `updatedAt` |

Nie dabei: `token`, `refreshToken`, `customInstanceDetails`, `settings`, `additionalSettings`, `internalId`, Posttext (`content`) und Medien (`image`). Die Feldlisten stehen in `libraries/ysocial/src/database/ysocial.read.repository.ts`. Posttext und Medien für die Vorschau in PR 23 sind eine eigene Entscheidung.

## Erneut versuchen (Backend, PR 19)

`POST /ysocial/posts/:id/retry`, hinter `YsocialTokenGuard`, von außen gesperrt wie die Lese-API. Der Hub prüft die Rolle der Person (E32) und schickt sie im Kopf `X-Ysocial-Actor` mit.

    POST /ysocial/posts/<postId>/retry
    Authorization: Bearer <YSOCIAL_SERVICE_TOKEN>
    X-Ysocial-Actor: <wer im Hub geklickt hat>
    Content-Type: application/json

    {}                         oder bei unklarem Ausgang nach Rückfrage: {"confirmUnclear": true}

Die Route setzt den Post von `ERROR` auf `QUEUE` und ruft `PostsService.startWorkflow` von Postiz. Der startet `postWorkflowV112` wie beim Umplanen in Postiz. Die Route ruft nie selbst einen Provider auf, gepostet wird nur über den Workflow von Postiz.

- Vorher fragt sie Temporal mit derselben Abfrage wie `startWorkflow`, ob für den Post noch ein Workflow läuft (`postId="…" AND ExecutionStatus="Running"`). Postiz setzt `ERROR` und versucht es im selben Workflow noch einmal. `startWorkflow` würde diesen Workflow beenden, während sein Provider-Aufruf weiterläuft, und dann ein zweites Mal posten. Läuft ein Workflow, kommt 409 `workflow_running`. Das gilt auch, wenn ein wiederholter Post (`intervalInDays`) oder ein Plug noch wartet. Erst danach fragt die Route nach der Bestätigung eines unklaren Ausgangs. Niemand soll „noch nicht online“ bestätigen, während Postiz vielleicht gerade postet.
- Antwortet Temporal nicht, kommt 503 `temporal_unavailable`, und nichts ändert sich. `startWorkflow` verschluckt eigene Fehler, ohne diese Prüfung bliebe der Post auf `QUEUE` ohne Workflow. Fällt Temporal genau zwischen Prüfung und Start aus, bleibt das möglich. Der Postiz-Sweep `missing-post-workflow` startet solche Posts stündlich neu, aber nur mit Termin in den letzten 2 Tagen.
- Der Wechsel auf `QUEUE` gilt nur, wenn der Post noch auf `ERROR` steht (`updateMany` mit `state: 'ERROR'`). Zwei Klicks gleichzeitig ergeben einen Workflow-Start und einmal 409.

| Antwort | `code` | Wann |
|---|---|---|
| 202 `{"id":"…","state":"QUEUE"}` | – | Post auf `QUEUE`, Start bei Temporal angefordert |
| 400 | `actor_missing` | `X-Ysocial-Actor` fehlt, ist länger als 200 Zeichen oder enthält andere Zeichen als `A–Z`, `a–z`, `0–9` und `_ . @ + : -` (E-Mail-Adresse oder ID, keine Umlaute) |
| 400 | – | `confirmUnclear` ist kein Boolean |
| 401, 503 | – | Service-Token falsch oder nicht konfiguriert, wie `/ysocial/status` |
| 404 | `not_found` | Post unbekannt |
| 409 | `deleted` | Post gelöscht |
| 409 | `not_first_post` | Kommentar eines Threads. Postiz setzt `ERROR` am ersten Post, und `postWorkflowV112` würde einen Kommentar als eigenen Post senden |
| 409 | `already_queued` | Post steht schon auf `QUEUE` |
| 409 | `not_failed` | Zustand `PUBLISHED` oder `DRAFT`, steht in `state` |
| 409 | `channel_inactive` | Kanal gelöscht, `disabled`, `refreshNeeded` oder `inBetweenSteps`, steht in `flag`. Dieselben Bedingungen wie beim Sweep `searchForMissingThreeHoursPosts` von Postiz |
| 409 | `unclear_outcome` | Unklarer Ausgang ohne `"confirmUnclear": true`, `reason` siehe unten |
| 409 | `workflow_running` | Für den Post läuft noch ein Postiz-Workflow |
| 409 | `state_changed` | Der Post hat zwischen Lesen und Schreiben den Zustand gewechselt, zum Beispiel durch einen zweiten Klick |
| 503 | `temporal_unavailable` | Temporal antwortet nicht, nichts geändert |

Im Log steht je Aufruf `retry post=<postId> actor=<X-Ysocial-Actor> result=<started|rejected code=…>`, nach Bestätigung mit `confirmed=<reason>`. Posttext steht nie darin. Bei `not_found` steht dort `post=-`, der rohe Pfad kommt nie ins Log.

Für die Oberfläche (PR 23):
- Eine Bestätigung bei `reason: "published"` sendet den ganzen Post noch einmal, bei einem Thread auch den ersten Post.
- Bei einem wiederholten Post (`intervalInDays`), dessen Termin mehr als 2 Stunden zurückliegt, legt Postiz den Termin auf die nächste Wiederholung (`reanchorInterval` in `apps/orchestrator/src/activities/post.activity.ts`). „Erneut versuchen“ postet dann nicht sofort.
- Der alte Fehlertext bleibt bei `QUEUE` im Feld `error` stehen, die Lese-API zeigt ihn weiter.
- Nach einem Retry sieht ein laufender `ysocial-verify-<postId>` den Post kurz auf `QUEUE` und meldet dabei nichts, `post.failed` ist schon gemeldet. Geht der Post raus, schließt `post.verified` den Alarm. Scheitert er wieder, kommt `post.failed` mit neuer Kennung. Nach den 24 Stunden der Nachschau meldet nur noch `DailyHealth` am nächsten Morgen.

### Unklarer Ausgang

Postiz v2.25.3 hat kein Feld für einen unklaren Ausgang. `markUnconfirmed` in `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts` setzt `ERROR` und schreibt den rohen Fehler nach `Post.error` (`PostsRepository.changeState`: Text bleibt Text, alles andere wird `JSON.stringify`). Temporal-Fehler stehen dort als JSON, zum Beispiel `{"cause":{"timeoutType":"START_TO_CLOSE",…},"activityType":"postSocialPending",…}`.

Die Route verlangt deshalb immer eine Bestätigung, außer `releaseId` und `releaseURL` sind leer und der Fehler belegt, dass nichts rausging (fail-closed, Entscheidung für PR 19). Die Regel steht in `libraries/ysocial/src/retry/retry.rules.ts` (`unclearOutcome`), je Fall gibt es einen Test.

| `Post.error` | Quelle in v2.25.3 | Ergebnis |
|---|---|---|
| `releaseId` oder `releaseURL` gesetzt, egal welcher Fehler | `updatePost` setzt beide, sobald ein Post raus ist. Bei einem Thread ist der erste Post raus, ein Kommentar scheitert, `changeState` setzt den ersten Post auf `ERROR`. `PublishedWithError` (`social.abstract.ts`, YouTube-Thumbnail): `PostActivity.handleDisconnect` speichert vorher beide per `updateResolvedRelease`. Ein früher veröffentlichter Post, den `changePostStatus` wieder auf `QUEUE` gesetzt hat, behält sie auch. Umplanen im Kalender (`changeDate` mit `schedule`) löscht beide | Bestätigung, `reason: "published"` |
| JSON mit `activityType: "postComment"` | Kommentare laufen erst nach dem ersten Post | Bestätigung, `published` |
| `No Post` | `postWorkflowV112`: Post nicht gefunden | keine Bestätigung |
| `Refresh channel needed` | `postWorkflowV112`: Kanal braucht neue Verbindung, vor jedem Plattformaufruf | keine Bestätigung |
| `Channel disabled` | `postWorkflowV112`: Kanal abgeschaltet, vor jedem Plattformaufruf | keine Bestätigung |
| JSON mit `cause.type: "refresh_token"` und `activityType` `postSocialPending` oder `postSocial` | `handleActivityError` → `stop`: Token-Refresh beim ersten Veröffentlichen gescheitert. Postiz selbst veröffentlicht nach einem gelungenen Refresh erneut, nimmt also auch an, dass nichts rausging. Restrisiko: `RefreshToken` kommt aus jeder 401 innerhalb von `post()`, und `Post.error` hält nur den letzten von bis zu 5 Versuchen. Ein früherer Versuch mit unklarem Ausgang ist dann nicht mehr sichtbar | keine Bestätigung |
| JSON mit `cause.type: "bad_body"`, auch in `postSocialPending`, `checkPostStatus` und `finalizePost` | `bad_body` belegt nichts: `SocialAbstract.fetch` macht aus 500 und 429 nach 3 Versuchen `BadBody`, `runInConcurrent` aus jedem Fehler, auch aus Netzfehlern nach dem Upload. `facebook.provider.ts` (`checkPostStatus` bei Stories) wirft `BadBody` mit „Facebook may have already published part of the story“. Bei Stories mit mehreren Medien kann `finalizePost` nach dem ersten veröffentlichten Medium scheitern | Bestätigung, `unconfirmed` |
| `Could not confirm the post status` | `resolvePending` → `markUnconfirmed`: Statusprüfung ohne Ergebnis (gleicher Text seit v1.0.6) | Bestätigung, `reason: "unconfirmed"` |
| `Could not publish after several attempts` | Schleife in `postWorkflowV112` → `markUnconfirmed`: alle Versuche aufgebraucht (seit v1.1.1) | Bestätigung, `unconfirmed` |
| JSON mit `cause.timeoutType` | `handleActivityError` → `timeout` → `markUnconfirmed`: Zeitüberschreitung beim Veröffentlichen | Bestätigung, `unconfirmed` |
| JSON mit `activityType: "updatePost"`, egal welche Ursache | `catch` mit `posted && !updated` → `markUnconfirmed`: Post ist raus, Speichern gescheitert | Bestätigung, `unconfirmed` |
| JSON mit `cause.type: "refresh_token"` und `activityType` `checkPostStatus` oder `finalizePost` | `resolvePending` → `stop` → `markUnconfirmed`: Plattform hatte den Post schon angenommen | Bestätigung, `unconfirmed` |
| `Already posted` | `postWorkflowV112`: Workflow startete, obwohl der Post nicht auf `QUEUE` stand | Bestätigung, `unconfirmed` |
| leer, unlesbar oder unbekannt | zum Beispiel ein Fehler in `resolvePending` (`markUnconfirmed(err)` mit beliebigem Fehler) | Bestätigung, `unconfirmed` |

Ändert ein Upstream-Release `markUnconfirmed`, `handleActivityError`, `changeState`, `updatePost` oder einen der Texte, kommt die Tabelle beim Sync auf den Prüfstand (`YSOCIAL-PATCHES.md`, Ablauf). Ein neuer Text fällt ohne Änderung unter „unbekannt“ und verlangt eine Bestätigung.

## Testschalter für die Kanal-Prüfung (Backend, PR 19, nur Staging)

Für A1: Die Kanal-Prüfung von `DailyHealth` schickt für einen Kanal 30 Minuten lang absichtlich einen ungültigen Token an die Plattform. Die Plattform antwortet mit „Zugang ungültig“. Der gespeicherte Token in Postiz bleibt unverändert.

| Variable | Wert |
|---|---|
| `YSOCIAL_TEST_ROUTES` | `true` schaltet die Testrouten ein. Jeder andere Wert und eine fehlende Variable: Die Routen antworten mit 404, wie eine unbekannte Route, schon vor der Token-Prüfung. Nur auf Staging setzen |
| `YSOCIAL_TEST_INTEGRATIONS` | IDs der Kanäle, durch Komma getrennt, für die der Schalter gilt. Nur Kanäle von Y Social |

| Route | Wirkung |
|---|---|
| `POST /ysocial/test/integrations/:id/invalid-token` | Schalter an, 30 Minuten. Antwort `{"integrationId":"…","invalidToken":true,"until":"…"}` |
| `DELETE /ysocial/test/integrations/:id/invalid-token` | Schalter vorzeitig aus |

Beide hinter `YsocialTestRoutesGuard` und `YsocialTokenGuard`. Steht die ID nicht in `YSOCIAL_TEST_INTEGRATIONS`, kommt 403 `not_test_integration`.

- Der Schalter liegt im Redis von Postiz unter `ysocial:test:invalid-token:<integrationId>` mit Ablauf nach 1800 s, keine Tabelle. Der Wert ist `{"since":"…","until":"…"}`. Die Kanal-Prüfung nimmt den ungültigen Token nur bis `until` und nie länger als 30 Minuten im Voraus, auch wenn ein Schlüssel ohne Ablauf in Redis steht. Nach 30 Minuten gilt wieder der gespeicherte Token, ohne weiteren Aufruf.
- Die Kanal-Prüfung prüft beide Variablen selbst noch einmal. Ein Schlüssel in Redis ohne `YSOCIAL_TEST_ROUTES=true` oder für einen anderen Kanal hat keine Wirkung.
- Statt des Tokens bekommt `analytics` den festen Wert `ysocial-test-invalid-token`. Das Log zeigt `provider call analytics … result=auth_invalid test=invalid-token`.
- Die stündliche Kanal-Prüfung liest nur die Datenbank, der Schalter wirkt nur auf `DailyHealth`. Ablauf für A1: Schalter an, `DailyHealth` von Hand starten (oben), `channel.auth_invalid` kommt. Nach 30 Minuten oder nach `DELETE` den nächsten Lauf starten, `channel.reconnected` kommt.

## Inbox-Demo (Backend, PR 26, nur Staging)

Für die Meta-Screencasts (E25, W15, `docs/plattformen/meta.md` im Hub): Kommentare der letzten Instagram-Beiträge lesen, als Konto antworten, verbergen, löschen. Die Demo-Seite im Hub (PR 27) ruft diese Routen. Gespeichert wird nichts, es gibt keine Tabelle. Tickets und Ereignisse `inbox.*` an den Hub kommen später im Hub.

| Variable | Wert |
|---|---|
| `YSOCIAL_DEMO_INTEGRATIONS` | IDs der Kanäle, durch Komma getrennt, nur Y-Social-Kanäle auf Staging. Fehlt sie oder ist sie leer, antworten alle Inbox-Routen mit 404 wie eine unbekannte Route, schon vor der Token-Prüfung. Auf Prod nie setzen |

| Route | Wirkung |
|---|---|
| `GET /ysocial/inbox/integrations/:id/comments` | Die letzten 10 Beiträge des Kontos, je bis zu 50 Kommentare (neueste zuerst) mit ihren Antworten |
| `POST /ysocial/inbox/integrations/:id/comments/:commentId/replies` | Antwort als Konto, Body `{"message": "…"}`. 201 `{"integrationId":"…","commentId":"…","replyId":"…"}` |
| `POST /ysocial/inbox/integrations/:id/comments/:commentId/hide` | `{"hide": true}` verbirgt, `{"hide": false}` zeigt wieder. 200 `{…,"hidden":true}` |
| `DELETE /ysocial/inbox/integrations/:id/comments/:commentId` | Löscht, nur mit Body `{"confirmDelete": true}`. 200 `{…,"deleted":true}` |

Alle hinter `YsocialInboxDemoGuard` und `YsocialTokenGuard`. Die drei schreibenden Routen verlangen `X-Ysocial-Actor` mit denselben Regeln wie „Erneut versuchen“.

Antwort der Leseroute:

    {
      "integrationId": "…",
      "provider": "instagram",
      "fetchedAt": "2026-11-12T09:00:00.000Z",
      "posts": [{
        "id": "…", "permalink": "https://www.instagram.com/p/…", "timestamp": "…", "mediaType": "IMAGE", "commentsCount": 2,
        "comments": [{ "id": "…", "text": "…", "username": "…", "timestamp": "…", "likeCount": 0, "hidden": false, "replies": [] }]
      }]
    }

Ohne Bildunterschrift (`caption`): Posttext ist eine eigene Entscheidung wie bei der Lese-API. `commentsCount` kommt von Meta, zählt Antworten mit und kann größer sein als die Liste.

**Regeln**
- Jede Route prüft selbst, ob der Kanal in `YSOCIAL_DEMO_INTEGRATIONS` steht (Regel 9). Der Guard entscheidet nur, ob es die Routen gibt.
- Geschrieben wird nur auf einen Aufruf über die Route (Regel 2). Kein Workflow, kein Schedule, keine automatische Antwort. Der Hub prüft die Rolle der Person und schickt sie im Kopf mit.
- Vor jeder schreibenden Aktion prüft die Route an der Plattform, ob der Kommentar unter einem Beitrag dieses Kontos steht: Feld `media` des Kommentars (bei einer Antwort ohne `media` über `parent_id` der Kommentar darüber), dann `owner` des Beitrags gleich `internalId` des Kanals. Sonst 404 `comment_not_found`, und nichts ändert sich.
- Löschen ohne `"confirmDelete": true` ergibt 409 `confirmation_required`, ohne Plattformaufruf.
- Token: der Page-Token aus `Integration.token` (`<Page-Token>___<User-Token>`), wie `comment()` und `analytics()` des Postiz-Providers. Er steht nur in der Anfrage an Meta (Adresse bei `GET` und `DELETE`, Body bei `POST`), nie in Log oder Antwort. Der Antworttext geht im Body an Meta, nicht in der Adresse.

| Antwort | `code` | Wann |
|---|---|---|
| 404 | – | `YSOCIAL_DEMO_INTEGRATIONS` fehlt oder ist leer |
| 401, 503 | – | Service-Token falsch oder nicht konfiguriert, wie `/ysocial/status` |
| 400 | `actor_missing` | Schreibende Route ohne gültigen `X-Ysocial-Actor` |
| 400 | – | Body ungültig: `message` fehlt, ist leer oder länger als 2200 Zeichen, `hide` oder `confirmDelete` ist kein Boolean |
| 400 | `invalid_comment_id` | `commentId` besteht nicht nur aus Ziffern und `_` |
| 403 | `not_demo_integration` | Kanal steht nicht in der Liste |
| 404 | `not_found` | Kanal unbekannt |
| 404 | `comment_not_found` | Kommentar steht nicht unter einem Beitrag dieses Kontos, Meta kennt ihn nicht (Code 100, Subcode 33, etwa direkt nach dem Löschen) oder die ID hat ein `_` (Instagram-IDs bestehen nur aus Ziffern) |
| 409 | `confirmation_required` | Löschen ohne Bestätigung |
| 409 | `channel_inactive` | Kanal gelöscht, `disabled`, `refreshNeeded` oder `inBetweenSteps`, steht in `flag` |
| 409 | `provider_not_supported` | Kanal ohne Inbox, steht in `provider`. Zurzeit nur `instagram` |
| 502 | `platform_error` | Meta lehnt ab (beim Schreiben nur Antworten unter 500): `platformStatus`, `platformCode`, `platformSubcode` und `reason`, die Meldung von Meta, bereinigt wie `reason` bei Ereignissen |
| 500 | `internal_error` | Unerwarteter Fehler, etwa Datenbank oder Entschlüsselung des Tokens. Im Log nur der Name der Fehlerklasse, bei Prisma dazu der Code (`P1001` und so weiter). Als `HttpException` geht er nicht an den Sentry-Filter von Postiz, der den Body der Anfrage (den Antworttext) mitschicken würde |
| 503 | `platform_unavailable` | Meta beim Lesen oder bei der Prüfung vor dem Schreiben nicht erreichbar oder keine Antwort nach 15 s. Nichts geändert |
| 503 | `outcome_unknown` | Keine klare Antwort von Meta auf das Schreiben selbst: Netzfehler, 15 s ohne Antwort oder ein Fehler 5xx von Meta (im Log dann mit Status und Codes). Meta hat es vielleicht trotzdem getan. Der Hub wiederholt den Aufruf nicht von selbst, sondern lädt die Kommentare neu und zeigt den Stand |

Dauer: Jede Anfrage an Meta bricht nach 15 s ab. Lesen braucht 1 Anfrage für die Beiträge und bis zu 10 parallel für die Kommentare, also höchstens etwa 30 s. Schreiben macht bis zu 4 Anfragen nacheinander (Kommentar, Kommentar darüber, Beitrag, Schreiben), also höchstens etwa 60 s. Der Hub wartet mindestens so lange. Bricht er vorher ab, läuft das Schreiben im Fork trotzdem weiter.

Im Log steht je Aufruf nur, was eine Prüfung bestanden hat, die Person und Zahlen: `inbox comments channel=<id> result=ok posts=<n> comments=<n>` und `inbox <reply|hide|unhide|delete> channel=<id> comment=<commentId> actor=<X-Ysocial-Actor> result=<done|rejected code=…>`. Bei `platform_error` stehen dort Status und Codes von Meta, nie ihre Meldung. Kommentartext, Namen der Kommentierenden und Antworttext stehen nie im Log. Eine Kanal-ID, die nicht in der Liste steht, und eine ungültige Kommentar-ID stehen dort als `-`.

**Endpunkte und Rechte** laut offizieller Meta-Referenz (Instagram API with Facebook Login, gelesen am 12.11.2026, Links im Kopf von `libraries/ysocial/src/inbox/instagram.inbox.ts`):

| Aufruf | Rechte |
|---|---|
| `GET /{ig-user-id}/media` | `instagram_basic`, `pages_read_engagement` oder `pages_show_list` |
| `GET /{ig-media-id}/comments` mit Feld `replies` | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` |
| `GET /{ig-comment-id}`, `GET /{ig-media-id}` (Prüfung vor dem Schreiben) | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` |
| `POST /{ig-comment-id}/replies` | `instagram_basic`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement` |
| `POST /{ig-comment-id}` mit `hide`, `DELETE /{ig-comment-id}` | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`. Nur der Besitzer des Beitrags |

Der Postiz-Provider `instagram` fragt alle diese Rechte schon an (`instagram.provider.ts`, `scopes`), es braucht keinen Patch.

**Grenzen laut Meta**
- Antworten nur auf Kommentare der obersten Ebene. Eine Antwort auf eine Antwort hängt Meta an den Kommentar darüber. Keine Antwort auf verborgene Kommentare und unter Live-Videos.
- Kommentare des Kontos selbst bleiben sichtbar, auch wenn sie verborgen sind.
- Höchstens 50 Kommentare je Beitrag und Abruf, die Demo blättert nicht weiter. Ob verborgene Kommentare in der Liste stehen, sagt die Doku nicht (**ungeprüft**, auf Staging prüfen).
- Ob eine Antwort das Feld `media` trägt, sagt die Doku nicht. Deshalb der Weg über `parent_id`.
- `owner` gibt Meta nur zurück, wenn „the app user making the query also created the media“. Ob das mit dem Page-Token gilt, ist **ungeprüft**. Gilt es nicht, enden alle schreibenden Aufrufe mit 404 `comment_not_found`, ohne etwas zu ändern (fail-closed). PLAN QA 2 auf Staging zeigt es.
- Je Kommentar liest die Demo nur die erste Seite der Antworten in der Standardgröße von Meta.
- Meta nennt für diese Aufrufe teils den User-Token (Referenz), teils den Page-Token (Leitfaden zur Moderation). Die Demo nimmt den Page-Token wie Postiz.
- Webhooks für Instagram-Kommentare gibt es erst mit Advanced Access (`meta.md` 2.6). Bis dahin liest die Demo auf Abruf.

**Facebook** fehlt mit Absicht. Kommentare einer Seite lesen braucht laut Meta `pages_read_user_content` („read user generated content on the Page, such as posts, comments, and ratings“, Permissions Reference). Der Postiz-Provider `facebook` fragt es nicht an (W10). `facebook.inbox.ts` kommt erst, wenn das Recht da ist: als Patch 4 nur mit Florians Zustimmung (E25), sonst in Phase 3.

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
- Gegen echtes Prisma und Postgres, sonst übersprungen: `YSOCIAL_IT_DATABASE_URL=… pnpm exec jest -c libraries/ysocial/jest.config.js ysocial.token.integration`, siehe `docs/YSOCIAL-LOKAL.md`. In GitHub läuft er bei jedem PR.
- Gegen einen echten Temporal-Server, sonst übersprungen: `YSOCIAL_IT_TEMPORAL_ADDRESS=127.0.0.1:7233 pnpm exec jest -c libraries/ysocial/jest.config.js ysocial.worker.integration`. Der Namespace `ysocial` muss existieren (`temporal operator namespace create --namespace ysocial`). Der Test startet den echten Worker, einen Mock-Hub, der beim ersten Versuch 503 antwortet, einen Ping und eine PostVerification mit zwei erfundenen Posts aus einem gestellten Dienst, ohne Datenbank. Er legt den Schedule an und löscht ihn am Ende wieder.
- Zeitraffer für PostVerification: `ysocial.verify.post.workflow.spec.ts` und für die neue Version `ysocial.verify.post.workflow.v1.0.1.spec.ts`. `sleep` stellt dort die Uhr vor, statt zu warten.
- Der Bundler von Temporal liest beim Test die TypeScript-Quellen. Die `.swcrc` von Postiz in `apps/orchestrator/` hat einen `baseUrl` von einem fremden Rechner, der Test schaltet sie für den Bundler ab. Im Betrieb bündelt der Worker das kompilierte JavaScript aus `dist`, dort spielt die Datei keine Rolle.
