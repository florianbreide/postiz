# libraries/ysocial

Gemeinsamer Code für die ysocial-Ordner in Backend und Orchestrator.

- `src/service.token.ts`: Prüfung des internen Service-Tokens `YSOCIAL_SERVICE_TOKEN`. Fail-closed: nicht gesetzt oder kürzer als 32 Zeichen bedeutet „nicht konfiguriert“. Der Vergleich läuft in konstanter Zeit über SHA-256 und `timingSafeEqual`.
- `src/ysocial.version.ts`: Version des ysocial-Moduls, die `GET /ysocial/status` meldet.
- `src/worker/worker.config.ts`: Konfiguration des ysocial-Workers im Orchestrator aus `HUB_INTERNAL_URL`, `HUB_INTERNAL_TOKEN`, `YSOCIAL_TEMPORAL_NAMESPACE` und `YSOCIAL_WORKER_ENABLED`. Fail-closed, die Meldungen nennen nur Namen, nie Werte.
- `src/worker/worker.status.ts`: Zustand des Workers in Redis (`ysocial:worker:status`). Der Orchestrator schreibt, das Backend liest.
- `src/events/hub.event.ts`: Format der Ereignisse an den Hub, feste Kennung, Bereinigung der Gründe. Läuft auch in Temporal-Workflows, deshalb ohne Node.js-Importe.
- `src/events/hub.client.ts`: `POST /api/internal/events` an den Hub, mit Einordnung der Antworten in „wiederholen“ und „endgültig“.
- `src/verification/post.verification.ts`: Regeln von `PostVerification` nach E22 als reine Funktionen. Läuft im Workflow, ohne Node.js-Importe.
- `src/verification/provider.rules.ts`: Tabelle je Provider, welche Antwort von `postAnalytics` „gibt es“ und welche „gibt es nicht“ heißt.
- `src/verification/ysocial.post.verification.service.ts`: liest Posts und prüft einen Post über `postAnalytics`. Der Kanal-Token bleibt in dieser Klasse.
- `src/database/ysocial.post.repository.ts`: lesende Prisma-Abfragen auf `Post` mit fester Feldliste.
- `src/database/ysocial.integration.repository.ts`: lesende Abfragen auf `Integration` für die Kanal-Prüfung.
- `src/database/ysocial.read.repository.ts`: Feldlisten und Abfragen der Lese-API für den Hub.
- `src/health/channel.health.ts`: Kanal-Prüfung als reine Funktionen: getrennt, wieder verbunden, entfernt, Ablauf des Zugangs.
- `src/health/channel.auth.rules.ts`: Was die Antwort von `analytics` über den Zugang sagt.
- `src/health/ysocial.channel.health.service.ts`: stündliche Kanal-Prüfung und `DailyHealth`, Zustand in Redis.
- `src/read/ysocial.read.service.ts`, `src/dtos/ysocial.posts.query.dto.ts`: Lese-API für den Hub.
- `jest/prisma-client.stub.js`: Ersatz für `@prisma/client` in den Tests. Der echte Client lädt beim Import eine `.env` (siehe `docs/YSOCIAL-LOKAL.md`).
- `jest.config.js`: Jest für die ysocial-Ordner. Aufruf aus dem Repo-Root mit Node 22: `pnpm exec jest -c libraries/ysocial/jest.config.js`.
- `upstream-check/`: Logik des Workflows `.github/workflows/ysocial-upstream-check.yml`, dazu Tests und erfundene Testdaten. Reines ESM ohne Abhängigkeiten, denn der Workflow lädt nur diesen Ordner und installiert nichts. Jest lässt die Tests aus. Aufruf aus dem Repo-Root mit Node 22: `node --test libraries/ysocial/upstream-check/ysocial-upstream-check.test.mjs`.

Import nur mit relativen Pfaden, zum Beispiel `../../../../libraries/ysocial/src/service.token`. Ein Alias in `tsconfig.base.json` wäre ein zusätzlicher Patch.

Dieser Ordner hat kein `package.json`, wie die anderen Ordner unter `libraries/`.
