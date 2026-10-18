# Staging-Testplan für den Upstream-Sync

Diese Liste gilt für jeden PR `upstream-sync/<yyyy-mm>` und jeden Sicherheits-Sync. Erst wenn alle Punkte grün sind, geht der neue Stand in Produktion.

**Regel: Nie an einem Tag mit vielen geplanten Posts.** Vor dem Start in Postiz prüfen, wie viele Posts für heute und morgen geplant sind. Sind es viele, verschieben wir den Sync.

**Kein Post ohne Florians Freigabe (Regel 2).** Florian legt Text, Bild und Zeitpunkt jedes Testposts fest und ob der Post danach stehen bleibt oder gelöscht wird. Planen, Veröffentlichen, Umplanen und Löschen auf echten Kanälen löst Florian selbst in Postiz aus. Claude bereitet vor und prüft danach Status und Link.

Getestet wird nur mit Kanälen von Y Social. Keine Kundenkanäle, keine Kundendaten in Screenshots oder im PR.

## Vorher

1. [ ] Sync-PR gelesen: Änderungen in `.github/workflows/`, `.claude/` und `CLAUDE.md` geprüft.
2. [ ] Neue Upstream-Workflows sind per `gh workflow disable` abgeschaltet.
3. [ ] Alle Patches aus `YSOCIAL-PATCHES.md` sind noch an ihrer Stelle, Zähler stimmt.
4. [ ] Release-Notes gelesen: neue Pflicht-Variablen, Schema-Änderungen, neue Workflow-Versionen.
5. [ ] Tests aus den ysocial-Ordnern sind grün: `pnpm exec jest -c libraries/ysocial/jest.config.js`.
6. [ ] Backup von Staging ist frisch (`pgbackrest info` für beide Cluster).
7. [ ] Uhrzeit des Starts im PR notiert.
8. [ ] Testposts mit Florian abgestimmt: je Plattform Text, Bild und Zeitpunkt, dazu ob der Post danach stehen bleibt. Ohne diese Freigabe gibt es keinen Testpost, und der Sync wartet.

## Auf Staging

9. [ ] Neuer Stand läuft. `prisma db push` beim Start lief ohne Fehler durch (Log von Postiz).
10. [ ] Healthchecks: `infra/scripts/health.sh` meldet alle Dienste `healthy`. Orchestrator `/health/status` antwortet mit 200.
11. [ ] ysocial-Statusroute intern, im Container `postiz` (das Image hat kein `curl`):
    - `docker exec postiz node -e 'fetch("http://localhost:3000/ysocial/status").then(r => console.log(r.status))'` gibt `401`.
    - `docker exec postiz node -e 'fetch("http://localhost:3000/ysocial/status", { headers: { authorization: "Bearer " + process.env.YSOCIAL_SERVICE_TOKEN } }).then(async r => console.log(r.status, await r.text()))'` gibt `200` und die erwartete Modulversion. Der Token erscheint dabei nicht. Sind die Hub-Variablen gesetzt (ab PR 16), steht in der Antwort `"label":"Worker an"`, sonst `"Worker aus"` mit Grund.
12. [ ] ysocial-Statusroute von außen gesperrt: Über den Staging-Host von Postiz (Name in `infra/README.md` im Hub), mit dem Passwort der Staging-Hosts, liefern `/api/ysocial/status`, `/api/YSOCIAL/status` und `/api//ysocial/status/` die Sperre von Caddy. Nie die Antwort von Postiz: kein `200`, kein `401` mit `WWW-Authenticate: Bearer realm="ysocial"`. Grund für die drei Varianten: Express unterscheidet keine Groß- und Kleinschreibung und nimmt einen Schrägstrich am Ende an, nginx fasst doppelte Schrägstriche zusammen.
13. [ ] Anmeldung in Postiz klappt, Abmelden und erneut Anmelden klappt.
14. [ ] Kanalstatus: Jeder verbundene Kanal ist aktiv. Kein Kanal zeigt „neu verbinden“, außer er tat es schon vor dem Sync.
15. [ ] Post je Plattform (nach Florians Freigabe aus Schritt 8): Florian plant je verbundener Plattform den freigegebenen Post mit Text und Bild, wenige Minuten in der Zukunft. Er erscheint auf der Plattform, Postiz zeigt PUBLISHED und eine `releaseURL`.
16. [ ] Umplanen (nach Florians Freigabe): Florian legt einen geplanten Testpost auf eine andere Uhrzeit. Er geht nur zur neuen Zeit raus, nicht doppelt.
17. [ ] Löschen (nach Florians Freigabe): Florian löscht einen geplanten Testpost. Er geht nicht raus.
18. [ ] Token-Refresh: Bei einem Kanal mit Refresh-Token die Aktualisierung auslösen. Der Kanal bleibt aktiv, im Log steht kein Fehler.
19. [ ] Medien: Bild und Video hochladen. Die Vorschau lädt, die Datei ist unter `/uploads/…` ohne Anmeldung erreichbar.
20. [ ] Neustart: Den Postiz-Container neu starten. Die geplanten Testposts sind danach noch geplant und gehen pünktlich raus. Die Datenbank `hub` ist unverändert.
21. [ ] Temporal-Workflows: In der Temporal-UI (SSH-Tunnel) laufen die Workflows der geplanten Posts. Umgeplante und gelöschte Posts haben keinen laufenden Workflow mehr. Es gibt keine fehlgeschlagenen Workflows seit dem Start.
22. [ ] Hub-Namespace `ysocial`: Die Hub-Workflows laufen weiter, kein Postiz-Workflow trägt dort ein `postId`.
23. [ ] Logs der letzten 30 Minuten: keine neuen Fehler, keine Tokens im Log.

## Danach

24. [ ] Testposts: Florian entscheidet je Post, ob er stehen bleibt, und löscht ihn bei Bedarf selbst. Im PR vermerkt.
25. [ ] Ergebnis im Sync-PR unter `# QA`, mit Uhrzeit und Abweichungen.
26. [ ] Basis und Datum in `YSOCIAL-PATCHES.md` aktualisiert, Hub-ROADMAP gepflegt.
27. [ ] Produktion erst nach Florians Merge, wieder nicht an einem Tag mit vielen geplanten Posts. Danach Schritt 12 auf dem Prod-Host von Postiz wiederholen, dort ohne Basic Auth.

## Bekannte Fristen

- LinkedIn-API-Version 202601 in Postiz endet am 15.01.2027. Ab Dezember 2026 bei jedem Sync prüfen, welche Version Postiz nutzt (R20).
