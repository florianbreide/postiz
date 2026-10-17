# libraries/ysocial

Gemeinsamer Code für die ysocial-Ordner in Backend und Orchestrator.

- `src/service.token.ts`: Prüfung des internen Service-Tokens `YSOCIAL_SERVICE_TOKEN`. Fail-closed: nicht gesetzt oder kürzer als 32 Zeichen bedeutet „nicht konfiguriert“. Der Vergleich läuft in konstanter Zeit über SHA-256 und `timingSafeEqual`.
- `src/ysocial.version.ts`: Version des ysocial-Moduls, die `GET /ysocial/status` meldet.
- `jest.config.js`: Jest für die ysocial-Ordner. Aufruf aus dem Repo-Root mit Node 22: `pnpm exec jest -c libraries/ysocial/jest.config.js`.
- `upstream-check/`: Logik des Workflows `.github/workflows/ysocial-upstream-check.yml`, dazu Tests und erfundene Testdaten. Reines ESM ohne Abhängigkeiten, denn der Workflow lädt nur diesen Ordner und installiert nichts. Jest lässt die Tests aus. Aufruf aus dem Repo-Root mit Node 22: `node --test libraries/ysocial/upstream-check/ysocial-upstream-check.test.mjs`.

Import nur mit relativen Pfaden, zum Beispiel `../../../../libraries/ysocial/src/service.token`. Ein Alias in `tsconfig.base.json` wäre ein zusätzlicher Patch.

Dieser Ordner hat kein `package.json`, wie die anderen Ordner unter `libraries/`.
