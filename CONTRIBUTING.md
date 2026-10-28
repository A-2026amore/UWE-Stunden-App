# Mitarbeit

## Branches

| Branch | Zweck | Regeln |
|---|---|---|
| `main` | Produktive UWE-App (GitHub Pages) | geschützt; nur Pull Request, grüne CI, Freigabe des Auftraggebers |
| `develop` | Integration der neuen Plattform | Pull Requests aus `feature/*`, grüne CI |
| `feature/<thema>` | einzelne größere Funktionen | von `develop` abzweigen |
| `release/<version>` | Abnahmestand | aus `develop`, nach Abnahme PR nach `main` |

## Versionen

- Bestehende App: fortlaufende Versionsnummer (aktuell 27), Service-Worker-Cache-Name muss bei jeder
  Änderung erhöht werden.
- Plattform: Semantic Versioning ab `0.1.0` (`package.json`); jede Änderung im `CHANGELOG.md`.

## Regeln

- Produktivdateien im Repository-Stamm nur mit Freigabe ändern.
- Keine echten Mitarbeiterdaten in Code, Tests, Screenshots oder Issues.
- Keine Geheimnisse im Repository (CI prüft mit gitleaks).
- Fachregeln (Pausen, Arbeitszeitkonto) nicht ohne fachliche Freigabe ändern; Abweichungen dokumentieren.
- Commit-Nachrichten auf Englisch im Imperativ, Doku und Oberflächen auf Deutsch.
