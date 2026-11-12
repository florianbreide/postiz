# YSOCIAL-PATCHES

Diese Datei listet jede Abweichung unseres Forks von Postiz. Sie ist die Grundlage für jeden Upstream-Sync.

- Fork: `florianbreide/postiz`, Original: `gitroomhq/postiz-app` (Remote `upstream`)
- Basis: upstream v2.25.3 (24.10.2026)
- Verbindliche Vorgabe: `docs/HANDOVER.md` im Repo `florianbreide/social-hub`

## Regeln

1. Eigener Code liegt nur in `apps/backend/src/ysocial/`, `apps/orchestrator/src/ysocial/` und `libraries/ysocial/`.
2. Jede Änderung an einer Postiz-Datei ist ein Patch und steht in Tabelle 1. Höchstens 5 Patches.
3. Neue Dateien außerhalb der ysocial-Ordner zählen nicht als Patch (E6). Sie stehen in Tabelle 2.
4. Keine neuen Tabellen im Postiz-Schema. Jeder Start führt `prisma db push` aus.
5. `libraries/ysocial/` wird mit relativen Pfaden importiert. Ein neuer Alias in `tsconfig.base.json` wäre ein weiterer Patch.

## Stand

**Patches: 3 von höchstens 5**

Letzter Sync: Sicherheits-Sync von v2.25.1 auf v2.25.3 am 11.11.2026 (Branch `upstream-sync/2026-11-security`). Beide Patches stehen unverändert an ihrer Stelle, der Merge lief ohne Konflikt.

## Tabelle 1: Geänderte Postiz-Dateien (Patches)

| Datei | Stelle | Grund | seit |
|---|---|---|---|
| `apps/backend/src/app.module.ts` | Import von `YsocialModule` (2 Zeilen, Kommentar „ysocial patch 1“) und Eintrag `YsocialModule` am Ende von `imports` | Hängt das ysocial-Modul in das Backend ein. Ohne diese Stelle lädt Nest keinen eigenen Controller | 17.10.2026, PR 2 (`phase-0/basis`) |
| `apps/orchestrator/src/app.module.ts` | Import von `YsocialOrchestratorModule` (2 Zeilen, Kommentar „ysocial patch 2“) und Eintrag `YsocialOrchestratorModule` am Ende von `imports` | Hängt den eigenen Temporal-Worker in den Orchestrator ein (E33). Postiz-Workflows laufen nur auf der Queue `main` aus `workflows/index.ts`, eigene Workflows brauchen einen eigenen Worker. `workflows/index.ts` bleibt unverändert (E6) | 18.10.2026, PR 16 (`phase-1/worker`) |
| `libraries/nestjs-libraries/src/database/prisma/prisma.service.ts` | Import von `withYsocialTokenEncryption` (2 Zeilen, Kommentar „ysocial patch 3“) und am Ende des Konstruktors `return withYsocialTokenEncryption(this);` mit Kommentar (3 Zeilen) | Kanal-Tokens verschlüsselt in der Datenbank (HANDOVER §9, W4, E24). Der Konstruktor gibt den erweiterten Prisma-Client zurück, damit greift die Erweiterung in jedem Repository. Logik in `libraries/ysocial/src/tokens/` | 12.11.2026, PR 25 (`phase-1/token-verschluesselung`) |

## Tabelle 2: Neue Dateien außerhalb der ysocial-Ordner

| Datei | Zweck | seit |
|---|---|---|
| `YSOCIAL-PATCHES.md` | Diese Liste | 17.10.2026, PR 2 |
| `docs/STAGING-TESTPLAN.md` | Prüfliste für jeden Upstream-Sync auf Staging | 17.10.2026, PR 2 |
| `docs/YSOCIAL-LOKAL.md` | Lokaler Start mit Node 22 und pnpm 10.6.1 | 17.10.2026, PR 2 |
| `.claude/CLAUDE.md` | Regeln für Claude Code im Fork. Die Postiz-`CLAUDE.md` im Root bleibt unverändert (E16) | 17.10.2026, PR 2 |
| `ROADMAP.md` | Nur Patch-Stand und Verweise. Der Status steht in der Hub-ROADMAP (E18) | 17.10.2026, PR 2 |
| `.node-version` | Node für `fnm` (E8). Seit v2.25.3 verlangt `package.json` genau `22.23.4` (`engines`), die Datei nennt deshalb dieselbe Version | 17.10.2026, PR 2; `22.23.4` seit 11.11.2026, Sync auf v2.25.3 |
| `.github/workflows/ysocial-upstream-check.yml` | Wöchentliche Prüfung auf ein neues Postiz-Release, öffnet ein Issue (E11). Die Logik liegt in `libraries/ysocial/upstream-check/` | 17.10.2026, PR 6 |
| `.github/workflows/ysocial-image.yml` | Fork-Image aus `Dockerfile.dev` bei jedem Push auf `main` und von Hand, amd64 und arm64, nach `ghcr.io/florianbreide/postiz` (E14, E34). Tag `<Basis>-ys-<Commit, 12 Zeichen>`, auf `main` zusätzlich `main`. Der Tag ist unveränderlich: Gibt es ihn in GHCR schon, baut der Lauf nicht neu und nennt den vorhandenen Digest. Ist der Commit die Spitze von `main`, zeigt `main` danach auf diesen Digest. Ein Neubau unter demselben Tag geht nur von Hand mit `force`. Die Basis liest er wie die Upstream-Prüfung aus der Zeile „Basis:“ oben. Digest und Wert für `POSTIZ_IMAGE` stehen in der Zusammenfassung des Laufs. `build-containers.yml` von Postiz bleibt abgeschaltet und unverändert | 18.10.2026, PR 15; Tag unveränderlich seit 18.10.2026, Folge-PR `phase-1/image-tag` |
| `.github/workflows/ysocial-tests.yml` | Tests bei jedem PR auf `main` und von Hand: ysocial-Jest, Tests der Upstream-Prüfung, Bau von Backend und Orchestrator, Secret-Scan mit gitleaks über die eigenen Commits des PRs, ohne die Commits des Upstream-Tags aus der Basis-Zeile (sonst meldet ein Sync-PR bekannte Fehlalarme aus Upstream). Ohne `.env`. Eine Wegwerf-Datenbank (Postgres-Service ohne Passwort, Image per Digest) nur für den Integrationstest der Token-Verschlüsselung | 12.11.2026, `phase-1/ci-tests`; Postgres-Service seit 12.11.2026, PR 25 |

## Inhalt der ysocial-Ordner

| Ordner | Inhalt |
|---|---|
| `apps/backend/src/ysocial/` | `YsocialModule`, `GET /ysocial/status` mit dem Zustand des Workers, die Lese-API `GET /ysocial/customers`, `/integrations`, `/posts`, „Erneut versuchen“ `POST /ysocial/posts/:id/retry`, der Testschalter `POST`/`DELETE /ysocial/test/integrations/:id/invalid-token` (nur bei `YSOCIAL_TEST_ROUTES=true`, zusätzlich hinter `YsocialTestRoutesGuard`) und die Inbox-Demo `GET`/`POST`/`DELETE /ysocial/inbox/integrations/:id/comments…` (nur bei gesetztem `YSOCIAL_DEMO_INTEGRATIONS`, zusätzlich hinter `YsocialInboxDemoGuard`), alle hinter `YsocialTokenGuard`, Tests |
| `apps/orchestrator/src/ysocial/` | `YsocialOrchestratorModule`: eigener Temporal-Worker (Namespace `ysocial`, Queue `ysocial-postiz`), Schedules, Aktivitäten und Workflows mit Präfix `ysocial`, Ereignisse an den Hub, `PostVerification`, Kanal-Prüfung, `DailyHealth`, Migration der Kanal-Tokens, Startprüfung des Token-Schlüssels, Tests. Beschreibung in `README.md` dort |
| `libraries/ysocial/` | Gemeinsamer Code: Prüfung des Service-Tokens, Konfiguration und Zustand des Workers, Ereignisse an den Hub, Regeln und Provider-Tabelle der Post-Prüfung, Kanal-Prüfung mit Testschalter, Lese-API, Regeln und Dienst für „Erneut versuchen“, Verschlüsselung der Kanal-Tokens (`src/tokens/`), Inbox-Demo mit dem Instagram-Provider der Inbox (`src/inbox/`, liest Kommentare, antwortet, verbirgt und löscht nur auf Aufruf, speichert nichts), Datenbankzugriffe mit fester Feldliste (lesend, dazu der Wechsel `ERROR` → `QUEUE` für „Erneut versuchen“), Modulversion, Jest-Konfiguration mit Stub für `@prisma/client` |
| `libraries/ysocial/upstream-check/` | Logik des Workflows `ysocial-upstream-check` (Basis lesen, Versionen vergleichen, Duplikate erkennen, Issue-Text), Tests und erfundene Testdaten |

Die Statusroute antwortet ohne konfiguriertes `YSOCIAL_SERVICE_TOKEN` mit 503, ohne oder mit falschem Bearer-Token mit 401, mit dem richtigen mit 200. Die globalen Postiz-Guards lassen neue Controller durch. Der eigene Guard ist deshalb Pflicht für jeden ysocial-Controller. Ein Test prüft das für jeden Controller in `apps/backend/src/ysocial/`.

Tests: `pnpm exec jest -c libraries/ysocial/jest.config.js` (Node 22). In GitHub laufen sie bei jedem PR im Workflow `ysocial tests`. Der Integrationstest der Token-Verschlüsselung (`ysocial.token.integration.spec.ts`) nimmt den echten Prisma-Client und eine Wegwerf-Datenbank. Er läuft nur mit `YSOCIAL_IT_DATABASE_URL` (nur `localhost` oder `127.0.0.1`, Schema `ysocial_it`), in GitHub gegen den Postgres-Service des Workflows. Das Root-`jest.config.ts` von Postiz braucht `@nx/jest`, das nicht installiert ist. Der Test gegen einen echten Temporal-Server läuft nur mit `YSOCIAL_IT_TEMPORAL_ADDRESS`, siehe `apps/orchestrator/src/ysocial/README.md`. `@temporalio/testing` ist keine Postiz-Abhängigkeit, eine neue Abhängigkeit wäre ein Patch an `package.json`. Workflow-Tests laufen deshalb mit gemockten Temporal-Funktionen und simulierter Uhr. Die Upstream-Prüfung hat eigene Tests ohne Abhängigkeiten, Jest lässt sie aus: `node --test libraries/ysocial/upstream-check/ysocial-upstream-check.test.mjs` (Node 22, ohne Netz).

## Umgebungsvariablen des Forks

| Variable | Pflicht | Wert | fehlt oder zu kurz |
|---|---|---|---|
| `YSOCIAL_SERVICE_TOKEN` | ja | Zufallswert, mindestens 32 Zeichen, zum Beispiel `openssl rand -hex 32` | `/ysocial/status` antwortet mit 503 (fail-closed) |
| `HUB_INTERNAL_URL` | für den Worker | Adresse des Hubs im Docker-Netz, zum Beispiel `http://hub-web:3000`. Keine Zugangsdaten in der Adresse | ysocial-Worker startet nicht, Postiz läuft weiter, `/ysocial/status` meldet „Worker aus“ |
| `HUB_INTERNAL_TOKEN` | für den Worker | Gleicher Wert wie im Hub, mindestens 32 Zeichen | wie oben |
| `YSOCIAL_TEMPORAL_NAMESPACE` | für den Worker | `ysocial`. Nie `default` oder der Wert von `TEMPORAL_NAMESPACE` | wie oben |
| `YSOCIAL_WORKER_ENABLED` | nein | `false` schaltet den Worker ab. Ohne Wert läuft er, sobald die drei Variablen oben stimmen | – |
| `YSOCIAL_TEST_ROUTES` | nein, nur Staging | `true` schaltet die Testrouten ein (Testschalter für die Kanal-Prüfung, PR 19). Auf Prod nie setzen | Testrouten antworten mit 404, der Testschalter wirkt nicht (fail-closed) |
| `YSOCIAL_TEST_INTEGRATIONS` | nein, nur Staging | IDs der Kanäle von Y Social, durch Komma getrennt, für die der Testschalter gilt | Testschalter für jeden Kanal 403, keine Wirkung auf die Kanal-Prüfung |
| `YSOCIAL_DEMO_INTEGRATIONS` | nein, nur Staging | IDs der Kanäle von Y Social, durch Komma getrennt, für die Inbox-Demo (PR 26). Zurzeit nur Instagram. Auf Prod nie setzen | Inbox-Routen antworten mit 404 (fail-closed). Für einen Kanal, der nicht in der Liste steht: 403 |
| `YSOCIAL_TOKEN_KEY` | ja, ab B28 | Schlüssel für die Kanal-Tokens, je Umgebung ein eigener: `openssl rand -base64 32` (genau 32 Byte als Base64). Backend und Orchestrator bekommen denselben Wert. Verloren heißt: alle Kanäle neu verbinden (R25) | Ohne Schlüssel bleiben die Tokens Klartext, solange keine verschlüsselt sind. Gibt es verschlüsselte Tokens, starten Backend und Orchestrator nicht. Ein ungültiger Wert oder ein anderer Schlüssel als beim Verschlüsseln stoppt den Start mit Meldung (fail-closed) |

Die `.env.example` von Postiz bleibt unverändert, eine Änderung wäre ein Patch. Die Vorlage für diese Variablen steht deshalb im Hub: in der `.env.example` (PR 3) und in `infra/` (PR 7). Dort erzeugt `scripts/gen-secrets.sh` den Wert. Hub und Postiz-Container bekommen denselben Wert. Lokal beschreibt `docs/YSOCIAL-LOKAL.md` den Eintrag. Jede neue Variable des Forks kommt in diese Tabelle und in die Hub-Vorlage.

## Upstream-Sync

**Takt**
- Monatlich ein PR `upstream-sync/<yyyy-mm>` auf das neueste Release-Tag. Nie auf upstream-`main`.
- Sicherheitsreleases sofort, als `upstream-sync/<yyyy-mm>-security` (E11).
- Nie an einem Tag mit vielen geplanten Posts.

**Auslöser**
- Der Workflow `ysocial-upstream-check` läuft jeden Montag um 06:17 UTC. Zur vollen Stunde verzögert GitHub geplante Läufe oder lässt sie ausfallen. Er liest das neueste Release von `gitroomhq/postiz-app` und vergleicht es mit der Basis oben.
- Ist upstream neuer, öffnet er ein Issue „Postiz <tag> verfügbar“ mit Link, Datum und Checkliste. Gibt es schon ein offenes oder geschlossenes Issue des Workflows (`github-actions[bot]`) mit diesem Titel, legt er kein zweites an. Issues anderer Personen zählen nicht: Der Fork ist öffentlich, jeder kann ein Issue mit diesem Titel anlegen.
- Das Label `sicherheit` setzt er nur bei einem eindeutigen Hinweis in Name oder Release-Notes eines Releases seit der Basis: „upgrade immediately“ oder eine Advisory-Nummer (`CVE-…`, `GHSA-…`, `PSA-…`). Dann gilt der Sicherheits-Sync.
- Nennen die Notes nur „security“, „Sicherheit“ oder „vulnerab…“, steht im Issue „Bitte prüfen“, ohne Label. Diese Wörter treffen auch Releases, die das Thema nur streifen. Beispiel: v2.20.0 erwähnt Sicherheit nur bei einer korrigierten Kontaktadresse für Sicherheitsmeldungen. Ist es doch ein Sicherheitsfix, setzt du das Label selbst und synchronisierst sofort.
- Häufigkeit: Seit März 2026 trägt fast jedes Release den Hinweis „upgrade immediately“, am 17.10.2026 waren es 5 der letzten 9 und 11 von 15 seit dem 20.03.2026. E11 ging von 2 der letzten 9 aus. Fast jedes Issue trägt damit das Label `sicherheit`.
- **Regel ab 11.11.2026 (Florian):** Sofort-Sync nur, wenn ein Release seit der Basis eine Advisory-Nummer nennt (`PSA-…`, `CVE-…`, `GHSA-…`). Sonst gilt der Monats-Sync. Der Workflow setzt das Label weiterhin auch bei „upgrade immediately“ ohne Nummer. Dann prüfst du die Release-Notes: Steht keine Nummer darin, entfernst du das Label und synchronisierst zum Monatstermin. Der Testplan bleibt bei beiden Arten vollständig.
- Der Workflow meldet ein Release spätestens am folgenden Montag, also bis zu 7 Tage später. Wer sofort Bescheid will, stellt bei `gitroomhq/postiz-app` „Watch“, „Custom“, „Releases“ ein. Das Issue bleibt die verbindliche Erinnerung mit Checkliste.
- Der Workflow liest nur die Zeile `Basis: upstream vX.Y.Z (Datum)` oben. Fehlt sie, steht keine Version darin oder ist sie nicht eindeutig, schlägt der Lauf fehl. Das Format bleibt deshalb so. Dieselbe Basis steht in der Fork-`ROADMAP.md`, ein Test prüft das.
- Manuell, erst wenn der Workflow auf `main` liegt: `gh workflow run ysocial-upstream-check.yml`, als Probelauf ohne Issue mit `-f dry_run=true`. Der Probelauf schreibt den Issue-Text ins Log.
- Logik, Tests und Testdaten: `libraries/ysocial/upstream-check/`. Tests: `node --test libraries/ysocial/upstream-check/ysocial-upstream-check.test.mjs` (Node 22, ohne Netz).

**Probe mit echtem Issue** (QA von PR 6 nach dem Merge, danach bei jeder Änderung am Workflow)

Ist die Basis gleich dem neuesten Release, meldet der Workflow nur „Kein neueres Release“. Für die Probe braucht es deshalb einen Branch mit älterer Basis.
1. Wegwerf-Branch `qa/upstream-check` von `main` anlegen, in der Basis-Zeile oben eine ältere Version eintragen (zum Beispiel `v2.24.0`), pushen.
2. `gh workflow run ysocial-upstream-check.yml --ref qa/upstream-check`. Erwartet: ein Issue „Postiz <neuestes Tag> verfügbar“. Liegt ein Sicherheitsrelease zwischen Basis und neuestem Tag, trägt es das Label `sicherheit`. Gibt es das Issue schon, meldet bereits dieser Lauf „gibt es schon“.
3. Denselben Befehl noch einmal. Erwartet: im Log „gibt es schon“, kein zweites Issue.
4. `gh workflow list --all`: Nur `ysocial upstream check` ist `active`.
5. Das Issue in „QA-Probe: Postiz <tag> verfügbar“ umbenennen, mit dem Kommentar „QA-Probe“ schließen und den Branch löschen. Erst die Umbenennung gibt den Titel frei. Ein geschlossenes Issue des Workflows mit dem alten Titel zählt als Duplikat und würde die echte Meldung für `main` unterdrücken.
6. Ist das neueste Tag neuer als die Basis auf `main`, danach `gh workflow run ysocial-upstream-check.yml` ohne `--ref` starten. Erwartet: ein neues Issue mit der Basis von `main`.

**Ablauf**
1. `git fetch upstream --tags`, das neue Tag in einen Branch `upstream-sync/<yyyy-mm>` mergen.
2. Vor dem Merge lesen: Änderungen in `.github/workflows/`, `.claude/` und `CLAUDE.md`. Neue Upstream-Workflows sofort per `gh workflow disable` abschalten, ihre Dateien bleiben unverändert.
3. Jeden Patch aus Tabelle 1 prüfen: Ist die Stelle noch da, passt der Grund noch?
   Für Patch 3: Der Wächter-Test `libraries/ysocial/src/tokens/ysocial.token.bypass.spec.ts` ist grün (keine Raw-Queries, keine Fluent-Aufrufe auf Integration, der Patch steht in `prisma.service.ts`). Hebt das Release die Version von Prisma, muss auch der Integrationstest `ysocial.token.integration.spec.ts` in der CI grün sein. Er belegt, dass die Erweiterung bei `include` und verschachtelten Writes weiter greift. Neue Lese- oder Schreibstellen von `token` und `refreshToken` im Diff prüfen.
   Dazu „Erneut versuchen“: `git diff <alte Basis> <neues Tag> -- apps/orchestrator/src/workflows/post-workflows/ libraries/nestjs-libraries/src/database/prisma/posts/ apps/orchestrator/src/activities/post.activity.ts libraries/nestjs-libraries/src/integrations/social.abstract.ts`. Gleiche die Tabelle „Unklarer Ausgang“ in `apps/orchestrator/src/ysocial/README.md` mit `libraries/ysocial/src/retry/retry.rules.ts` und den Tests dort ab, wenn sich eins davon ändert: ein neuer Post-Workflow, `markUnconfirmed`, `handleActivityError`, die Fehlertexte vor dem ersten Plattformaufruf, `changeState`, `updatePost`, `updateResolvedRelease`, `changeDate` (setzt `releaseId` und `releaseURL` zurück), `handleDisconnect` und `PublishedWithError`, die Abbildung auf `RefreshToken` in `SocialAbstract`, die Bedingungen von `searchForMissingThreeHoursPosts` (darauf beruht `channel_inactive`) oder die Abfrage laufender Workflows in `startWorkflow`. Die Route ruft `startWorkflow` und nutzt damit automatisch den Workflow, den Postiz dort startet.
4. Neue Dateien aus Tabelle 2 auf Konflikte mit neuen Upstream-Dateien prüfen.
5. `pnpm install`, Tests aus den ysocial-Ordnern, lokaler Start nach `docs/YSOCIAL-LOKAL.md`.
6. Staging nach `docs/STAGING-TESTPLAN.md` prüfen und das Protokoll in den PR schreiben.
7. Erst danach Produktion. Florian mergt.
8. Basis oben in dieser Datei und in der Fork-`ROADMAP.md` sowie die Spalte „seit“ aktualisieren. Das Issue „Postiz <tag> verfügbar“ mit Verweis auf den PR schließen.

PRs gehen nie an `gitroomhq/postiz-app`. Deshalb hat der Remote `upstream` keine Push-Adresse:

    git remote set-url --push upstream no_push

`git remote -v` zeigt `upstream … no_push (push)`. Vor jedem `gh pr create` zeigt `gh repo set-default --view` das Repo `florianbreide/postiz`.
