# Arbeitsstand Stunden-App 1.0 (Übergabe zwischen Sitzungen)

Diese Datei hält fest, wo die Entwicklung steht, damit eine neue Sitzung nahtlos weitermachen kann.
Stand: 28.10.2026 (Sprint-Start „Stunden-App 1.0“).

## Branches
| Branch | Zweck | Basis |
|---|---|---|
| `main` | produktive Alt-App (GitHub Pages) – nicht anfassen | – |
| `develop` | Plattform 0.1 (PR #1, Entwurf) | – |
| `claude/docker-testumgebung` | Docker/Compose für netcup-Testumgebung (PR #3) | develop |
| `fix/qa-2026-10-28` | QA-Korrekturen (PR #4) | docker-testumgebung |
| `release/1.0` | Integrationszweig für 1.0 | fix/qa-2026-10-28 |
| `feature/preismodell` | 5 € je abrechenbarem Mitarbeiter, Sperren, Abrechnung (Migration 0012) | release/1.0 |
| `feature/korrekturanfragen` | Korrekturanfragen Mitarbeiter → Leitung (Migration 0013) | release/1.0 |
| `feature/pausen-eingabe` | keine automatische Pause, gesetzliche Schwellen (Migration 0014 falls nötig) | release/1.0 |

Feature-Branches gehen per Draft-PR nach `release/1.0`. Nichts geht ohne Freigabe nach `main`.

## Vorgaben des Auftraggebers (28.10.2026)
- Preis: 5,00 € netto je aktivem Mitarbeiter/Monat, keine Grundgebühr/Staffel; Leitung ohne eigene Zeiten kostenlos;
  Gesperrte/Deaktivierte ab nächstem Monat nicht berechnet; Sonderkonditionen und Gratis-Konten; Zahlungsdienst nur vorbereiten.
- Hosting: eigener netcup-Server (appzentrale24.de, Docker + Caddy), Backups Hetzner Storage Box, Forgejo geplant.
  Keine neuen GitHub-Pages-Deployments. Keine Änderungen an produktiven Diensten/Backups ohne Freigabe.
- Bisherige Stunden müssen nicht übernommen werden; produktive Daten nie löschen oder ändern.

## Offene Entscheidungen
- Pausenschwelle „ab genau 6/9 h“ (UWE heute) vs. gesetzlich „mehr als 6/9 h“ (Empfehlung: neue Mandanten gesetzlich, UWE streng).
- N1: Korrektur in freigegebenem Monat ändert Abrechnungszahlen nicht (siehe PR #4).
- PR #2 (Version 28 der Alt-App) wartet auf Freigabe.

## Hindernisse
- Diese Cloud-Umgebung erreicht `appzentrale24.de` nicht (Netzwerkregel, SSH gesperrt). Nötig: eigene Cloud-Umgebung mit
  erlaubter Domain und ggf. SSH-Schlüssel als Geheimnis. Bis dahin: Entwicklung und Tests nur hier (lokales PostgreSQL).

## Nächste Schritte
1. Feature-Branches prüfen, Draft-PRs nach `release/1.0`, zusammenführen, Gesamttest.
2. Chef-Portal: Stunden je Mitarbeiter/Monat, PDF/CSV-Export prüfen; Super-Admin-Systemübersicht.
3. Sicherheits-/Mandantentests, mobile Tests, Abnahmebericht mit offenen Punkten vor Verkauf.
