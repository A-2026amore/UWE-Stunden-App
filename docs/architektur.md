# Architektur der Zeiterfassungsplattform

Produktname: „Schichtklar24“ (vorläufig, vorbehaltlich Markenprüfung; eine Konstante in `platform/src/design/branding.ts`). Designsystem: siehe `docs/design.md`.
UWE – Krankentransporte GmbH ist der erste Mandant, nicht das Produkt.

## 1. Zielbild

```
                 ┌──────────────────────── Browser / installierte PWA ────────────────────────┐
                 │  Mitarbeiter-App (mobil)   Chef-Webportal (Desktop)   Super-Admin-Portal   │
                 │            └──────────── gemeinsames Designsystem ───────────┘            │
                 │            └──────────── Fachlogik platform/src/core ────────┘            │
                 │            └──────────── Repository-Schnittstelle ───────────┘            │
                 │                   │                               │                         │
                 │          DemoRepository                      ApiRepository                 │
                 │   (Testdaten im Browser, Staging)    (Produktion, nach Freigabe)           │
                 └───────────────────────────────────────────────────┼─────────────────────────┘
                                                                     │ HTTPS, Sitzungs-Cookie
                                                   ┌─────────────────▼─────────────────┐
                                                   │ Eigener Server in Deutschland      │
                                                   │  • Node-API (Anmeldung inkl. 2FA)  │
                                                   │  • PostgreSQL 16 + Row Level Sec.  │
                                                   │  • Logos als Datenbank-/Dateispeicher│
                                                   │  • Backups (verschlüsselt, extern) │
                                                   └────────────────────────────────────┘
```

Die bestehende UWE-App im Repository-Stamm bleibt unverändert produktiv, bis die Umstellung
freigegeben ist.

## 2. Verzeichnisstruktur

| Pfad | Inhalt |
|---|---|
| `/` (Stamm) | Bestehende Produktiv-App (GitHub Pages). Wird auf `develop` nicht verändert. |
| `platform/` | Neue Plattform (Vite, Preact, TypeScript) |
| `platform/src/core/` | Reine Fachlogik: Zeiten, Pausen, Arbeitszeitkonto, Migration, PDF |
| `platform/src/data/` | Repository-Schnittstelle, Demo- und API-Anbindung |
| `platform/src/design/` | Designsystem (Tokens, Komponenten, White-Label) |
| `platform/src/apps/` | Mitarbeiter-App, Chef-Portal, Super-Admin |
| `db/migrations/` | SQL-Schema inkl. RLS-Richtlinien |
| `server/` | Node-API (Anmeldung, Daten unter RLS) |
| `tests/` | Unit-, Datenbank-, Alt-App- und End-to-End-Tests |
| `docs/` | Dokumentation |

## 3. Architekturentscheidungen (ADR)

### ADR-1: Bestehende App nicht ersetzen, sondern parallel modernisieren
Die Produktiv-App bleibt im Stamm. Neue Plattform in `platform/`. Fachregeln werden aus dem
Altcode übernommen und durch Vergleichstests (Tausende generierte Fälle, alt gegen neu) abgesichert.
*Grund:* Mitarbeiter nutzen die App produktiv; Regeln dürfen nicht unbemerkt abweichen.

### ADR-2: PostgreSQL mit Row Level Security als Sicherheitsgrenze
Mandantentrennung wird in der Datenbank erzwungen (jede Tabelle mit `tenant_id`, RLS-Richtlinien
pro Rolle). Frontend-Prüfungen dienen nur der Bedienbarkeit.
*Grund:* Ein Fehler in einer Oberfläche darf nie zu fremden Daten führen.

### ADR-3: Eigener Server in Deutschland (Entscheidung des Auftraggebers vom 26.10.2026)
Der Auftraggeber hat sich gegen Supabase und für einen eigenen Server (z. B. Hetzner, Deutschland)
entschieden. Folgen:

- **Datenbank:** PostgreSQL 16. Die Mandantentrennung bleibt in der Datenbank (RLS).
- **API:** eigene schlanke Node-API (`server/`). Jede Anfrage läuft in einer Transaktion mit
  `set local role` und `set local request.jwt.claims` (Benutzer-ID), damit die RLS-Richtlinien
  greifen. Die API selbst hat keine Rechte, RLS zu umgehen.
- **Anmeldung:** E-Mail + Passwort (Hash mit scrypt), Sitzungen als HttpOnly-Cookie, Tokens nur
  gehasht gespeichert, „Passwort vergessen“ per E-Mail-Link, optionale Zwei-Faktor-Anmeldung (TOTP; Pflicht für Plattformkonten,
  per Mandant für Leitungskräfte), siehe `docs/security.md` Abschnitt 4a.
- **Betrieb:** Updates, Backups, Firewall und Monitoring liegen bei uns (siehe `docs/betrieb.md`).
- **Kosten:** ca. 5–10 €/Monat Server + ggf. Backup-Speicher; Vertrag schließt der Auftraggeber.

Bewertung der Alternativen (Stand der Entscheidung):

| Kriterium | Supabase (Frankfurt) | Eigener Server (gewählt) |
|---|---|---|
| Kosten | Pro ca. 25 $/Monat | ca. 5–10 €/Monat + Wartungszeit |
| Sicherheit/Betrieb | verwaltet | selbst: Updates, Backups, Monitoring |
| Datenschutz | EU-Region, AV-Vertrag | deutscher Anbieter, AV-Vertrag |
| Anbieterbindung | gering | keine |

### ADR-4: Offline-first mit idempotenter Synchronisierung
Jeder Eintrag erhält auf dem Gerät eine UUID. Der Server akzeptiert dieselbe ID kein zweites Mal
(keine Doppelbuchung). Jede Änderung erhöht `version`; veraltete Änderungen werden als Konflikt
gemeldet statt überschrieben. Löschen ist ein „Soft Delete“, jede Änderung landet in
`time_entry_revisions`.

### ADR-5: Mandantenkonfiguration statt fest eingebauter UWE-Regeln
Pausenschwellen, 12-Stunden-Grenze, Arbeitszeitkonto (an/aus, Modell Schuljahr/Kalenderjahr,
Startsaldo, Bundesland, Genehmigung) sind Einstellungen je Mandant. UWE erhält die bisherigen Werte.
Pausenregel: „gesetzlich“ (mehr als 6/9 h, Standard für neue Mandanten) oder „streng“ (ab genau 6/9 h,
UWE); nie laxer als § 4 ArbZG ([pausenregeln.md](pausenregeln.md)).

### ADR-6: Frontend-Technik Vite + Preact + TypeScript
Preact (ca. 4 KB) hält die App auf älteren Smartphones schnell; TypeScript (strict) verhindert
Fehlerklassen in einer wachsenden Codebasis. Keine CSS-Frameworks, keine externen CDNs/Schriften (die Schrift Inter liegt lokal im Repository, Lizenz OFL).

### ADR-7: Branch-Strategie
`main` = Produktion (GitHub Pages, geschützt, nur per Pull Request nach Freigabe des Auftraggebers).
`develop` = Integrationszweig der neuen Plattform. `feature/<thema>` für größere Arbeiten,
`release/<version>` zur Abnahme. Versionen nach SemVer, Plattform startet bei 0.x.

### ADR-8: Staging getrennt von GitHub Pages
GitHub Pages bedient nur eine Seite pro Repository und liefert die Produktiv-App aus. Eine
Testversion darf diese Konfiguration nicht verändern. Die CI erzeugt deshalb einen Build als
herunterladbares Artefakt; für eine dauerhaft erreichbare Testadresse ist ein separater kostenloser
Hosting-Dienst oder ein zweites Repository nötig (Entscheidung offen, siehe `TASKS.md`).

## 4. Rollen

| Rolle | Ebene | Darf |
|---|---|---|
| `employee` | Mandant | eigene Zeiten, eigenes Konto, eigene Nachweise |
| `manager` | Mandant | alle Daten des eigenen Mandanten lesen, Nachweise prüfen, Mitarbeiter verwalten |
| `owner` | Mandant | wie manager + Firmenprofil, Einstellungen, Support-Freigaben |
| `support` | Plattform | Mandanten-Stammdaten; personenbezogene Daten nur mit befristeter Freigabe des Mandanten |
| `super_admin` | Plattform | Mandanten und Lizenzen verwalten; personenbezogene Daten nur mit Freigabe |

Details: `docs/security.md` (Sicherheitskonzept) und `docs/database.md`.
