# libraries/ysocial

Gemeinsamer Code für die ysocial-Ordner in Backend und Orchestrator.

- `src/service.token.ts`: Prüfung des internen Service-Tokens `YSOCIAL_SERVICE_TOKEN`. Fail-closed: nicht gesetzt oder kürzer als 32 Zeichen bedeutet „nicht konfiguriert“. Der Vergleich läuft in konstanter Zeit über SHA-256 und `timingSafeEqual`.
- `src/ysocial.version.ts`: Version des ysocial-Moduls, die `GET /ysocial/status` meldet.
- `jest.config.js`: Jest für die ysocial-Ordner. Aufruf aus dem Repo-Root mit Node 22: `pnpm exec jest -c libraries/ysocial/jest.config.js`.

Import nur mit relativen Pfaden, zum Beispiel `../../../../libraries/ysocial/src/service.token`. Ein Alias in `tsconfig.base.json` wäre ein zusätzlicher Patch.

Dieser Ordner hat kein `package.json`, wie die anderen Ordner unter `libraries/`.
