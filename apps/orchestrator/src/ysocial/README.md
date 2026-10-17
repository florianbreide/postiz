# ysocial im Orchestrator

In Phase 0 liegt hier nur diese Datei. Der Ordner ist für eigenen Orchestrator-Code reserviert.

## Inhalt ab Phase 1

- Workflow `PostVerification`: prüft nach jedem Post über die Plattform-API, ob der Post live ist, und speichert den Link. Fehlt der Post nach 5 Minuten, gibt es einen Alarm.
- Workflow `DailyHealth`: läuft täglich um 07:00 Uhr. Er prüft Tokens, die in 7 Tagen ablaufen, Posts im Status ERROR, getrennte Kanäle und Inbox-Abrufe, die seit mehr als 30 Minuten nichts geliefert haben. Ergebnis ist ein Sammelalarm.

Vorgabe: Übergabe §7.1 und §11 (Phase 1) im Hub-Repo, lokal `../social-hub/docs/HANDOVER.md`.

## Was das braucht

- **Einen Patch** in `apps/orchestrator/src/app.module.ts`, um die ysocial-Aktivitäten zu registrieren (W7). Er kommt mit Grund in `YSOCIAL-PATCHES.md`. Danach sind 2 von höchstens 5 Patches belegt.
- `apps/orchestrator/src/workflows/index.ts` ändern wir nicht. Die Datei ändert sich upstream oft (13-mal in 6 Monaten). Eigene Workflows laufen in einem eigenen Worker (E6).

## Regeln

- Postiz-Workflows nie ändern, sondern versionieren.
- Aktivitäten werden nach Methodennamen auf jeder Queue registriert. Eigene Aktivitäten tragen deshalb das Präfix `ysocial`, damit kein Name mit Postiz kollidiert.
- Workflows des Hubs laufen im Namespace `ysocial` und setzen nie das Suchattribut `postId`. Postiz beendet sonst beim Umplanen und Löschen fremde Workflows.
- Gemeinsamer Code liegt in `libraries/ysocial/` und wird mit relativen Pfaden importiert.
