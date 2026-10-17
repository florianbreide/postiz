# Claude Code im Fork `florianbreide/postiz`

Dieser Fork von Postiz gehört der Y Social Media GmbH. Er ist öffentlich (AGPL).

**Verbindlich ist die Übergabe:** `../social-hub/docs/HANDOVER.md` im lokalen Nachbar-Checkout von `florianbreide/social-hub`. Sie hat Vorrang vor diesem Code, vor dieser Datei und vor der Postiz-`CLAUDE.md` im Root. Widersprüche meldest du, du löst sie nicht still. Fehlt der Nachbar-Checkout, frag Florian.

Lies zu Beginn: die Root-`CLAUDE.md` von Postiz (sie gilt weiter und bleibt unverändert), dann diese Datei, dann `YSOCIAL-PATCHES.md`.

## Die 12 Regeln (Übergabe §10, im Wortlaut)

1. Diese Übergabe schlägt vorhandenen Code. Widersprüche werden gemeldet.
2. **Kein Post und keine Antwort ohne menschliche Freigabe.** Die KI schlägt vor, Menschen senden.
3. Keine Secrets im Code. Alles läuft über Umgebungsvariablen, die Vorlage steht in `.env.example`. Fehlende Konfiguration führt zur Abweisung (fail-closed).
4. **Pipedrive nur lesen.**
5. **ClickUp:** nur Status und Kommentare an Content-Aufgaben, nur bei `CLICKUP_WRITE=true` und freigeschalteter Liste. Nie Zuweisungen oder Fälligkeiten ändern.
6. **Keine Kundendaten im Git:** keine echten Kommentare, Brand-Kits oder Screenshots mit Kundendaten. Testdaten stammen nur aus Kanälen von Y Social oder sind erfunden.
7. Postiz-Regeln gelten: Workflows versionieren, Provider-Logik in Provider-Dateien, pnpm, Prisma, PR mit `# QA`.
8. Fork: eigener Code nur in den `ysocial`-Ordnern. Jede Postiz-Datei, die du anfasst, kommt in `YSOCIAL-PATCHES.md`. Keine neuen Tabellen im Postiz-Schema.
9. Jede schreibende Aktion prüft die Berechtigung selbst.
10. Jede Funktion, die postet, antwortet oder in ClickUp schreibt, hat einen Test mit gemockter Plattform.
11. Oberflächen-PRs zeigen Screenshots hell/dunkel und Desktop/Handy und nennen in `docs/DESIGN.md` die Quelle jeder neuen Entscheidung.
12. `ROADMAP.md` nach jedem PR pflegen. Florian mergt.

## Regeln für diesen Fork

- Eigener Code liegt nur in `apps/backend/src/ysocial/`, `apps/orchestrator/src/ysocial/` und `libraries/ysocial/`.
- Jede Postiz-Datei, die du anfasst, kommt mit Stelle, Grund und Datum in `YSOCIAL-PATCHES.md`. Höchstens 5 Patches, der Zähler steht dort. Neue Dateien außerhalb der ysocial-Ordner stehen dort in Tabelle 2.
- Keine neuen Tabellen im Postiz-Schema. `prisma db push` läuft bei jedem Start von Postiz. Fremde Tabellen in der Postiz-Datenbank würden gelöscht oder blockieren den Start. Daten des Hubs liegen in der eigenen Datenbank `hub`.
- `libraries/ysocial/` importierst du mit relativen Pfaden. Ein neuer Alias in `tsconfig.base.json` wäre ein weiterer Patch.
- Jeder ysocial-Controller bekommt `YsocialTokenGuard` oder einen strengeren Guard. Die globalen Postiz-Guards lassen neue Controller durch, die Auth-Middleware gilt nur für eine feste Liste von Postiz-Controllern. Kein ysocial-Pfad enthält `/auth`, denn der `PoliciesGuard` überspringt solche Pfade. Ein Test in `ysocial.token.guard.spec.ts` prüft den Guard an jedem Controller. Einen strengeren Guard trägst du dort in `ACCEPTED_GUARDS` ein.
- Fehlt ein Secret, weist der Code ab (fail-closed). Tokens erscheinen nie in Logs oder Antworten.
- Temporal: Postiz-Workflows nie ändern, sondern versionieren. Eigene Aktivitäten tragen das Präfix `ysocial`, weil Aktivitäten nach Methodennamen registriert werden. Workflows des Hubs setzen nie das Suchattribut `postId`.
- Nie PRs an `gitroomhq/postiz-app`. Die PR-Basis ist immer `florianbreide/postiz`. Prüfe das vor jedem `gh pr create` mit `gh repo set-default --view`. Der Remote `upstream` hat die Push-Adresse `no_push`, das bleibt so.
- Nie direkt auf `main` pushen. Florian mergt.
- Upstream nur über Release-Tags: monatlich PR `upstream-sync/<yyyy-mm>`, Sicherheitsreleases sofort. Ablauf in `YSOCIAL-PATCHES.md`, Prüfliste in `docs/STAGING-TESTPLAN.md`. Änderungen in `.github/workflows/`, `.claude/` und `CLAUDE.md` liest du vor dem Merge.
- Die `.env` liest du nie und gibst sie nie aus. `.claude/settings.json` von Postiz sperrt das zusätzlich.
- Der Fork ist öffentlich: keine Kundennamen, keine Preise, keine Server-Adressen, keine Secrets in Dateien, Commits oder PRs.
- Node 22 per `fnm` (`.node-version`), pnpm 10.6.1 per corepack. Node 26 ist auf Florians Mac Standard, Postiz läuft damit nicht.
- PRs nutzen die Überschriften der Postiz-Vorlage mit `# QA` und nummerierten Schritten. Die Haken zu CLA und „kein KI-Code“ setzt du nicht, du vermerkst „interner Fork-PR“.
- Den Status pflegst du in der Hub-ROADMAP (`../social-hub/ROADMAP.md`). Die `ROADMAP.md` hier enthält nur den Patch-Stand und Verweise.

## Arbeitsweise (Übergabe §0)

- Vor jeder Phase gibt es einen `PLAN.md` im Hub. Florian gibt ihn frei, erst dann baust du.
- Kleine Pull Requests, jeder mit `# QA`.
- Fehlt eine Entscheidung, frag nach. Rate nicht, vor allem nicht bei allem, was postet, antwortet oder in ClickUp schreibt.
- Sprache in Dokumenten und Oberfläche: Deutsch, klar, ohne Floskeln, im Team „du“. Code und Kommentare dürfen Englisch sein.

## Befehle

- Lokal starten: `docs/YSOCIAL-LOKAL.md`
- Tests der ysocial-Ordner: `pnpm exec jest -c libraries/ysocial/jest.config.js` und `node --test libraries/ysocial/upstream-check/ysocial-upstream-check.test.mjs`
- Patch-Prüfung: `git diff <basis-tag> --stat` zeigt nur Dateien aus `YSOCIAL-PATCHES.md`.
