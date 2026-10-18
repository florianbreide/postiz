# ROADMAP (Fork)

Diese Datei enthält nur den Patch-Stand und Verweise. Status, Termine und offene Fragen stehen in der ROADMAP des Hubs (E18).

## Patch-Stand

- Basis: upstream v2.25.1 (11.10.2026)
- Patches: 2 von höchstens 5 (`apps/backend/src/app.module.ts`, `YsocialModule`; `apps/orchestrator/src/app.module.ts`, `YsocialOrchestratorModule`)
- Geplant: Patch 3 für verschlüsselte Kanal-Tokens in Phase 1 (PR 25)
- Details und neue Dateien außerhalb der ysocial-Ordner: `YSOCIAL-PATCHES.md`

## Verweise

- Status und nächste Schritte: `ROADMAP.md` im Repo `florianbreide/social-hub` (lokal `../social-hub/ROADMAP.md`)
- Verbindliche Vorgabe: `docs/HANDOVER.md` im Repo `florianbreide/social-hub` (lokal `../social-hub/docs/HANDOVER.md`)
- Upstream-Sync: `YSOCIAL-PATCHES.md`, Prüfliste `docs/STAGING-TESTPLAN.md`
- Upstream-Prüfung: Workflow `.github/workflows/ysocial-upstream-check.yml`, jeden Montag, Issue „Postiz <tag> verfügbar“ (Abschnitt „Auslöser“ in `YSOCIAL-PATCHES.md`). Logik und Tests: `libraries/ysocial/upstream-check/`
- Fork-Image: Workflow `.github/workflows/ysocial-image.yml`, bei jedem Push auf `main` und von Hand, Image `ghcr.io/florianbreide/postiz`. Digest in der Zusammenfassung des Laufs
- Lokaler Start: `docs/YSOCIAL-LOKAL.md`
- Regeln für Claude Code: `.claude/CLAUDE.md`
