# Postiz lokal starten

Stand 17.10.2026, geprüft auf Florians Mac: arm64, Docker über Colima (4 CPU, 8 GB), Docker-CLI 29.8.2 aus Homebrew, fnm mit Node 22.23.3.

Lokal verbindest du keinen echten Kanal. Es gibt keine Provider-Zugangsdaten in der lokalen `.env`.

## Voraussetzungen

- **Node 22** (mindestens 22.12, unter 23) per `fnm`. Die Datei `.node-version` im Repo enthält `22`. Node 26 ist auf dem Mac Standard, damit läuft Postiz nicht.
- **pnpm 10.6.1** per corepack. Die Version kommt aus `packageManager` in `package.json`. `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` verhindert die Rückfrage beim ersten Mal.
- **Docker mit Compose.** Auf deinem Mac fehlt das Compose-Plugin, `docker compose` meldet „unknown command“. Einmalig nachinstallieren:
  1. `brew install docker-compose`
  2. In `~/.docker/config.json` den Eintrag `"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]` ergänzen.
  3. `docker compose version` zeigt danach eine Version.

  Am 17.10. liefen die Dienste deshalb mit gleichwertigen `docker run`-Befehlen: gleiche Images, Container-Namen, Umgebungsvariablen und Ports, die Ports nur auf `127.0.0.1`. Der Weg über Compose ist auf deinem Mac noch ungeprüft. Beim ersten `docker compose up` kann Compose warnen, dass das Volume `postiz_postgres-volume` nicht von Compose angelegt wurde. Compose nutzt es trotzdem, die lokale Datenbank mit dem Test-Login bleibt erhalten.
- **Freie Ports:** siehe Tabelle unten.

## Einmalig einrichten

Im Terminal (zsh):

    cd ~/Projekte/postiz
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    eval "$(fnm env --shell zsh)"
    fnm use
    node -v                      # v22.x
    corepack pnpm --version      # 10.6.1
    corepack pnpm install --frozen-lockfile

`pnpm install` dauert etwa 5 Minuten. Am Ende erzeugt es den Prisma-Client. Die Warnung „Ignored build scripts“ ist erwartet, nur `bcrypt` wird gebaut.

### Lokale Dateien von Git ausnehmen

Uploads und der Test-Login liegen im Repo-Ordner, gehören aber nie in den öffentlichen Fork. `.gitignore` ist eine Postiz-Datei, eine Änderung wäre ein Patch. Die Einträge stehen deshalb in `.git/info/exclude`. Diese Datei ist nicht versioniert. Nach jedem neuen Clone einmal:

    printf '\n# ysocial local dev (not committed)\n.ysocial-dev-login\n.ysocial-dev/\n' >> .git/info/exclude
    mkdir -p .ysocial-dev/uploads
    git check-ignore -v .ysocial-dev-login .ysocial-dev/uploads

Die letzte Zeile zeigt beide Pfade mit `.git/info/exclude`. Fehlt einer, nichts committen.

### Upstream-Remote

Nach jedem neuen Clone einmal:

    git remote add upstream https://github.com/gitroomhq/postiz-app.git
    git remote set-url --push upstream no_push
    git remote -v

`git remote -v` zeigt `upstream … no_push (push)`. Ein `git push upstream` scheitert damit, nichts landet bei gitroomhq.

### `.env` anlegen

`cp .env.example .env`, dann in `.env` ändern. Die Datei liest und zeigt niemand außer dir, sie steht in `.gitignore`.

| Variable | Wert lokal | Hinweis |
|---|---|---|
| `DATABASE_URL` | `postgresql://postiz-local:postiz-local-pwd@localhost:5432/postiz-db-local` | Die Vorlage nennt andere Zugangsdaten als `docker-compose.dev.yaml` |
| `JWT_SECRET` | Ausgabe von `openssl rand -hex 48` | |
| `MAIN_URL` | `http://localhost:4200` | fehlt in der Vorlage, sonst warnt der Start |
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `STORAGE_PROVIDER` | `local` | |
| `UPLOAD_DIRECTORY` | absoluter Pfad zu `.ysocial-dev/uploads` im Repo | `.ysocial-dev/` steht in `.git/info/exclude` (siehe oben) |
| `NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY` | `/uploads` | |
| `CLOUDFLARE_*` | leer | die Platzhalter der Vorlage löschen |
| `YSOCIAL_SERVICE_TOKEN` | Ausgabe von `openssl rand -hex 32` | mindestens 32 Zeichen. Fehlt er, antwortet `/ysocial/status` mit 503 |
| `DISABLE_REGISTRATION` | `true` | Genau eine Registrierung geht trotzdem, solange es keine Organisation gibt (`auth.service.ts`) |

Alle `*_CLIENT_ID`, `*_SECRET`, `*_API_KEY` bleiben leer. `RESEND_API_KEY` bleibt auskommentiert, dann ist ein neuer Nutzer sofort aktiv.

## Starten

1. Docker-Dienste starten, ohne pgAdmin, RedisInsight und admin-tools:

        docker compose -f docker-compose.dev.yaml up -d postiz-postgres postiz-redis temporal-elasticsearch temporal-postgresql temporal temporal-ui

   `pnpm run dev:docker` startet zusätzlich pgAdmin (8085), RedisInsight (5540) und admin-tools. Die brauchst du nicht, sie kosten nur Speicher.
2. Warten, bis Temporal bereit ist (etwa 1 Minute): `docker logs temporal 2>&1 | grep "Search attributes have been added"`.
3. Schema in die Datenbank schreiben: `corepack pnpm run prisma-db-push`
4. Postiz starten: `corepack pnpm run dev`. Das startet Extension, Orchestrator, Backend und Frontend parallel in einem Terminal. Der erste Start braucht etwa 1 bis 2 Minuten, die erste Seite im Frontend etwa 7 Sekunden.
5. Ersten Nutzer anlegen: `http://localhost:4200` öffnen und registrieren, oder den Test-Login unten nutzen.

## Ports

| Port | Dienst |
|---|---|
| 4200 | Frontend (Next.js) |
| 3000 | Backend (NestJS), dort liegt auch `/ysocial/status` |
| 3002 | Orchestrator (Temporal-Worker), Health-Route |
| 5432 | Postgres der Postiz-Datenbank |
| 6379 | Redis |
| 7233 | Temporal |
| 8080 | Temporal-UI |
| 8081 | Hot Reload der Browser-Extension |

## Prüfen

| Prüfung | Befehl | Erwartet |
|---|---|---|
| Frontend | `curl -s -o /dev/null -w "%{http_code}" http://localhost:4200/auth/login` | `200` |
| Backend | `curl http://localhost:3000/` | `App is running!` |
| Orchestrator | `curl http://localhost:3002/health/status` | `{"status":"ok"}` |
| Registrierung gesperrt | `curl http://localhost:3000/auth/can-register` | `{"register":false}`, sobald ein Nutzer existiert |
| ysocial ohne Token | `curl -i http://localhost:3000/ysocial/status` | `401` (ohne `YSOCIAL_SERVICE_TOKEN` in der `.env`: `503`) |
| ysocial mit Token | siehe unten | `200` und `{"ok":true,"module":"ysocial","version":"0.4.0","worker":{…}}`. Ohne die Hub-Variablen steht dort `"label":"Worker aus"` mit Grund |
| Temporal-UI | `http://localhost:8080` im Browser | Namespace `default` sichtbar |

Statusroute mit Token, ohne ihn auszugeben. Nur für dich im eigenen Terminal. Claude führt das nicht aus, weil Claude die `.env` nie liest.

    ( . ./.env; curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $YSOCIAL_SERVICE_TOKEN" http://localhost:3000/ysocial/status )

Die runden Klammern starten eine Subshell. Die Werte aus der `.env` bleiben so nicht in deinem Terminal.

Nach einer Änderung an der `.env` startest du `pnpm run dev` neu. Die Prozesse lesen die `.env` nur beim Start. Ist eine Variable in deiner Shell schon gesetzt, gewinnt sie gegen die `.env`, denn `dotenv` überschreibt nichts. Lade die `.env` deshalb nie per `source` in die Shell, in der `pnpm run dev` läuft.

## Lokaler Test-Login

Optional. Du kannst dich auch mit eigenen Daten registrieren.

Die Zugangsdaten stehen in `.ysocial-dev-login` im Repo-Root: `POSTIZ_DEV_EMAIL` (`dev@ysocial.localhost`) und `POSTIZ_DEV_PASSWORD` (erzeugt). Fehlt die Datei, legst du sie so an. Das Passwort erscheint dabei nicht im Terminal, eine vorhandene Datei bleibt unverändert:

    [ -e .ysocial-dev-login ] || (umask 077; printf 'POSTIZ_DEV_EMAIL=dev@ysocial.localhost\nPOSTIZ_DEV_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .ysocial-dev-login)

Die Datei hat die Rechte 600 und steht in `.git/info/exclude` (siehe „Lokale Dateien von Git ausnehmen“), sie wird nie committet. Mit diesen Daten registrierst du dich einmal auf `http://localhost:4200` und meldest dich danach auf `http://localhost:4200/auth/login` an. Der Login gilt nur für deine lokale Datenbank.

## Tests der ysocial-Ordner

    corepack pnpm exec jest -c libraries/ysocial/jest.config.js

Erwartet (Stand PR 18): 19 Test-Suiten grün, eine übersprungen (der Test gegen einen echten Temporal-Server, siehe unten). Die Tests nutzen keine Datenbank und laden keine `.env`: `@prisma/client` ist dort durch einen Stub ersetzt. Ein Test findet jeden Controller in `apps/backend/src/ysocial/` und schlägt fehl, wenn einer keinen `YsocialTokenGuard` hat. `pnpm test` im Root läuft upstream nicht, weil `@nx/jest` fehlt.

## ysocial-Worker lokal (ab PR 16)

Der ysocial-Worker im Orchestrator braucht einen eigenen Namespace in Temporal und drei Variablen. Ohne sie läuft Postiz normal, der Worker bleibt aus.

1. Namespace einmalig anlegen: `docker exec temporal temporal operator namespace create --namespace ysocial --address temporal:7233`. Antwort: `Namespace ysocial successfully registered.` Meldet die CLI, dass sie `temporal:7233` nicht erreicht, nimm `--address 127.0.0.1:7233`. Nach `down` und neuem `up` fehlt er wieder (anonyme Volumes, siehe unten).
2. Test gegen das lokale Temporal, ohne `.env` und ohne laufendes Postiz: `YSOCIAL_IT_TEMPORAL_ADDRESS=localhost:7233 corepack pnpm exec jest -c libraries/ysocial/jest.config.js ysocial.worker.integration`. Der Test startet den echten Worker, einen Mock-Hub und einen Ping. Erwartet: 4 Tests grün. Der Test legt die Schedules `ysocial-post-verification`, `ysocial-channel-check` und `ysocial-daily-health` an und löscht sie am Ende.
3. Worker im laufenden Orchestrator, optional: In der `.env` `HUB_INTERNAL_URL="http://localhost:3999"`, `HUB_INTERNAL_TOKEN` (Ausgabe von `openssl rand -hex 32`) und `YSOCIAL_TEMPORAL_NAMESPACE="ysocial"` eintragen und `pnpm run dev` neu starten. Im Log steht `ysocial worker running (namespace ysocial, queue ysocial-postiz)`. Unter `localhost:3999` läuft lokal kein Hub. Ein Ping (`docker exec temporal temporal workflow start --namespace ysocial --task-queue ysocial-postiz --type ysocialPingWorkflow --workflow-id ysocial-ping-lokal --address temporal:7233`) wiederholt deshalb die Zustellung, bis du den Workflow `ysocial-event-…` in der Temporal-UI beendest.

Die Variablen und das Format der Ereignisse beschreibt `apps/orchestrator/src/ysocial/README.md`.

## Stoppen

1. `pnpm run dev`: im Terminal `Ctrl+C`.
2. Docker-Dienste:
   - `docker compose -f docker-compose.dev.yaml stop` hält die Container an. Alles bleibt erhalten, `start` macht weiter.
   - `docker compose -f docker-compose.dev.yaml down` entfernt die Container. Die Postiz-Datenbank bleibt im Volume `postiz_postgres-volume`.
   - Nie `down -v`. Das löscht die Postiz-Datenbank.

## Bekannte Stolperstellen

- **Docker-Speicher:** Die Colima-VM hat 8 GB (Docker meldet 7,7 GB). Sie teilt sich den Speicher mit den Containern anderer lokaler Projekte. Die Postiz-Dienste brauchten am 17.10. zusammen etwa 0,9 GB, davon Elasticsearch 0,6 GB. Deshalb pgAdmin und RedisInsight weglassen. Andere Container nie stoppen, um Platz zu schaffen. Fehlt Speicher, mehr RAM für Colima nur mit Florians OK.
- **Speicher auf dem Mac:** Die Node-Prozesse laufen außerhalb von Docker. Die Watcher von Backend und Orchestrator belegten je etwa 3 GB, Next.js etwa 1,2 GB.
- **Temporal-Daten:** Temporal-Postgres und Elasticsearch nutzen in `docker-compose.dev.yaml` anonyme Volumes. Nach `down` und neuem `up` startet Temporal leer. Lokal geplante Posts haben dann keinen Workflow mehr. Die alten anonymen Volumes bleiben als „dangling“ liegen (`docker volume ls -f dangling=true`). Zum Pausieren `stop` nutzen.
- **Port 3000 belegt:** Ein anderes lokales Projekt kann Port 3000 nutzen. Dann in der `.env` `PORT="3001"` setzen und `NEXT_PUBLIC_BACKEND_URL` und `BACKEND_INTERNAL_URL` auf `http://localhost:3001` ändern.
- **Prisma liest eine `.env`:** Der generierte Prisma-Client lädt beim Import die Datei `.env` drei Ebenen über `node_modules/.prisma/client`, also die `.env` im Repo-Root. Zeigt `node_modules` in einem Worktree per Link auf den Haupt-Checkout, ist das die `.env` des Haupt-Checkouts. Jeder Prozess, der Postiz-Code mit Prisma startet, hat danach deren Werte in seiner Umgebung. Für Claude Code heißt das: Postiz-Prozesse nur starten, wenn Florian zustimmt, und keine Umgebung ausgeben. Die ysocial-Tests sind davon frei (Stub).
- **Falsches Node:** Ohne `fnm use` läuft Node 26. Jede neue Shell braucht `eval "$(fnm env --shell zsh)"` und `fnm use`, oder `fnm exec --using=22 …` vor dem Befehl.
- **Anmeldung im Browser:** Postiz setzt das Cookie `auth` mit `secure`. Chrome und Firefox akzeptieren das auf `http://localhost`. Safari ist ungeprüft. Klappt die Anmeldung dort nicht, nutze Chrome.
- **Medien lokal:** Ohne den nginx aus dem Postiz-Image liefert lokal niemand `/uploads/…` aus. Vorschauen hochgeladener Bilder sind lokal ungeprüft. Instagram und TikTok holen Medien ohnehin per öffentlicher URL, Test-Posts laufen deshalb auf Staging (E7).
- **Nicht gebaute Pakete:** pnpm 10 führt nur das Build-Skript von `bcrypt` aus. `canvas` und andere bleiben ungebaut. Start, Anmeldung und Statusroute laufen trotzdem. Funktionen, die `canvas` brauchen, sind lokal ungeprüft.
