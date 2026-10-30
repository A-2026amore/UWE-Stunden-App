# Arbeitsstand Stunden-App 1.0 (Übergabe zwischen Sitzungen)

Diese Datei hält fest, wo die Entwicklung steht, damit eine neue Sitzung nahtlos weitermachen kann.
Stand: 29.10.2026, 01:00.

## Branches
| Branch | Zweck | Basis |
|---|---|---|
| `main` | produktive Alt-App (GitHub Pages) – nicht anfassen | – |
| `develop` | Plattform 0.1 (PR #1, Entwurf) | – |
| `claude/docker-testumgebung` | Docker/Compose für netcup-Testumgebung (PR #3) | develop |
| `fix/qa-2026-10-28` | QA-Korrekturen (PR #4) | docker-testumgebung |
| `release/1.0` | Integrationszweig für 1.0 | fix/qa-2026-10-28 |
| `feature/preismodell` | 5 € je abrechenbarem Mitarbeiter, Sperren, Abrechnung (0012) – **in release/1.0** | release/1.0 |
| `feature/korrekturanfragen` | Korrekturanfragen (0013) – **in release/1.0** (PR #6) | release/1.0 |
| `feature/pausen-eingabe` | keine automatische Pause, gesetzliche Schwellen (0014) – **in release/1.0** (PR #5) | release/1.0 |
| `feature/chef-admin-feinschliff` | Chef-Portal/Super-Admin vervollständigen, PDF/CSV, Systemübersicht (0015) – in Arbeit | release/1.0 |
| `feature/sicherheit-dsgvo-backup` | Sicherheitsprüfung, DSGVO, Backup/Restore, Testzugänge (0016) – in Arbeit | release/1.0 |

Feature-Branches gehen per Draft-PR nach `release/1.0`. Nichts geht ohne Freigabe nach `main`.

## Vorgaben des Auftraggebers (28.10.2026)
- Preis: 5,00 € netto je aktivem Mitarbeiter/Monat, keine Grundgebühr/Staffel; Leitung ohne eigene Zeiten kostenlos;
  Gesperrte/Deaktivierte ab nächstem Monat nicht berechnet; Sonderkonditionen und Gratis-Konten; Zahlungsdienst nur vorbereiten.
- Hosting: eigener netcup-Server (appzentrale24.de, Docker + Caddy), Backups Hetzner Storage Box, Forgejo geplant.
  Keine neuen GitHub-Pages-Deployments. Keine Änderungen an produktiven Diensten/Backups ohne Freigabe.
- Bisherige Stunden müssen nicht übernommen werden; produktive Daten nie löschen oder ändern.

## Offene Entscheidungen
- Pausenschwelle: entschieden 28.10.2026 – neue Mandanten gesetzlich, UWE streng (umgesetzt).
- N1: entschieden 28.10.2026 – Korrektur nach Freigabe nur nach dokumentierter Wiederöffnung (Begründung) und erneuter
  Freigabe; Zahlen werden neu berechnet; Abrechnung bleibt unverändert. Umgesetzt in `feature/wiedereroeffnung-rechnungen`
  (Migration 0017), siehe `docs/database.md`.
- Gesperrte Firmen ab Folgemonat 0 € (0018) und Rechnungen mit lückenlosen Nummern (0019): umgesetzt im selben Branch.
  Offen: USt-Satz 19 % vom Auftraggeber bestätigen; Absenderangaben (§ 14 UStG) im Super-Admin eintragen.
- PR #2 (Version 28 der Alt-App) wartet auf Freigabe.

## Hindernisse
- Diese Cloud-Umgebung erreicht `appzentrale24.de` nicht (Netzwerkregel, SSH gesperrt). Nötig: eigene Cloud-Umgebung mit
  erlaubter Domain und ggf. SSH-Schlüssel als Geheimnis. Bis dahin: Entwicklung und Tests nur hier (lokales PostgreSQL).

## Nächste Schritte
1. Alle Feature-Branches, Design (`feature/design-stundenwerk`) und Schlussprüfung (`fix/final-qa`) sind in `release/1.0`;
   zusätzlich Migration 0021 (Monat mit gültiger Rechnung nur nach Storno änderbar). Ergebnisse: `docs/abnahme-1.0.md`.
2. Testversion auf dem Server starten: `deploy/update-test.sh release/1.0 --seed-test-env` (braucht Serverzugang).
3. Echter Wiederherstellungstest aus der Storage Box: `docs/backup-bericht-1.0.md`.
4. Test auf echten Geräten; offene Punkte in `docs/abnahme-1.0.md` Abschnitt 3.
5. Die Hilfs-Branches `feature/ci-webkit-debug`, `-debug2` und `-debug3` (nur Fehlersuche für die iPhone-Emulation)
   können gelöscht werden; das Löschen war aus dieser Umgebung nicht erlaubt.
