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

Außerdem hängt `YsocialTokenKeyCheck` (aus `libraries/ysocial/src/tokens/`) im Modul, siehe „Verschlüsselte Kanal-Tokens“ unten. Der Payload-Codec für Temporal hängt nicht hier, sondern über Patch 6 im TemporalModule von Postiz, siehe „Verschlüsselte Temporal-Payloads“.

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

Fehlt etwas, startet Postiz normal. Im Log steht einmal `ysocial worker off:` mit den fehlenden Namen, nie mit Werten. Schlägt der Start fehl oder bricht der Worker ab, startet er nach 30 s neu, danach mit doppelter Pause bis höchstens 10 Minuten. Ein Fehler des ysocial-Workers beendet nie den Orchestrator. Die einzigen Ausnahmen sind die Startprüfungen des Token-Schlüssels und des Temporal-Schlüssels (unten).

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
- `channel.auth_invalid`: „Zugang ungültig“ ändert den Kanal in Postiz nicht, `updatedAt` bleibt. „Beginn“ ist der Zeitpunkt aus dem Lauf, der den Vorfall zuerst sieht (`since` in `ysocial:channel-problems`, siehe unten). Ab 0.7.4 ist es der Zeitpunkt, zu dem dieser Lauf nach den Plattformaufrufen verglichen hat, vorher der Start des Laufs. Er bleibt, solange der Vorfall dauert. Ein neuer Vorfall nach `channel.reconnected` bekommt einen neuen Beginn. `channel.reconnected` trägt den Beginn der Meldung, die es schließt. Wann „Zugang ungültig“ als gelöst gilt, steht unter „Kanal-Prüfung und DailyHealth“. Die Kennungen bleiben ab 0.7.5 gleich gebildet.

Zustellung: Jedes Ereignis bekommt einen eigenen Workflow `ysocial-event-<id>`. Die Aktivität `ysocialDeliverEvent` wiederholt ab 10 s mit doppelter Pause bis 15 Minuten, insgesamt bis 24 Stunden. Jede Wiederholung sendet dasselbe Ereignis mit derselben Kennung. Der Hub soll mit 202 antworten, auch für eine Kennung, die er schon kennt. 409 gilt ebenfalls als zugestellt. 400, 404, 405, 410, 413, 415 und 422 beenden die Zustellung, alle anderen Antworten und Netzfehler werden wiederholt. Ein zugestelltes Ereignis stellt Temporal kein zweites Mal zu. Eine gescheiterte Zustellung darf neu starten.

## PostVerification (PR 17, E22)

- Schedule `ysocial-post-verification` startet jede Minute `ysocialPostVerificationWorkflow`. Die Aktivität liest alle Posts mit Termin in den letzten 60 Minuten: nur der erste Post eines Threads, ohne Entwürfe, ohne gelöschte. Für jeden startet sie `ysocial-verify-<postId>`. Temporal lehnt eine zweite Prüfung desselben Posts ab, solange es den Lauf aufbewahrt. Eine eigene Tabelle gibt es nicht.
- `ysocialVerifyPostWorkflowV102` (ab 0.7.3) liest den Post jede Minute und entscheidet nach `libraries/ysocial/src/verification/post.verification.ts`. Die älteren Versionen bleiben unverändert für Läufe, die vorher gestartet wurden: `ysocialVerifyPostWorkflowV101` (0.7.1) rechnet die Fristen auch nach „Erneut versuchen“ ab dem Termin, `ysocialVerifyPostWorkflow` meldet außerdem `post.failed` je Lauf nur einmal, mit der Kennung `post.failed:<postId>:<Termin in ms>`:

| Zustand | Ergebnis |
|---|---|
| `ERROR` | sofort `post.failed`. Steht der Post bei einer Nachschau mit anderem `updatedAt` auf `ERROR`, wieder `post.failed` mit neuer Kennung |
| `QUEUE` ab Termin + 3 min | `post.not_published`. Nach „Erneut versuchen“: ab Retry + 3 min |
| `PUBLISHED` | Prüfung auf der Plattform: gefunden `post.verified`, nicht prüfbar `post.unverifiable`, nicht gefunden ab Termin + 4 min `post.not_found`. War vorher `post.failed` oder `post.not_published` gemeldet: ab Veröffentlichung + 4 min |
| gelöscht, Entwurf, neuer Termin | ohne Meldung vorher nichts, sonst `post.resolved` |

- Nach einer Meldung schaut der Workflow nach 1, 2, 5, 10, 15 und 30 Minuten wieder nach, dann stündlich, 24 Stunden lang. Geht der Post in dieser Zeit raus, kommt `post.verified` und der Alarm schließt sich.
- „Erneut versuchen“ erkennt der Workflow daran, dass ein Post nach `post.failed` wieder auf `QUEUE` steht. Die Retry-Route setzt `QUEUE`, Postiz setzt beim Veröffentlichen `PUBLISHED`. Beides schreibt die Zeile, also nennt `updatedAt` den Zeitpunkt. Es zählt der erste Wert, den der Workflow im Zustand sieht. Spätere Schreibzugriffe, etwa Medien oder Statistik, verschieben die Frist nicht. Ein neues `post.failed` setzt beide Zeitpunkte zurück, ein weiterer Retry bekommt eigene.
- Ab dem Retry gelten die Fristen aus der Tabelle, und die 24 Stunden der Nachschau beginnen neu. Bis zur Frist schaut der Workflow auf `QUEUE` jede Minute nach. Den Retry bemerkt er aber erst bei der nächsten Nachschau, nach der ersten Stunde also bis zu 60 Minuten später. Dann kann `post.not_published` sofort kommen.
- Steht der Post 3 Minuten nach dem Retry noch auf `QUEUE`, kommt `post.not_published` mit dem Grund „3 Minuten nach „Erneut versuchen“ noch auf „geplant““. Im Hub ersetzt es den Alarm „fehlgeschlagen“.
- Findet die Plattform den Post 4 Minuten nach dem Veröffentlichen nicht, kommt `post.not_found` mit dem Grund „4 Minuten nach dem Veröffentlichen“. Das gilt auch für einen verspäteten Post ohne Retry, für den `post.not_published` gemeldet war.
- `ysocialVerifyPostWorkflowV101` rechnet ab dem Termin. Nach einem Retry, der Stunden später rausgeht, meldet er sofort `post.not_found`, wenn die Plattform den Post in der ersten Minute noch nicht findet.
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

**DailyHealth**, Schedule `ysocial-daily-health`, täglich um 07:00 Uhr Europe/Berlin. Temporal startet den Lauf um 07:00 auch, wenn der Worker aus ist. Der Lauf wartet dann auf den Worker, ab 0.7.2 bis 09:00 (Zeitlimit 2 Stunden, vorher 1 Stunde). Kommt der Worker erst nach etwa 08:10 zurück, kann ein langer Lauf (bis 51 Minuten) an das Zeitlimit stoßen. Das Nachholen bis 09:00 (`catchupWindow`) gilt nur, wenn der Temporal-Server selbst um 07:00 aus war. Ab 0.7.2 startet der Schedule `ysocialDailyHealthWorkflowV101`. Der Worker stellt einen vorhandenen Schedule beim Start darauf um. `ysocialDailyHealthWorkflow` und seine Aktivität `ysocialRunDailyHealth` bleiben mit Namen, Parametern und Form des Ergebnisses erhalten, für Läufe, die vorher gestartet wurden. Ab 0.7.4 liest auch `ysocialRunDailyHealth` die Kanäle neu (unten). Je Kanal ohne gelöschtes Datum:

- Felder wie bei der Kanal-Prüfung, dazu der Ablauf des Zugangs: `channel.token_expiring` ab 7 Tagen vorher.
- Genau ein lesender Plattformaufruf über die Provider-Methode `analytics` für einen Tag. Kanäle mit gesetztem Feld oder abgelaufenem Zugang und Provider ohne `analytics` bekommen keinen Aufruf. Bei Instagram macht die Provider-Methode intern zwei Anfragen an die Graph API.
- Die Plattformaufrufe laufen nacheinander und können bis zu 20 Minuten dauern. Ab 0.7.4 liest `DailyHealth` die Kanäle danach neu aus der Datenbank. Erst dann vergleicht es mit dem Zustand in Redis und bildet die Ablaufhinweise. So meldet es kein falsches `channel.reconnected` für einen Kanal, den die stündliche Prüfung in der Zwischenzeit als getrennt gemeldet hat. Hat sich ein Kanal seit dem Lesen geändert (anderes `updatedAt`, etwa neu verbunden oder Token erneuert), zählt sein Plattformergebnis nicht, denn es gehört zum alten Stand. Der Kanal wird dann nur nach seinen Feldern beurteilt wie bei der stündlichen Prüfung, und der nächste Tageslauf prüft ihn wieder. Ein offenes „Zugang ungültig“ schließt dann nur ein neuer Zugang (unten). Die Kanal-Ereignisse (`disconnected`, `reconnected`, `removed`, `auth_invalid`) tragen als `occurredAt` den Zeitpunkt dieses Vergleichs, nicht den Beginn des Laufs. Der Hub ordnet nach diesem Zeitpunkt, und eine Meldung der stündlichen Prüfung aus der Zwischenzeit muss älter bleiben. Ablaufhinweise und `health.daily` tragen den Beginn des Laufs. Die Zähler `platformCalls` und `skipped` gehören zum ersten Lesen. `unclear` nennt nur Kanäle, die es beim zweiten Lesen noch unverändert gibt. In der Praxis dauert die Schleife wenige Minuten, 1 bis 2 Sekunden je Kanal. Die stündliche Prüfung um Viertel nach fällt also selten in diese Zeit.
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

Welche Kanäle gemeldet sind, merkt sich der Worker im Redis von Postiz unter `ysocial:channel-problems`, keine Tabelle. So kann er „wieder verbunden“ melden.

„Zugang ungültig“ gilt als gelöst, wenn der Kanal einen neuen Zugang hat oder der nächste Tageslauf in Ordnung ist. Beides prüfen die stündliche Kanal-Prüfung und `DailyHealth` mit derselben Regel (`diffChannels` in `libraries/ysocial/src/health/channel.health.ts`). Den neuen Zugang erkennt der Worker an `tokenExpiration`, ohne das Token zu lesen: Postiz schreibt das Feld bei jedem neuen Token mit Ablaufdatum neu, beim Verbinden, beim Neuverbinden, bei der Seitenauswahl und beim Token-Refresh, und sonst nie. Beim Melden merkt sich der Worker `tokenExpiration` in `ysocial:channel-problems`. Lehnt ein späterer Tageslauf den Zugang weiter ab, merkt er sich den Wert, den er gerade geprüft hat. Kennung und Beginn bleiben dabei. So schließt ein Token, das schon vor dem Tageslauf kam und ebenfalls abgelehnt wurde, den Alarm danach nicht. Das ist ein Datum, kein Geheimnis. Es geht weder ins Ereignis noch ins Log. Bei `ysocialDailyHealthWorkflowV101` steht es wie der übrige Zustand in `changes`, also im Ergebnis von `ysocialPrepareDailyHealth` und in der Eingabe von `ysocialSaveChannelProblems` in der Temporal-Historie. Ändert sich der Kanal nur anders, etwa Name, Posting-Zeiten, Kunde, Einstellungen oder das Verschlüsseln der Tokens (`ysocial.token.migration.service.ts`), bleibt der Alarm offen. Bis 0.7.4 reichte jedes neuere `updatedAt`. Dann kam „Gelöst“, und am nächsten Morgen derselbe Alarm neu.

Grenzen:
- Meldungen aus 0.7.4 oder älter tragen kein `tokenExpiration`. Sie schließt erst der nächste Tageslauf, der den Zugang annimmt, auch wenn der Kanal vorher neu verbunden wurde. Lehnt der Tageslauf ihn weiter ab, merkt er sich `tokenExpiration`, ab dann gilt die Regel oben.
- Ein neues Token mit unverändertem `tokenExpiration` erkennt die stündliche Prüfung nicht. Das geschieht nur, wenn beim Verbinden oder beim Refresh `expiresIn` als 0, `null` oder `NaN` ankommt. Fehlt `expiresIn` ganz, nimmt Postiz einen Standardwert und schreibt ein neues Datum. Im Code der Provider steht 0 nur in leeren `refreshToken`-Antworten, die Postiz verwirft. Provider, die `expires_in` der Plattform durchreichen, könnten aber `null` liefern. Auch dann schließt der nächste Tageslauf den Alarm, wenn die Plattform den Zugang annimmt.
- Ein Token-Refresh gilt als neuer Zugang. Nimmt die Plattform auch das neue Token nicht an, meldet der nächste Tageslauf „Zugang ungültig“ mit neuem Beginn.
- Kam das neue Token vor dem Tageslauf und sieht die stündliche Prüfung es erst, während der Tageslauf läuft, schließt sie den Alarm. Liest der Tageslauf den Zustand danach, meldet er ihn gleich wieder, wenn die Plattform auch das neue Token ablehnt. Läuft sie bei `ysocialDailyHealthWorkflowV101` zwischen Prüfen und Speichern (wenige Sekunden), bleibt der Alarm bis zum nächsten Tageslauf geschlossen.

Geht der Schlüssel verloren, meldet der nächste Lauf die aktuellen Probleme noch einmal. `channel.disconnected` hat dann dieselbe Kennung, der Hub zählt es einmal. `channel.auth_invalid` bekommt einen neuen Beginn und damit eine neue Kennung, der Hub zählt es beim offenen Alarm mit.

Wann `DailyHealth` den Zustand speichert (ab 0.7.2, `ysocialDailyHealthWorkflowV101`):
1. `ysocialPrepareDailyHealth` prüft die Kanäle und Posts und bildet die Ereignisse. Sie speichert nichts. Scheitert sie und Temporal wiederholt sie, findet der zweite Versuch dieselben Probleme noch ungemeldet und meldet sie.
2. Der Workflow übergibt jedes Ereignis an seine Zustellung.
3. Erst dann speichert `ysocialSaveChannelProblems` den Zustand. Sie liest Redis neu und schreibt nur die Kanäle, die dieser Lauf geändert hat, und nur, wenn dort noch der Stand steht, von dem der Lauf ausging. Hat die stündliche Kanal-Prüfung einen Kanal in der Zwischenzeit geändert, bleibt ihr Stand, sie hatte die neueren Daten. Der nächste Lauf vergleicht dann wieder. Ohne Änderung schreibt sie nichts. Antwortet Redis nicht, wiederholt Temporal den Schritt bis zu 10 Minuten lang.

Scheitert Schritt 1 oder 2, ist nichts gespeichert, und ein neuer Versuch oder der nächste Lauf meldet die Probleme noch einmal. Eine Meldung kann doppelt kommen, ein Problem geht nicht verloren. Bleibt Redis länger als 10 Minuten weg und Schritt 3 scheitert ganz, oder erreicht der Lauf vor Schritt 3 sein Zeitlimit, fehlen dem Zustand die neuen Probleme dieses Laufs. Der nächste Lauf meldet sie noch einmal, solange sie bestehen. Ist eines bis dahin gelöst, kommt kein `channel.reconnected`, und der Alarm im Hub bleibt offen, bis jemand ihn schließt.

`ysocialDailyHealthWorkflow` speichert vor dem Senden. Scheitert seine Aktivität danach und wird wiederholt, gilt das Problem als gemeldet, und die Meldung geht verloren. Die stündliche Kanal-Prüfung liest und schreibt in einer Aktivität ohne weiteren Schritt danach, dort bleibt es beim alten Ablauf.

Im Log steht je Plattformaufruf `provider call analytics provider=<id> channel=<integrationId> result=<ok|auth_invalid|unclear>` und je Tageslauf `daily health: channels=<n> platform calls=<n> skipped=<n>`.

Läufe von Hand (A1, PR 18 QA 3):

    temporal workflow start --namespace ysocial --task-queue ysocial-postiz --type ysocialDailyHealthWorkflowV101 --workflow-id ysocial-daily-health-hand
    temporal workflow start --namespace ysocial --task-queue ysocial-postiz --type ysocialChannelCheckWorkflow --workflow-id ysocial-channel-check-hand

Für einen zweiten Lauf eine neue Workflow-ID nehmen, zum Beispiel mit Uhrzeit. `DailyHealth` nicht von Hand starten, solange der geplante Lauf um 07:00 noch läuft: Ändern beide denselben Kanal verschieden, gilt der Stand, der zuerst gespeichert wird, nicht der neuere, und ein Alarm kann offen bleiben oder fälschlich schließen.

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
- Postiz gibt ganze Kanal-Zeilen an seine Aktivitäten weiter (`refresh.token.workflow.ts`, `post.workflow.v1.0.1.ts` Z. 198–204), die Aktivität liest sie entschlüsselt. Ohne `YSOCIAL_TEMPORAL_KEY` steht der Token deshalb im Klartext im Temporal-Verlauf. Seit PR 40 verschlüsselt der Payload-Codec den Verlauf, siehe den nächsten Abschnitt.
- Die Fluent-API von Prisma (`post.findUnique().integration()`) gibt die Chiffre zurück, Raw-Queries gehen an der Erweiterung vorbei. Postiz nutzt beides nicht. `ysocial.token.bypass.spec.ts` prüft die Quellen bei jedem PR.
- Ein Schlüsselwechsel (Rotation) gehört nicht zu PR 25.

## Verschlüsselte Temporal-Payloads (PR 40, E51)

Postiz gibt ganze Kanal-Zeilen samt Token an seine Aktivitäten weiter. Fehler der Provider tragen den Request-Body in `details` und manchmal die Adresse mit `access_token` in der Meldung. Sobald `YSOCIAL_TEMPORAL_KEY` gesetzt ist, verschlüsselt ein Payload-Codec das alles im Namespace von Postiz (`TEMPORAL_NAMESPACE`, Standard `default`). Die Logik liegt in `libraries/ysocial/src/temporal/`, eingehängt über Patch 6 in `libraries/nestjs-libraries/src/temporal/temporal.module.ts`. Er gilt für Backend und Orchestrator, denn beide nutzen dieses Modul.

**Verschlüsselt:** Eingaben und Ergebnisse von Workflows und Aktivitäten, Signale, Heartbeats, `details` von Fehlern. Dazu Meldung und Stacktrace jedes Fehlers der Kette (`failure.converter.ts`, wie `encodeCommonAttributes` von Temporal, aber für jede Ebene). Format: der ganze Payload als Protobuf, AES-256-GCM, Metadaten `encoding: binary/encrypted` und `encryption-key-id: <kid>` wie im Verschlüsselungs-Beispiel von Temporal. Abweichend vom Beispiel steht in `data` `iv | tag | Chiffre`, und die zusätzlichen Daten (AAD) binden sie an die Schlüssel-ID (`binary/encrypted:<kid>`). Ein späterer Codec-Server muss das so lesen. `<kid>` wird gebildet wie beim Token-Schlüssel: die ersten 8 Hex-Zeichen von SHA-256 über die 32 Byte.

**Lesbar bleiben:** Workflow-IDs und -Typen, Task-Queues, Suchattribute (`postId`, `organizationId`, Postiz sucht danach), Zeiten und Status. `temporal workflow list`, `count` und `terminate` und die Skripte des Hubs (`restore-workflows.sh`) gehen wie bisher. `Post.error` behält sein Format: Der Workflow sieht die Fehler entschlüsselt, mit derselben Kette wie ohne Codec. Ein Test belegt, dass `JSON.stringify` des Fehlers Zeichen für Zeichen gleich bleibt.

| Wer | Wie |
|---|---|
| Worker des Orchestrators (`main`, Provider-Queues, E-Mail-Queues) | `workerOptions.dataConverter` für jeden Eintrag in `workers`, `nestjs-temporal-core` reicht ihn an `Worker.create` weiter |
| Client in Backend und Orchestrator (`TemporalService`, etwa `handle.result()` in `media.service.ts`, Workflow-Starts aus Aktivitäten) | `nestjs-temporal-core` nimmt für den Client keinen `dataConverter`. Der Wrapper ersetzt den Provider `TEMPORAL_CLIENT` durch einen Client auf derselben Verbindung mit Codec |
| ysocial-Worker, `ysocial.temporal.client.ts`, `hub-worker` (Namespace `ysocial`) | ohne Codec. Ihre Ein- und Ausgaben tragen keine Tokens, die Kanal-Prüfung liest den Token nur in der Aktivität. Fehler eines Provider-Aufrufs gehen aber unverändert in den Verlauf: Scheitert `postAnalytics` in `ysocialCheckPostOnPlatform` mit `BadBody`, stehen Antwort und Request-Body der Plattform in `details`. Die Prüfungen rufen nur lesend mit GET ab, der Body ist dort leer, und die Meldung von `fetch` enthält keine Adresse. Restrisiko klein, kein Codec nach Entscheidung PR 40 |
| Temporal-UI und CLI | ohne Codec-Server, die UI hat keine Anmeldung. Payloads zeigen `binary/encrypted`, Fehler „Encoded failure“. Zur Fehlersuche dienen die Logs der Container |

**Startprüfung**, fail-closed wie beim Token-Schlüssel. Sie läuft in Backend und Orchestrator, bevor ein Port oder ein Worker startet. Schlägt sie fehl, endet der Prozess mit Exit-Code 1, pm2 startet ihn neu. Sobald der Codec im Namespace lief, merkt sich der Namespace die Schlüssel-ID in seinen Daten (`ysocial-payload-codec`, zu sehen mit `temporal operator namespace describe --namespace default`). Die Markierung liegt in der Datenbank von Temporal und kommt mit jeder Sicherung zurück.

| Markierung | `YSOCIAL_TEMPORAL_KEY` | Ergebnis, Log |
|---|---|---|
| keine oder `off` | fehlt | Codec aus, Postiz wie bisher: `temporal codec off: …` |
| keine oder `off` | gesetzt | Codec an, Markierung gesetzt: `temporal codec on (key <kid>, namespace default marked)` |
| `<kid>` | derselbe Schlüssel | Codec an: `temporal codec on (key <kid>)` |
| `<kid>` | fehlt | kein Start: `temporal codec check failed: YSOCIAL_TEMPORAL_KEY fehlt: Namespace default ist mit Schlüssel <kid> verschlüsselt …` |
| `<kid>` | anderer Schlüssel | kein Start: `… YSOCIAL_TEMPORAL_KEY passt nicht: Namespace default ist mit Schlüssel <kid> verschlüsselt, YSOCIAL_TEMPORAL_KEY hat <kid>` |
| egal | nicht 32 Byte als Base64, oder gleich `YSOCIAL_TOKEN_KEY` | kein Start: `… ist ungültig …` oder `… derselbe Schlüssel wie YSOCIAL_TOKEN_KEY …` |
| Temporal antwortet nicht | egal | kein Start nach 3 Versuchen, etwa 1 Minute: `… Temporal nicht erreichbar … (gRPC-Status <Zahl>) …`. Fehlt der Namespace: `… Namespace default gibt es in Temporal nicht (gRPC-Status 5) …` |
| Markierung lässt sich nicht setzen | gesetzt | kein Start: `… Markierung im Namespace default nicht gesetzt (gRPC-Status <Zahl>) …` |
| `nestjs-temporal-core` liefert keinen Client | egal | kein Start: `… Temporal-Client fehlt …`. Die Worker würden sonst ohne Prüfung starten |

**Neues Startverhalten ab 0.9.2:** Backend und Orchestrator starten nur noch, wenn Temporal beim Start antwortet, auch ohne Schlüssel. Bisher lief Postiz ohne Temporal an und meldete nur Fehler. Ohne Antwort weiß Postiz nicht, ob der Namespace markiert ist. Es könnte sonst neben verschlüsselten Verläufen still Klartext schreiben und die laufenden Workflows nicht lesen. Planen und Posten geht ohne Temporal ohnehin nicht. Postiz startet neu, bis Temporal antwortet.

**Einschalten** an einem Tag mit wenigen geplanten Posts (R50). Die Hub-Seite folgt mit Hub-PR 41.
1. Image mit PR 40 ausrollen, noch ohne Schlüssel. Im Log zweimal `temporal codec off`.
2. Florian erzeugt je Umgebung einen eigenen Schlüssel (`openssl rand -base64 32`, nicht den Token-Schlüssel) und legt ihn mit der Schlüssel-ID in den Passwortmanager. Backend und Orchestrator bekommen denselben Wert.
3. Postiz neu starten. Im Log zweimal `temporal codec on (key <kid>…)`, beim ersten mit `namespace default marked`.
4. Ein neuer Workflow zeigt bei `temporal workflow show --namespace default --workflow-id <ID>` die Zeile `ResultEncoding binary/encrypted`. Ein Testpost geht raus. Workflows, die vorher liefen, laufen weiter: Alte Klartext-Payloads liest der Codec unverändert, neue schreibt er verschlüsselt.

**Grenzen:**
- Ist der Codec an, gibt es kein Rollback auf ein Image ohne PR 40. Ein solches Image kann `binary/encrypted` nicht lesen: Workflows hängen, Aktivitäten scheitern an ihrer Eingabe, Posts können auf `ERROR` gehen.
- Geht der Schlüssel verloren, sind laufende Workflows im Postiz-Namespace nicht mehr lesbar. Dann alle laufenden Workflows dort beenden, die Markierung auf `off` setzen (unten) und geplante Posts neu einplanen. Der Sweep `missing-post-workflow` startet nur Posts der letzten 2 Tage neu.
- Mehrere Orchestratoren brauchen alle denselben Schlüssel, zur selben Zeit. Nach dem ersten Start verhindert die Markierung einen Start ohne Schlüssel.
- Altbestand: Verläufe von vor dem Codec bleiben Klartext, bis die Workflows enden und aus der Aufbewahrung fallen. In den Sicherungen von `temporal-postgres` stehen sie noch etwa 4 Wochen länger. Post-Workflows lesen den Kanal erst zum Termin, sie sind kaum betroffen. `refreshTokenWorkflow` hält die Kanal-Zeile von seinem Start bis zum Ablauf des Tokens. Möglich, aber nicht gebaut: die Refresh-Workflows über `RefreshIntegrationService.startRefreshWorkflow` von Postiz neu starten (`workflowIdConflictPolicy: TERMINATE_EXISTING`), wie Postiz es beim Neuverbinden tut. Der beendete Lauf bleibt bis zum Ende der Aufbewahrung im Verlauf.
- Abschalten geht nur, wenn kein verschlüsselter Lauf mehr läuft: `temporal operator namespace update --namespace default --data 'ysocial-payload-codec="off"'`, danach den Schlüssel entfernen.
- Ein Schlüsselwechsel (Rotation) gehört nicht zu PR 40.
- `@temporalio/proto` steht nicht in `package.json` von Postiz. Es kommt als Abhängigkeit von `@temporalio/common` in derselben Version, auflösbar über `node-linker=hoisted` (`.npmrc`). Fällt das weg, bricht der Bau ab.
- Ändert `nestjs-temporal-core` die Provider `TEMPORAL_MODULE_OPTIONS` (useValue) oder `TEMPORAL_CLIENT` (useFactory), wirft der Wrapper beim Laden, auch ohne Schlüssel. Tests prüfen das gegen das installierte `TemporalModule.register` und prüfen, dass `TemporalWorkerManagerService` den `dataConverter` an `Worker.create` gibt. Der Wrapper baut den Client nur mit `connection`, `namespace` und `dataConverter` neu. Weitere Client-Optionen, die `nestjs-temporal-core` künftig setzen könnte, übernimmt er nicht (Prüfliste in `YSOCIAL-PATCHES.md`).

Test gegen einen echten Temporal-Server, sonst übersprungen. Er nutzt nur den Namespace `ysocial-codec-it` und legt ihn selbst an:

    docker run --rm --name ysocial-codec-it -p 127.0.0.1:7233:7233 --entrypoint temporal temporalio/auto-setup:1.28.1 server start-dev --ip 0.0.0.0 --headless
    YSOCIAL_IT_TEMPORAL_ADDRESS=127.0.0.1:7233 pnpm exec jest -c libraries/ysocial/jest.config.js ysocial.temporal.codec.integration

Er belegt: Ein Lauf, der ohne Codec beginnt, läuft nach dem Einschalten weiter. Im Verlauf eines neuen Laufs steht der Token nirgends, auch nicht in Fehlermeldungen. Das Fehler-JSON im Workflow ist dasselbe wie ohne Codec. Ein Client ohne Codec kann die Ergebnisse nicht lesen. Die Startprüfung weist ohne und mit falschem Schlüssel ab.

## Lese-API für den Hub (Backend, PR 18, Inhalt seit PR 36)

Hinter `YsocialTokenGuard` wie `/ysocial/status`, von außen gesperrt (`/api/ysocial/*`):

| Route | Inhalt |
|---|---|
| `GET /ysocial/customers` | Postiz-Customers ohne gelöschte: `id`, `orgId`, `name`, `createdAt`, `updatedAt` |
| `GET /ysocial/integrations` | Kanäle ohne gelöschte: `id`, `organizationId`, `customerId`, `name`, `customName`, `picture`, `profile`, `providerIdentifier`, `type`, `disabled`, `refreshNeeded`, `inBetweenSteps`, `tokenExpiration`, `createdAt`, `updatedAt`, dazu `status` (`ok`, `refresh_needed`, `in_between_steps`, `disabled`) |
| `GET /ysocial/posts?from=&to=` | Posts ohne gelöschte mit Termin ab `from` bis vor `to` (ISO 8601, höchstens 31 Tage, höchstens 2000 Posts): `id`, `organizationId`, `integrationId`, `group`, `parentPostId`, `state`, `publishDate`, `intervalInDays` (ab 0.8.2, Abstand der Wiederholung in Tagen, `null` ohne Wiederholung, Kommentare tragen denselben Wert wie ihr Post), `content`, `image`, `releaseURL`, `error` (bereinigt), `createdAt`, `updatedAt`. Kommentare eines Threads stehen als eigene Zeilen mit `parentPostId` darin |
| `GET /ysocial/posts/:id` | Ein Post ohne gelöschte mit denselben Feldern, dazu `comments`: die Kommentare seines Threads in Reihenfolge, je mit denselben Feldern. 404 `{"statusCode":404,"code":"not_found"}`, wenn es den Post nicht gibt oder er gelöscht ist |

Posttext und Medien seit PR 36 (E52), nur für `hub-web` im Docker-Netz:
- `content` ist der Text, wie Postiz ihn speichert, meist HTML aus dem Editor. Postiz wandelt ihn erst beim Posten je Plattform um (`stripHtmlValidation`) und entfernt Links bei manchen Plattformen schon beim Speichern.
- `image` ist eine Liste `[{"path":"…","type":"image"|"video"}]`, leer ohne Medien. `path` ist die gespeicherte Adresse der Datei. Postiz speichert keinen Typ am Post. `video` heißt wie bei Postiz (`VideoOrImage`, die Provider): Der Pfad enthält `.mp4`. Alles andere gilt als `image`. Weitere Felder der Medien (`id`, `alt`, `thumbnail`) gehen nicht raus.

Kommentare eines Threads: Postiz legt je Kanal eine Gruppe an (`PostsRepository.createOrUpdatePost`). Der erste Wert im Editor ist der Post, jeder weitere ein eigener Post derselben Gruppe mit `parentPostId` auf den vorigen. Der Workflow veröffentlicht den ersten Post und die weiteren danach über `comment()` des Providers, je nach Plattform als Antwort im Thread (X, Threads, Bluesky) oder als Kommentar (Facebook, Instagram, LinkedIn). `GET /ysocial/posts/:id` liest die Gruppe und folgt der Kette wie `PostsService.getPostsRecursively` vom angefragten Post nach unten. Bei der ID eines Kommentars kommen also dieser und die nach ihm. Nicht gemeint sind die Kommentare im Postiz-Editor (Tabelle `Comments`, Notizen des Teams am Post). Die liest die Lese-API nicht.

Nie dabei: `token`, `refreshToken`, `customInstanceDetails`, `settings`, `additionalSettings`, `internalId`. Die Feldlisten stehen in `libraries/ysocial/src/database/ysocial.read.repository.ts`, der Test in `apps/backend/src/ysocial/ysocial.read.controller.spec.ts` nennt jede Liste vollständig. Ein neues Feld lässt ihn scheitern. Die Lese-API schreibt nichts ins Log, also auch keinen Posttext.

## Erneut versuchen (Backend, PR 19)

`POST /ysocial/posts/:id/retry`, hinter `YsocialTokenGuard`, von außen gesperrt wie die Lese-API. Der Hub prüft die Rolle der Person (E32) und schickt sie im Kopf `X-Ysocial-Actor` mit.

    POST /ysocial/posts/<postId>/retry
    Authorization: Bearer <YSOCIAL_SERVICE_TOKEN>
    X-Ysocial-Actor: <wer im Hub geklickt hat>
    Content-Type: application/json

    {}                         oder bei unklarem Ausgang nach Rückfrage: {"confirmUnclear": true}

Die Route setzt den Post von `ERROR` auf `QUEUE` und ruft `PostsService.startWorkflow` von Postiz. Der startet `postWorkflowV112` wie beim Umplanen in Postiz. Die Route ruft nie selbst einen Provider auf, gepostet wird nur über den Workflow von Postiz.

- Vorher fragt sie Temporal mit derselben Abfrage wie `startWorkflow`, ob für den Post noch ein Workflow läuft (`postId="…" AND ExecutionStatus="Running"`). Postiz setzt `ERROR` und versucht es im selben Workflow noch einmal. `startWorkflow` würde diesen Workflow beenden, während sein Provider-Aufruf weiterläuft, und dann ein zweites Mal posten. Läuft ein Workflow, kommt 409 `workflow_running`. Das gilt auch, wenn ein wiederholter Post (`intervalInDays`) oder ein Plug noch wartet. Ab 0.8.2 kommt bei einem wiederholten Post mit Termin vor mehr als 2 Stunden schon vorher `interval_reanchor`. Erst danach fragt die Route nach der Bestätigung eines unklaren Ausgangs. Niemand soll „noch nicht online“ bestätigen, während Postiz vielleicht gerade postet.
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
| 409 | `interval_reanchor` | Ab 0.8.2: wiederholter Post (`intervalInDays`), dessen Termin mehr als 2 Stunden zurückliegt. Postiz würde ihn nicht jetzt posten, siehe unten |
| 409 | `unclear_outcome` | Unklarer Ausgang ohne `"confirmUnclear": true`, `reason` siehe unten |
| 409 | `workflow_running` | Für den Post läuft noch ein Postiz-Workflow |
| 409 | `state_changed` | Der Post hat zwischen Lesen und Schreiben den Zustand gewechselt, zum Beispiel durch einen zweiten Klick |
| 503 | `temporal_unavailable` | Temporal antwortet nicht, nichts geändert |

Im Log steht je Aufruf `retry post=<postId> actor=<X-Ysocial-Actor> result=<started|rejected code=…>`, nach Bestätigung mit `confirmed=<reason>`. Posttext steht nie darin. Bei `not_found` steht dort `post=-`, der rohe Pfad kommt nie ins Log.

Für die Oberfläche (PR 23):
- Eine Bestätigung bei `reason: "published"` sendet den ganzen Post noch einmal, bei einem Thread auch den ersten Post.
- Wiederholte Posts (`intervalInDays`, ab 0.8.2, PLAN Phase 2 PR 37): Liegt der Termin mehr als 2 Stunden zurück, antwortet die Route 409 `interval_reanchor`. Sie ändert nichts und startet keinen Workflow. Postiz würde den Post beim Start auf die nächste Wiederholung verschieben und bis dahin warten (`reanchorInterval` und `REANCHOR_GRACE_MS` in `apps/orchestrator/src/activities/post.activity.ts`), „Erneut versuchen“ würde also nicht jetzt posten. Bis 0.8.1 blieb der Post dann auf `QUEUE`, und die Post-Prüfung meldete `post.not_published`. Bis 2 Stunden nach dem Termin geht der Retry wie bisher durch, genau 2 Stunden zählen noch dazu wie bei Postiz. Die Route prüft beim Klick, Postiz erst in der Aktivität `getPost` am Anfang des Workflows. Dazwischen liegen `queueFailedPost`, `startWorkflow`, die Warteschlange des Workers und `getPost` selbst mit bis zu 3 Versuchen im Abstand von 2 Minuten (`proxyActivities` in `post.workflow.v1.1.2.ts`), im schlechten Fall also Minuten. Ein Retry kurz vor der Grenze kann deshalb doch verschoben werden und bleibt dann auf `QUEUE` wie bis 0.8.1. Einen Sicherheitsabstand gibt es bewusst nicht, die Grenze ist die von Postiz (PLAN Phase 2 PR 37).
- Termin ist `publishDate` in der Datenbank. Bei einem wiederholten Post bleibt das der erste Termin, auch nach vielen Wiederholungen (Postiz rechnet die weiteren nur im Workflow aus). Scheitert eine spätere Wiederholung, liegt der Termin also fast immer mehr als 2 Stunden zurück, und die Route weist ab. Nach einem Fehlschlag plant `postWorkflowV112` in der Regel keine weitere Wiederholung, sie ruht dann, bis jemand den Post in Postiz neu einplant. Randfall: Scheitert ein Kommentar des Threads mit einem sonstigen Fehler (`unknown` in `handleActivityError`), setzt `changeState` den ersten Post auf `ERROR`. Gelingt einer der weiteren Versuche, läuft der Workflow weiter und plant die nächste Wiederholung trotzdem. Die Route antwortet auch dann `interval_reanchor` und ändert nichts. Die Lese-API liefert dafür `intervalInDays`, die Post-Ansicht kann den Fall vor dem Klick erklären (PA11).
- Der alte Fehlertext bleibt bei `QUEUE` im Feld `error` stehen, die Lese-API zeigt ihn weiter.
- Nach einem Retry sieht ein laufender `ysocial-verify-<postId>` den Post kurz auf `QUEUE` und meldet nichts, solange die Frist von 3 Minuten ab dem Retry läuft. Geht der Post raus, schließt `post.verified` den Alarm. Scheitert er wieder, kommt `post.failed` mit neuer Kennung. Bleibt er auf `QUEUE`, kommt `post.not_published` (ab 0.7.3, vorher nichts). Ist die Nachschau schon beendet (24 Stunden nach der Meldung), prüft kein Workflow mehr. Dann meldet nur noch `DailyHealth` am nächsten Morgen, und nur ein neues Scheitern.

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

Für die Meta-Screencasts (E25, W15, `docs/plattformen/meta.md` im Hub): Kommentare der letzten Instagram-Beiträge und, ab 0.9.0, der letzten Posts einer Facebook-Seite lesen, als Konto oder Seite antworten, verbergen, wieder zeigen, löschen. Die Demo-Seite im Hub (PR 27) ruft diese Routen. Gespeichert wird nichts, es gibt keine Tabelle. Tickets und Ereignisse `inbox.*` an den Hub kommen später im Hub.

| Variable | Wert |
|---|---|
| `YSOCIAL_DEMO_INTEGRATIONS` | IDs der Kanäle, durch Komma getrennt, nur Y-Social-Kanäle auf Staging. Fehlt sie oder ist sie leer, antworten alle Inbox-Routen mit 404 wie eine unbekannte Route, schon vor der Token-Prüfung. Auf Prod nie setzen |

| Route | Wirkung |
|---|---|
| `GET /ysocial/inbox/integrations/:id/comments` | Die letzten 10 Beiträge des Kontos oder der Seite, je bis zu 50 Kommentare (neueste zuerst) mit ihren Antworten |
| `POST /ysocial/inbox/integrations/:id/comments/:commentId/replies` | Antwort als Konto oder Seite, Body `{"message": "…"}`. 201 `{"integrationId":"…","commentId":"…","replyId":"…"}` |
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

Für Facebook hat die Antwort dieselbe Form mit `"provider": "facebook"`. Die Felder kommen so von Meta:

| Feld | Facebook |
|---|---|
| `posts[].id` | ID des Seiten-Posts (`<Seite>_<Post>`) |
| `posts[].permalink` | `permalink_url`, Link auf `facebook.com` |
| `posts[].timestamp` | `created_time` |
| `posts[].mediaType` | `status_type`, etwa `added_photos` oder `mobile_status_update` |
| `posts[].commentsCount` | `summary.total_count` der Kommentare, zählt nur Kommentare der obersten Ebene, Antworten nicht |
| `text` | `message` |
| `username` | `from.name`, der angezeigte Name der Person oder Seite. Die seitenbezogene ID aus `from.id` gibt die Route nicht weiter |
| `timestamp` | `created_time` |
| `likeCount` | `like_count` |
| `hidden` | `is_hidden` |
| `replies` | Kante `comments` des Kommentars, erste Seite |

**Regeln**
- Jede Route prüft selbst, ob der Kanal in `YSOCIAL_DEMO_INTEGRATIONS` steht (Regel 9). Der Guard entscheidet nur, ob es die Routen gibt.
- Geschrieben wird nur auf einen Aufruf über die Route (Regel 2). Kein Workflow, kein Schedule, keine automatische Antwort. Der Hub prüft die Rolle der Person und schickt sie im Kopf mit.
- Vor jeder schreibenden Aktion prüft die Route an der Plattform, ob der Kommentar unter einem Beitrag dieses Kontos steht. Sonst 404 `comment_not_found`, und nichts ändert sich.
  - Instagram: Feld `media` des Kommentars (bei einer Antwort ohne `media` über `parent_id` der Kommentar darüber), dann `owner` des Beitrags gleich `internalId` des Kanals.
  - Facebook: Die Comment-Referenz von Meta nennt kein Feld, das vom Kommentar zu seinem Post führt, nur `parent` bei einer Antwort. Die Route liest deshalb dieselbe Liste wie die Leseroute und schreibt nur, wenn der Kommentar oder die Antwort darin steht: unter einem der letzten 10 Posts der Seite, unter den ersten 50 Kommentaren, bei Antworten auf der ersten Seite. Ältere Kommentare kann die Demo nicht ändern, sie zeigt sie auch nicht.
- Löschen ohne `"confirmDelete": true` ergibt 409 `confirmation_required`, ohne Plattformaufruf.
- Token: der Page-Token aus `Integration.token`, wie `comment()` und `analytics()` des Postiz-Providers. Bei Instagram ist das der erste Teil von `<Page-Token>___<User-Token>`, bei Facebook der ganze Wert. Er steht nur in der Anfrage an Meta (Adresse bei `GET` und `DELETE`, Body bei `POST`), nie in Log oder Antwort. Der Antworttext geht im Body an Meta, nicht in der Adresse. Den Aufruf an Meta machen beide Provider über `libraries/ysocial/src/inbox/meta.graph.ts`.

| Antwort | `code` | Wann |
|---|---|---|
| 404 | – | `YSOCIAL_DEMO_INTEGRATIONS` fehlt oder ist leer |
| 401, 503 | – | Service-Token falsch oder nicht konfiguriert, wie `/ysocial/status` |
| 400 | `actor_missing` | Schreibende Route ohne gültigen `X-Ysocial-Actor` |
| 400 | – | Body ungültig: `message` fehlt, ist leer oder länger als 2200 Zeichen, `hide` oder `confirmDelete` ist kein Boolean |
| 400 | `invalid_comment_id` | `commentId` besteht nicht nur aus Ziffern und `_` |
| 403 | `not_demo_integration` | Kanal steht nicht in der Liste |
| 404 | `not_found` | Kanal unbekannt |
| 404 | `comment_not_found` | Kommentar steht nicht unter einem Beitrag dieses Kontos, Meta kennt ihn nicht (Code 100, Subcode 33, etwa direkt nach dem Löschen) oder die ID hat ein `_` (Instagram-IDs bestehen nur aus Ziffern). Bei Facebook: Kommentar steht nicht in der Liste der Leseroute (oben), oder die ID hat nicht die Form `<Ziffern>_<Ziffern>` |
| 409 | `confirmation_required` | Löschen ohne Bestätigung |
| 409 | `channel_inactive` | Kanal gelöscht, `disabled`, `refreshNeeded` oder `inBetweenSteps`, steht in `flag` |
| 409 | `provider_not_supported` | Kanal ohne Inbox, der Provider steht in `provider`. Eine Inbox gibt es zurzeit für `instagram` und `facebook` |
| 502 | `platform_error` | Meta lehnt ab (beim Schreiben nur Antworten unter 500): `platformStatus`, `platformCode`, `platformSubcode` und `reason`, die Meldung von Meta, bereinigt wie `reason` bei Ereignissen |
| 500 | `internal_error` | Unerwarteter Fehler, etwa Datenbank oder Entschlüsselung des Tokens. Im Log nur der Name der Fehlerklasse, bei Prisma dazu der Code (`P1001` und so weiter). Als `HttpException` geht er nicht an den Sentry-Filter von Postiz, der den Body der Anfrage (den Antworttext) mitschicken würde |
| 503 | `platform_unavailable` | Meta beim Lesen oder bei der Prüfung vor dem Schreiben nicht erreichbar oder keine Antwort nach 15 s. Nichts geändert |
| 503 | `outcome_unknown` | Keine klare Antwort von Meta auf das Schreiben selbst: Netzfehler, 15 s ohne Antwort oder ein Fehler 5xx von Meta (im Log dann mit Status und Codes). Meta hat es vielleicht trotzdem getan. Der Hub wiederholt den Aufruf nicht von selbst, sondern lädt die Kommentare neu und zeigt den Stand |

Dauer: Jede Anfrage an Meta bricht nach 15 s ab. Lesen braucht 1 Anfrage für die Beiträge und bis zu 10 parallel für die Kommentare, also höchstens etwa 30 s. Schreiben macht bei Instagram bis zu 4 Anfragen nacheinander (Kommentar, Kommentar darüber, Beitrag, Schreiben), also höchstens etwa 60 s. Bei Facebook liest es erst die Liste wie die Leseroute (bis zu 11 Anfragen, etwa 30 s) und schreibt dann, also höchstens etwa 45 s. Der Hub wartet mindestens 60 s. Bricht er vorher ab, läuft das Schreiben im Fork trotzdem weiter.

Im Log steht je Aufruf nur, was eine Prüfung bestanden hat, die Person und Zahlen: `inbox comments channel=<id> result=ok posts=<n> comments=<n>` und `inbox <reply|hide|unhide|delete> channel=<id> comment=<commentId> actor=<X-Ysocial-Actor> result=<done|rejected code=…>`. Bei `platform_error` stehen dort Status und Codes von Meta, nie ihre Meldung. Kommentartext, Namen der Kommentierenden und Antworttext stehen nie im Log. Eine Kanal-ID, die nicht in der Liste steht, und eine ungültige Kommentar-ID stehen dort als `-`.

**Endpunkte und Rechte** laut offizieller Meta-Referenz (Instagram API with Facebook Login, gelesen am 12.11.2026, Links im Kopf von `libraries/ysocial/src/inbox/instagram.inbox.ts`):

| Aufruf | Rechte |
|---|---|
| `GET /{ig-user-id}/media` | `instagram_basic`, `pages_read_engagement` oder `pages_show_list` |
| `GET /{ig-media-id}/comments` mit Feld `replies` | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` |
| `GET /{ig-comment-id}`, `GET /{ig-media-id}` (Prüfung vor dem Schreiben) | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` |
| `POST /{ig-comment-id}/replies` | `instagram_basic`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement` |
| `POST /{ig-comment-id}` mit `hide`, `DELETE /{ig-comment-id}` | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`. Nur der Besitzer des Beitrags |

Der Postiz-Provider `instagram` fragt alle diese Rechte schon an (`instagram.provider.ts`, `scopes`). Für diese Aufrufe braucht es keinen Patch. Patch 5 hängt nur die Liste aus `libraries/ysocial/src/scopes/meta.scopes.ts` an, die diese Aufrufe nicht brauchen.

**Grenzen laut Meta**
- Antworten nur auf Kommentare der obersten Ebene. Eine Antwort auf eine Antwort hängt Meta an den Kommentar darüber. Keine Antwort auf verborgene Kommentare und unter Live-Videos.
- Kommentare des Kontos selbst bleiben sichtbar, auch wenn sie verborgen sind.
- Höchstens 50 Kommentare je Beitrag und Abruf, die Demo blättert nicht weiter. Ob verborgene Kommentare in der Liste stehen, sagt die Doku nicht (**ungeprüft**, auf Staging prüfen).
- Ob eine Antwort das Feld `media` trägt, sagt die Doku nicht. Deshalb der Weg über `parent_id`.
- `owner` gibt Meta nur zurück, wenn „the app user making the query also created the media“. Ob das mit dem Page-Token gilt, ist **ungeprüft**. Gilt es nicht, enden alle schreibenden Aufrufe mit 404 `comment_not_found`, ohne etwas zu ändern (fail-closed). PLAN QA 2 auf Staging zeigt es.
- Je Kommentar liest die Demo nur die erste Seite der Antworten in der Standardgröße von Meta.
- Meta nennt für diese Aufrufe teils den User-Token (Referenz), teils den Page-Token (Leitfaden zur Moderation). Die Demo nimmt den Page-Token wie Postiz.
- Webhooks für Instagram-Kommentare gibt es erst mit Advanced Access (`meta.md` 2.6). Bis dahin liest die Demo auf Abruf. Anmelden und Empfang ab 0.9.1 im Abschnitt „Webhooks für die Inbox-Demo“ unten.

**Facebook** (ab 0.9.0): `libraries/ysocial/src/inbox/facebook.inbox.ts`. Eine Erweiterung der Demo nach E25, kein Produktcode für Phase 3. Anlass: Florian hat am 17.11.2026 entschieden, `pages_read_user_content` und `pages_manage_metadata` in den Meta-Antrag aufzunehmen (Weg 1, postiz#25). Meta verlangt für jedes Recht ein Video, das die Nutzung in der App zeigt. Dieser Teil liefert die Facebook-Kommentare für die Videos zu `pages_read_user_content` und `pages_manage_engagement` (Welle 2, Hub `meta.md` §6). Endpunkte und Rechte laut offizieller Meta-Referenz (gelesen am 17.11.2026, Links im Kopf der Datei):

| Aufruf | Rechte |
|---|---|
| `GET /{page-id}/published_posts`, Felder `id,permalink_url,created_time,status_type`, `limit=10` | Page-Token einer Person mit Aufgabe auf der Seite, `pages_read_engagement`, `pages_read_user_content` (Page Feed). Nur Posts der Seite selbst, keine Posts von Besuchern |
| `GET /{page-post-id}/comments` mit `filter=toplevel`, `order=reverse_chronological`, `summary=true`, `limit=50` und der Kante `comments` je Kommentar | „The same permissions required to view the parent object“. IDs der Kommentare nur mit der Aufgabe MODERATE. `pages_read_user_content`: „read user generated content on the Page, such as posts, comments, and ratings“ |
| `POST /{comment-id}/comments` mit `message` | Page-Token einer Person mit der Aufgabe MODERATE, `pages_manage_engagement` |
| `POST /{comment-id}` mit `is_hidden=true` oder `false` | `is_hidden`: „Only applicable to Page comments“. `pages_manage_engagement` („create, edit and delete comments posted on the Page“) |
| `DELETE /{comment-id}` | `pages_manage_engagement`, `pages_read_user_content` („delete user comments on Page posts“) |

`pages_show_list`, `pages_read_engagement` und `pages_manage_engagement` fragt der Postiz-Provider `facebook` selbst an, `pages_read_user_content` seit Patch 4 (PR 38, E58) über `libraries/ysocial/src/scopes/meta.scopes.ts`. Was dort steht, fragt Postiz beim Verbinden an und verlangt es (`checkScopes`). Seiten, die vorher verbunden wurden, tragen neue Rechte erst nach erneutem Verbinden. Für die Facebook-Inbox braucht es keinen weiteren Patch. Wann eine Zeile in `meta.scopes.ts` wegfällt, steht in ihrem Kopf.

**Grenzen und Ungeprüftes bei Facebook**
- `message`, `from` und `created_time` am Kommentar belegt der Leitfaden „Comments and @mentions“ der Pages API. `is_hidden` nennt die aktuelle Comment-Referenz nur als Parameter zum Ändern, nicht in der Feldliste. Lehnt Meta das Feld beim Lesen ab, endet die Leseroute mit 502 `platform_error` und Code 100, und ebenso jede schreibende Route, weil die Prüfung vor dem Schreiben dieselbe Liste liest. Dann ändert sich nichts, aber die ganze Facebook-Demo steht. **Ungeprüft**, auf Staging als erstes prüfen, vor jedem Schreiben (PR-QA).
- Ob verborgene Kommentare in der Liste stehen, sagt die Doku nicht. Fehlen sie, kann die Demo einen verborgenen Kommentar nicht wieder zeigen (404 `comment_not_found`, nichts geändert). **Ungeprüft**, auf Staging prüfen.
- Antwort auf eine Antwort: Die Route lässt auch die ID einer Antwort aus der Liste zu und schickt dann `POST /{antwort-id}/comments`. Was Meta damit macht (ablehnen oder an den Kommentar darüber hängen), sagt die Referenz nicht, sie nennt nur das Feld `can_comment`. **Ungeprüft**. Die Demo-Seite im Hub bietet Aktionen nur an Kommentaren der obersten Ebene (INBOX-KONZEPT §7, Punkt 4).
- Je Kommentar liest die Demo nur die erste Seite der Antworten in der Standardgröße von Meta. Antworten danach und Kommentare ab Platz 51 zeigt sie nicht und kann sie nicht ändern (404 `comment_not_found`).
- Scheitert der Abruf der Kommentare eines einzigen Posts, etwa weil er gerade gelöscht wurde, scheitert die ganze Liste. Bis zum nächsten erfolgreichen Abruf sind dann auch alle schreibenden Routen des Kanals gesperrt (fail-closed).
- Ob `from.name` bei Personen ohne Rolle in der App mit Standard Access kommt, ist **ungeprüft** (`meta.md` 4, „Business Asset User Profile Access“). Fehlt es, steht `username` auf `null`.
- `order=reverse_chronological` steht in der Referenz als Wert von `summary.order`. Ohne Wirkung kämen die ältesten 50 Kommentare. Für die Aufnahmen mit wenigen Kommentaren spielt das keine Rolle.
- Ohne Posttext wie bei Instagram. Den Bezug zum Post zeigt der Link `permalink`.

## Webhooks für die Inbox-Demo (Backend, ab 0.9.1, nur Staging)

Für die Videos zu `pages_manage_metadata` und den Webhook-Feldern `feed` (Seite) und `comments` (Instagram), Hub `meta.md` §6. Drei Teile: die Seite eines Demo-Kanals für Webhooks anmelden, Ereignisse von Meta empfangen, die letzten Ereignisse als Protokoll lesen. Ein Webhook löst nichts aus: keine Antwort, kein Ticket, kein Aufruf bei Meta (Regel 2). Den Text eines Kommentars liest die Demo über die Leseroute oben nach.

| Variable | Wert |
|---|---|
| `YSOCIAL_DEMO_INTEGRATIONS` | wie oben. Ohne sie gibt es auch den Empfänger nicht (404) |
| `YSOCIAL_META_WEBHOOK_VERIFY_TOKEN` | neu. Zufallswert, mindestens 32 Zeichen, zum Beispiel `openssl rand -hex 32`. Derselbe Wert steht im App-Dashboard als „Verify Token“. Fehlt er oder ist er kürzer: Der Empfänger beantwortet die Prüfung von Meta mit 503 |
| `FACEBOOK_APP_SECRET` | gibt es schon, Postiz braucht es für Facebook Login. Meta signiert die Webhooks der App damit. Fehlt es: Jedes Ereignis bekommt 503 |
| `FACEBOOK_APP_ID` | gibt es schon. Daran erkennt die Leseroute unsere App unter den Apps der Seite |

**Seite anmelden und Stand lesen** (hinter `YsocialInboxDemoGuard` und `YsocialTokenGuard`, Kanal aus `YSOCIAL_DEMO_INTEGRATIONS`, dieselben Prüfungen wie die Inbox-Routen):

| Route | Wirkung |
|---|---|
| `GET /ysocial/inbox/integrations/:id/webhooks` | Ist unsere App auf der Seite? 200 `{"integrationId":"…","provider":"facebook","subscribed":true,"fields":["feed"]}`. Nur der Eintrag unserer App (`FACEBOOK_APP_ID`), nie Namen oder IDs anderer Apps der Seite |
| `POST /ysocial/inbox/integrations/:id/webhooks` | Meldet die Seite mit dem Feld `feed` an. Ohne Body, mit `X-Ysocial-Actor` wie die anderen schreibenden Routen. 200 `{"integrationId":"…","provider":"…","subscribed":true,"fields":["feed"]}` |
| `GET /ysocial/inbox/webhooks/events` | Die letzten Ereignisse, neueste zuerst: `{"events":[…],"limit":50,"ttlSeconds":86400}`. Ist Redis nicht erreichbar: 503 `store_unavailable` |

- Facebook: `POST /{page-id}/subscribed_apps` mit `subscribed_fields=feed`, `GET` derselben Kante für den Stand. Rechte laut Referenz: Page-Token einer Person mit Aufgabe CREATE_CONTENT, MANAGE oder MODERATE, `pages_manage_metadata` und `pages_show_list`. Antwort `{"success": true}`. Die Einstellungen der Seite ändern sich dabei nicht.
- Instagram (Facebook Login): Kommentar-Webhooks kommen über die verknüpfte Seite. Die Route meldet die verknüpfte Seite mit `feed` an, mit dem Page-Token über `/me`. `comments` wählst du im App-Dashboard. Rechte laut Meta für `comments`: `instagram_basic`, `instagram_manage_comments`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`. Dazu kommen Advanced Access, App auf Live und ein öffentliches Instagram-Konto. Meta widerspricht sich bei diesem Schritt, deshalb ist `feed` hier eine **Annahme**:
  - Der Instagram-Leitfaden „Set up Instagram Webhooks“ (Abschnitt Facebook credentials) sagt: „Send a `POST` request to the linked Page's `/subscribed_apps` edge.“ und „You can use `/me` when the token represents the linked Facebook Page.“ Den Weg über `/me` belegt das. Derselbe Abschnitt verlangt aber: „Set `<WEBHOOK_FIELDS>` to the fields selected in the App Dashboard.“
  - Die Referenz von `subscribed_apps` sagt: „You cannot use the subscribed_fields parameter to configure or subscribe to Webhooks for Instagram. You must use your app dashboard to subscribe to Instagram Webhooks.“ Instagram-Felder wie `comments` stehen auch nicht in der Liste erlaubter Werte.
  - Die Route schickt deshalb das Seitenfeld `feed`, damit unsere App auf der verknüpften Seite ist. Ob Meta damit Instagram-Kommentare zustellt und ob ein `POST` die Feldliste ersetzt oder ergänzt, sagt keine der beiden Seiten. **Ungeprüft**. Vor Advanced Access lässt sich nur prüfen, ob `GET …/webhooks` danach `"subscribed":true` zeigt.
- Antworten und Fehler wie bei den Inbox-Routen: 400 `actor_missing`, 403 `not_demo_integration`, 404 `not_found`, 409 `channel_inactive` oder `provider_not_supported`, 502 `platform_error`, 503 `platform_unavailable`. Beim Anmelden 503 `outcome_unknown`, wenn Meta keine klare Antwort gibt. Ein zweiter Versuch schadet nicht, das Anmelden ist idempotent.
- Log: `inbox webhooks channel=<id> result=ok subscribed=<true|false> fields=<…>` und `inbox subscribe channel=<id> actor=<…> result=<done|rejected code=…>`.

**Empfänger** (für Meta, öffentlich): `GET` und `POST /ysocial-meta-webhook`, von außen `https://<Postiz-Host>/api/ysocial-meta-webhook`. Der Pfad liegt bewusst außerhalb von `/ysocial/`, denn der Reverse Proxy sperrt `/api/ysocial/*` nach außen. Er enthält kein `/auth`. Die Basic Auth von Staging braucht eine Ausnahme genau für diesen Pfad, verankert und mit Schreibweise wie hier, im Caddyfile des Hubs etwa `@needs_auth not path_regexp ^/(uploads|integrations/social)/|^/api/ysocial-meta-webhook$`. Express leitet auch `/api/YSOCIAL-META-WEBHOOK` und `/api/ysocial-meta-webhook/` auf den Empfänger. Mit dem verankerten Ausdruck bleiben diese Varianten hinter der Basic Auth. Die Sperre `(?i)^/api/ysocial(/|$)` trifft den Pfad nicht, denn auf `ysocial` folgt `-`. Auf Prod gibt es den Empfänger nicht (404 ohne Demo-Liste).

Die Guards laufen in dieser Reihenfolge: `YsocialInboxDemoGuard` (ohne Demo-Liste 404), dann `YsocialMetaWebhookGuard` statt `YsocialTokenGuard`. Das ist eine Ausnahme von der Fork-Regel, weil Meta den Service-Token nicht schicken kann. `ysocial.token.guard.spec.ts` lässt sie nur für genau diesen Controller zu und verlangt dort genau zwei Handler (`GET` und `POST` auf dem Pfad selbst). Andere Methoden als `GET`, `HEAD` und `POST` weist der Guard ab.

| Anfrage | Prüfung | Antwort |
|---|---|---|
| `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` (Prüfung beim Speichern im App-Dashboard) | `hub.verify_token` gleich `YSOCIAL_META_WEBHOOK_VERIFY_TOKEN`, Vergleich in konstanter Zeit. `hub.challenge` nur Ziffern (laut Referenz „an int“) | 200 mit `hub.challenge` als Text. Token fehlt in der Umgebung: 503. Falsch, fehlt oder anderer `hub.mode`: 403 |
| `POST` mit JSON (Ereignis) | `X-Hub-Signature-256: sha256=<hex>` gleich HMAC-SHA256 des Rohkörpers mit `FACEBOOK_APP_SECRET`, Vergleich in konstanter Zeit. Den Rohkörper liefert Nest, weil Postiz in `apps/backend/src/main.ts` `rawBody: true` setzt (so auch Stripe) | 200 `{"received":<n>}`, auch wenn nichts gespeichert werden konnte, denn Meta würde nur dasselbe noch einmal schicken. Secret fehlt: 503. Kopf fehlt oder Signatur falsch: 401 |

Quelle: Meta, „Get started with webhooks“ (Verification Requests, Validating Payloads, Antwort 200, Wiederholung bis 36 Stunden, Ereignisse können doppelt kommen), gelesen am 17.11.2026. Links im Kopf von `libraries/ysocial/src/webhooks/webhook.rules.ts`.

**Protokoll:** Je Änderung (`entry[].changes[]`) ein Eintrag in Redis unter `ysocial:demo:meta-webhook-events`. Die Liste hält die letzten 50 Einträge und verfällt 24 Stunden nach dem letzten. Es gibt keine Tabelle.

    {"receivedAt":"…","object":"page","entryId":"<Seite>","sentAt":"…","field":"feed","item":"comment","verb":"add","postId":"<Seite>_<Post>","commentId":"<Post>_<Kommentar>","parentId":"<Seite>_<Post>","mediaId":null,"createdAt":"…"}

- `object` ist `page` oder `instagram`, `entryId` die Seiten-ID oder die ID des Instagram-Kontos. Benachrichtigungen anderer Objekte der App (etwa `user` oder `permissions`, dort wäre `entry.id` die ID einer Person) speichert der Empfänger nicht, er antwortet 200 und loggt `ignored`.
- `item` und `verb` gibt es nur beim Seiten-Feld `feed`, etwa `comment`/`add`, `comment`/`hide` oder `reaction`/`add`.
- Bei Instagram `comments` stehen `commentId` (`comment_id`, sonst `id`), `parentId` und `mediaId`.
- Zeiten von Meta (Unix-Sekunden) stehen als ISO-Datum darin. Felder mit unerwartetem Wert stehen auf `null`.
- Nie gespeichert und nie im Log: `message`, `text`, `from` (Name, Nutzername, ID der Person) und alle übrigen Felder von `value`.
- Log: `meta webhook object=<page|instagram|-> events=<n> fields=<…> result=<recorded|ignored|store_failed error=…>`. Abgewiesene Anfragen: `meta webhook <verify|receive> result=rejected code=<not_configured|verify_invalid|signature_missing|signature_invalid>`. Weder Token noch Signatur stehen darin.

**Grenzen und Ungeprüftes**
- Webhooks einer App kommen an genau einen Endpunkt (`meta.md` 2.6). Gilt für die App von Staging.
- Feed-Ereignisse von Personen ohne Rolle in der App kommen vor Advanced Access vermutlich nicht an (`meta.md` §1, Punkt 4). Instagram-Kommentare gibt es nur mit Advanced Access und Live-App. **Ungeprüft**.
- Ob die Testnachricht des App-Dashboards (Knopf „Test“) signiert ist wie ein echtes Ereignis, ist **ungeprüft**. Ihre IDs sind Beispielwerte.
- Express liest JSON bis 100 KB (Vorgabe von Nest). Meta bündelt bis zu 1000 Änderungen in einer Anfrage. Ein größerer Body endet mit 413 vor der Signaturprüfung, Meta wiederholt dann. Für die Demo reicht das.
- Je Ereignis ein `RPUSH`, dann `LTRIM` und `EXPIRE`, nicht in einer Transaktion. Bricht Redis dazwischen ab, bleibt die Liste bis zum nächsten Ereignis ohne Ablaufzeit. Lokal ohne `REDIS_URL` nutzt Postiz einen Ersatz ohne `LTRIM`, dort loggt jeder Empfang `store_failed`.
- Ein Ereignis, das Meta doppelt schickt, steht doppelt im Protokoll.

## LinkedIn-Seiten ohne OpenID Connect (PR 39, Patch 7)

Y Social verbindet LinkedIn-Seiten mit einer eigenen App, die nur das Produkt Community Management API hat („Weg A“, Hub `docs/plattformen/linkedin.md` 1.5, E58). LinkedIn gibt dort `openid` und `profile` nicht. Postiz fragt beide an, verlangt jeden angefragten Scope nach dem Login (`checkScopes`, sonst 409 `NotEnoughScopes`) und liest das Mitglied aus `/v2/userinfo`, das beide braucht. Ohne Patch verbindet Postiz mit dieser App keine Seite.

Patch 7 in `linkedin.page.provider.ts` (Provider `linkedin-page`), Logik in `libraries/ysocial/src/scopes/linkedin.scopes.ts`:

| Was | Wie |
|---|---|
| Scopes | Die Liste von Postiz ohne `openid` und `profile` (`YSOCIAL_LINKEDIN_PAGE_DROP`), dazu `r_organization_social_feed` und `w_organization_social_feed` für Kommentare unter den Posts der Seite (`YSOCIAL_LINKEDIN_PAGE_ADD`). Angefragt werden damit `w_member_social`, `r_basicprofile`, `rw_organization_admin`, `w_organization_social`, `r_organization_social`, `r_organization_social_feed`, `w_organization_social_feed` |
| Mitglied | `authenticate` und `refreshToken` lesen ID, Name und Bild aus `/v2/me` (`r_basicprofile`) statt aus `/v2/userinfo`, in derselben Form (`sub`, `name`, `picture`). Die ID von `/v2/me` ist die Personen-ID, eindeutig nur für die App (Profile API). Dass sie gleich `sub` von OpenID Connect ist, ist wahrscheinlich, aber nicht dokumentiert. Für die neue App von Y Social spielt das keine Rolle. Postiz nutzt sie für den Platzhalter `linkedin-page_<id>` und als `rootInternalId` jeder Seite, die daraus gewählt wird: Die Tokens eines Logins gehen an alle Zeilen mit diesem Wert |
| Fehler | `authenticate` bricht ab, wenn `/v2/me` nicht mit 2xx und einer ID antwortet (fail-closed). Sonst entstünde wie bei Postiz eine Zeile `linkedin-page_undefined`, und die Tokens verschiedener Logins gingen an dieselben Seiten. Die Meldung nennt nur den Status. `refreshToken` bricht nicht ab: Postiz nutzt dort nur die Tokens, Name und Bild des Kanals bleiben |
| unverändert | Wahl der Seite (`companies`, `fetchPageInformation`), Posten, Kommentare, Statistik, der Provider `linkedin` für persönliche Profile (ausgeblendet über `HIDDEN_PROVIDERS`) |

Grenzen:
- **Scopes laut Doku im Produkt, im Konto ungeprüft bis B6** (Florians LinkedIn-App): Microsoft Learn „Increasing Access“ nennt für Community Management API alle sieben, `openid`, `profile` und `email` nicht. Ob es Refresh-Tokens gibt, ist ungeprüft. Fehlt ein Scope, scheitert jedes Verbinden mit `NotEnoughScopes` (409). Die Ursache steht dann nur in `error_description` der Rückleitung von LinkedIn (vermutlich `unauthorized_scope_error`, ungeprüft). Dann die Zeile in `linkedin.scopes.ts` ändern, nicht die Postiz-Datei. Der Test belegt das Verhalten nur mit einem gemockten LinkedIn.
- **Eine Änderung der Scopes entwertet Tokens:** LinkedIn macht alle früheren Zugangstokens eines Mitglieds ungültig, wenn es mit anderen Scopes neu verbindet (Authorization Code Flow). Neue Tokens gibt Postiz nur an Zeilen mit demselben `rootInternalId` weiter. Seiten aus einer anderen App (andere Client-ID) laufen bis zum Ablauf, der Refresh scheitert dann, und die Seite muss neu verbunden werden. Die Liste deshalb vor der ersten Kundenseite festlegen (Frage `w_member_social`, Hub-ROADMAP).
- QA mit B6, vor dem ersten Verbinden: Es gibt keinen Kanal `linkedin-page` in Postiz. Beim Verbinden steht im Schritt „Seite wählen“ der volle Name des Mitglieds, nicht nur der `vanityName`. Sonst ist die Projektion von `/v2/me` gescheitert.
- `/v2/me` wird bei jedem Verbinden und Refresh zweimal gerufen, einmal für Name und Bild, einmal für `vanityName` wie bisher bei Postiz. Bei 100 Aufrufen je Mitglied und Tag im Development Tier fällt das nicht ins Gewicht.

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
- Zeitraffer für PostVerification: `ysocial.verify.post.workflow.spec.ts`, `ysocial.verify.post.workflow.v1.0.1.spec.ts` und `ysocial.verify.post.workflow.v1.0.2.spec.ts`, je Version eine Datei. `sleep` stellt dort die Uhr vor, statt zu warten.
- Der Bundler von Temporal liest beim Test die TypeScript-Quellen. Die `.swcrc` von Postiz in `apps/orchestrator/` hat einen `baseUrl` von einem fremden Rechner, der Test schaltet sie für den Bundler ab. Im Betrieb bündelt der Worker das kompilierte JavaScript aus `dist`, dort spielt die Datei keine Rolle.
