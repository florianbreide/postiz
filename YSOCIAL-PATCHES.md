# YSOCIAL-PATCHES

Diese Datei listet jede Abweichung unseres Forks von Postiz. Sie ist die Grundlage für jeden Upstream-Sync.

- Fork: `ysocial-media/postiz`, Original: `gitroomhq/postiz-app` (Remote `upstream`)
- Basis: upstream v2.25.1 (11.10.2026)
- Verbindliche Vorgabe: `docs/HANDOVER.md` im Repo `ysocial-media/social-hub`

## Regeln

1. Eigener Code liegt nur in `apps/backend/src/ysocial/`, `apps/orchestrator/src/ysocial/` und `libraries/ysocial/`.
2. Jede Änderung an einer Postiz-Datei ist ein Patch und steht in Tabelle 1. Höchstens 5 Patches.
3. Neue Dateien außerhalb der ysocial-Ordner zählen nicht als Patch (E6). Sie stehen in Tabelle 2.
4. Keine neuen Tabellen im Postiz-Schema. Jeder Start führt `prisma db push` aus.
5. `libraries/ysocial/` wird mit relativen Pfaden importiert. Ein neuer Alias in `tsconfig.base.json` wäre ein weiterer Patch.

## Stand

**Patches: 1 von höchstens 5**

Geplant: Phase 1 braucht einen Patch im Orchestrator (`apps/orchestrator/src/app.module.ts`) für `PostVerification` und `DailyHealth` (W7). Danach sind 2 von 5 belegt.

## Tabelle 1: Geänderte Postiz-Dateien (Patches)

| Datei | Stelle | Grund | seit |
|---|---|---|---|
| `apps/backend/src/app.module.ts` | Import von `YsocialModule` (2 Zeilen, Kommentar „ysocial patch 1“) und Eintrag `YsocialModule` am Ende von `imports` | Hängt das ysocial-Modul in das Backend ein. Ohne diese Stelle lädt Nest keinen eigenen Controller | 17.10.2026, PR 2 (`phase-0/basis`) |

## Tabelle 2: Neue Dateien außerhalb der ysocial-Ordner

| Datei | Zweck | seit |
|---|---|---|
| `YSOCIAL-PATCHES.md` | Diese Liste | 17.10.2026, PR 2 |
| `docs/STAGING-TESTPLAN.md` | Prüfliste für jeden Upstream-Sync auf Staging | 17.10.2026, PR 2 |
| `docs/YSOCIAL-LOKAL.md` | Lokaler Start mit Node 22 und pnpm 10.6.1 | 17.10.2026, PR 2 |
| `.claude/CLAUDE.md` | Regeln für Claude Code im Fork. Die Postiz-`CLAUDE.md` im Root bleibt unverändert (E16) | 17.10.2026, PR 2 |
| `ROADMAP.md` | Nur Patch-Stand und Verweise. Der Status steht in der Hub-ROADMAP (E18) | 17.10.2026, PR 2 |
| `.node-version` | Node 22 für `fnm` (E8) | 17.10.2026, PR 2 |

Geplant: `.github/workflows/ysocial-upstream-check.yml` (PR 6).

## Inhalt der ysocial-Ordner

| Ordner | Inhalt |
|---|---|
| `apps/backend/src/ysocial/` | `YsocialModule`, `GET /ysocial/status` hinter `YsocialTokenGuard`, Test |
| `libraries/ysocial/` | Gemeinsamer Code: Prüfung des Service-Tokens, Modulversion, Jest-Konfiguration |
| `apps/orchestrator/src/ysocial/` | Nur `README.md`. Inhalt kommt in Phase 1 |

Die Statusroute antwortet ohne konfiguriertes `YSOCIAL_SERVICE_TOKEN` mit 503, ohne oder mit falschem Bearer-Token mit 401, mit dem richtigen mit 200. Die globalen Postiz-Guards lassen neue Controller durch. Der eigene Guard ist deshalb Pflicht für jeden ysocial-Controller. Ein Test prüft das für jeden Controller in `apps/backend/src/ysocial/`.

Tests: `pnpm exec jest -c libraries/ysocial/jest.config.js` (Node 22). Das Root-`jest.config.ts` von Postiz braucht `@nx/jest`, das nicht installiert ist.

## Umgebungsvariablen des Forks

| Variable | Pflicht | Wert | fehlt oder zu kurz |
|---|---|---|---|
| `YSOCIAL_SERVICE_TOKEN` | ja | Zufallswert, mindestens 32 Zeichen, zum Beispiel `openssl rand -hex 32` | `/ysocial/status` antwortet mit 503 (fail-closed) |

Die `.env.example` von Postiz bleibt unverändert, eine Änderung wäre ein Patch. Die Vorlage für diese Variablen steht deshalb im Hub: in der `.env.example` (PR 3) und in `infra/` (PR 7). Dort erzeugt `scripts/gen-secrets.sh` den Wert. Hub und Postiz-Container bekommen denselben Wert. Lokal beschreibt `docs/YSOCIAL-LOKAL.md` den Eintrag. Jede neue Variable des Forks kommt in diese Tabelle und in die Hub-Vorlage.

## Upstream-Sync

**Takt**
- Monatlich ein PR `upstream-sync/<yyyy-mm>` auf das neueste Release-Tag. Nie auf upstream-`main`.
- Sicherheitsreleases sofort, als `upstream-sync/<yyyy-mm>-security` (E11).
- Nie an einem Tag mit vielen geplanten Posts.

**Ablauf**
1. `git fetch upstream --tags`, das neue Tag in einen Branch `upstream-sync/<yyyy-mm>` mergen.
2. Vor dem Merge lesen: Änderungen in `.github/workflows/`, `.claude/` und `CLAUDE.md`. Neue Upstream-Workflows sofort per `gh workflow disable` abschalten, ihre Dateien bleiben unverändert.
3. Jeden Patch aus Tabelle 1 prüfen: Ist die Stelle noch da, passt der Grund noch?
4. Neue Dateien aus Tabelle 2 auf Konflikte mit neuen Upstream-Dateien prüfen.
5. `pnpm install`, Tests aus den ysocial-Ordnern, lokaler Start nach `docs/YSOCIAL-LOKAL.md`.
6. Staging nach `docs/STAGING-TESTPLAN.md` prüfen und das Protokoll in den PR schreiben.
7. Erst danach Produktion. Florian mergt.
8. Basis oben in dieser Datei und die Spalte „seit“ aktualisieren.

PRs gehen nie an `gitroomhq/postiz-app`. Deshalb hat der Remote `upstream` keine Push-Adresse:

    git remote set-url --push upstream no_push

`git remote -v` zeigt `upstream … no_push (push)`. Vor jedem `gh pr create` zeigt `gh repo set-default --view` das Repo `ysocial-media/postiz`.
