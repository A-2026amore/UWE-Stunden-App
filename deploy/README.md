# Container-Betrieb (Docker Compose)

Testumgebung `https://stunden-test.appzentrale24.de`, später Produktion `https://stunden.appzentrale24.de`.
Betrieb **nur nach Freigabe** des Auftraggebers (siehe `CLAUDE.md`). Keine echten Mitarbeiterdaten in der
Testumgebung.

## Aufbau

```
Internet ─HTTPS─▶ Caddy (zentral, Netz "proxy")
                     │ reverse_proxy stunden-<STAGE>-app:3000
                     ▼
              stunden-<STAGE>-app   Node-API + gebaute Oberflächen (STATIC_DIR), Port 3000, Benutzer "node"
                     │ Netz stunden-<STAGE>-db (internal, ohne Internet)
                     ▼
              stunden-<STAGE>-db    PostgreSQL 16 (gepinnt), Volume stunden-<STAGE>-db-data,
                                    Label de.appzentrale24.backup=postgres
```

| Dienst | Container | Aufgabe |
|---|---|---|
| `app` | `stunden-${STAGE}-app` | API unter `/api/…`, alle anderen Pfade = Dateien aus `platform/dist` (API-Modus) mit eigener CSP. Lauscht auf **3000** (nur intern, keine `ports:`). |
| `db` | `stunden-${STAGE}-db` | PostgreSQL 16.15, nur im internen Netz. |
| `migrate` | (einmalig, `run --rm`) | Spielt `db/migrations/*.sql` ein, setzt das Passwort der Laufzeitrolle `app_api`. |

Das Image (`Dockerfile` im Repository-Stamm) baut in drei Stufen: Frontend (`VITE_DATA_MODE=api`),
Laufzeit-Abhängigkeiten (nur `pg`, `npm ci --omit=dev` aus dem Lockfile), Laufzeit auf
`node:22.22.3-bookworm-slim` (Digest gepinnt) als Benutzer `node`. Start entspricht `npm run start:server`
(ohne npm dazwischen, damit `SIGTERM` direkt bei Node ankommt).

## Datenbank-Rollen

| Rolle | Wofür | Rechte |
|---|---|---|
| `POSTGRES_USER` (z. B. `stunden_admin`) | Migrationen, Wartung, zentrales Backup (`pg_dumpall -U "$POSTGRES_USER"`) | Superuser des Containers, Eigentümer der Tabellen. Nie von der App benutzt. |
| `app_api` | Laufzeit der App (`DATABASE_URL`) | `LOGIN NOINHERIT`, **kein** `BYPASSRLS`, keine eigenen Tabellenrechte; wechselt je Anfrage per `set local role` in `app_user`/`app_anon`/`app_auth` (alle unter RLS). |

Die Rollen `app_user`, `app_anon`, `app_auth`, `app_service` (BYPASSRLS, `NOLOGIN`) legt Migration 0001 an.
Der Job `migrate` vermerkt jede Datei mit SHA-256 in `ops.schema_migrations` (Schema nur für den Eigentümer
lesbar). Bereits eingespielte Dateien werden übersprungen; wurde eine eingespielte Datei nachträglich
verändert, bricht der Job ab. Jede Migration läuft in einer eigenen Transaktion.

## Erstinstallation (Testumgebung)

Voraussetzungen: Docker mit Compose-Plugin, zentraler Caddy im externen Netz `proxy`, DNS-Eintrag
`stunden-test.appzentrale24.de` auf den Server.

```bash
git clone --branch develop https://github.com/A-2026amore/UWE-Stunden-App /srv/stunden-test
cd /srv/stunden-test
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# deploy/.env ausfüllen: Passwörter mit `openssl rand -hex 32`, TOTP-Schlüssel mit `openssl rand -base64 32`,
# TRUSTED_PROXY_IP = feste Adresse des Caddy im Netz proxy (Server-Konvention: 172.30.0.2), prüfen mit:
#   docker inspect -f '{{(index .NetworkSettings.Networks "proxy").IPAddress}}' <caddy-container>

C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$C config --quiet            # Prüft, dass alle Pflichtwerte gesetzt sind
$C build                     # Image stunden-app:local
$C up -d db
$C run --rm migrate          # Migrationen + Passwort für app_api
$C up -d app
$C ps                        # app und db: "healthy"
```

Caddy (zentrale Konfiguration, Beispiel):

```caddy
stunden-test.appzentrale24.de {
	encode zstd gzip
	reverse_proxy stunden-test-app:3000
}
```

Caddy setzt `X-Forwarded-For` selbst (ohne `trusted_proxies` wird ein vom Client mitgeschickter Wert ersetzt).
Die App wertet den Header nur aus, wenn die Verbindung von `TRUSTED_PROXY_IP` (Caddy, 172.30.0.2) kommt
(`TRUST_PROXY_CIDRS`); andere
Container können so keine fremde Client-IP vortäuschen (Rate-Limits).

Erster Super-Admin (Konsole, danach Passwort über die CLI setzen, Eingabe über stdin):

```bash
$C exec db psql -U "$POSTGRES_USER" -d stunden \
  -c "insert into auth.users (email) values ('admin@firma.example') returning id;"
$C exec db psql -U "$POSTGRES_USER" -d stunden \
  -c "insert into public.platform_admins (user_id, role) values ('<id>', 'super_admin');"
$C exec -T app node --experimental-strip-types --disable-warning=ExperimentalWarning \
  --import ./server/register.mjs server/src/cli.ts set-password admin@firma.example
```

(`$POSTGRES_USER` vorher aus `deploy/.env` übernehmen oder direkt einsetzen.) Danach im Admin-Portal anmelden und
die Zwei-Faktor-Anmeldung einrichten (Pflicht für Plattformkonten).

**Demo-Daten** (`db/seed.sql`) werden standardmäßig **nicht** eingespielt. Sie enthalten bekannte Test-Einladungen
und sind für eine öffentlich erreichbare Umgebung nicht gedacht. Nur bewusst und einmalig:
`$C run --rm -e NODE_ENV=development -e MIGRATE_SEED=1 migrate` – in Produktion nie.

## Aktualisieren

```bash
cd /srv/stunden-test && git pull
$C build
$C run --rm migrate          # nur neue Migrationen; vorher Backup (siehe unten)
$C up -d app
```

Migrationen sind nur additiv. Rücksprung auf eine ältere App-Version ist möglich, solange keine neue Migration
eingespielt wurde; sonst Wiederherstellung aus dem Backup.

## Umgebungsvariablen (`deploy/.env`)

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `STAGE` | ja | `test` oder `prod` – bildet alle Namen (`stunden-${STAGE}-app` …). |
| `APP_HOSTNAME` | ja | Öffentlicher Hostname; ergibt `PUBLIC_ORIGIN=https://…` (CSRF-Prüfung, Links in E-Mails). |
| `APP_IMAGE`, `APP_IMAGE_TAG` | – | Image-Name (Standard `stunden-app:local`). |
| `TRUSTED_PROXY_IP` | ja | Feste Adresse des Caddy im Netz `proxy` (172.30.0.2; Netz 172.30.0.0/24) → `TRUST_PROXY_CIDRS`. Nur diese Adresse darf `X-Forwarded-For` setzen. Ändert sich die Caddy-Adresse, hier anpassen – sonst sehen Rate-Limits alle Anfragen als eine IP. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | ja / ja / – | Administrator/Eigentümer, Datenbank (Standard `stunden`). |
| `APP_DB_PASSWORD` | ja | Passwort von `app_api` (≥ 16 Zeichen, nur Buchstaben/Ziffern empfohlen). |
| `TOTP_ENCRYPTION_KEY` | ja | 32 Byte (Base64/Hex). Ohne gültigen Schlüssel startet die App nicht. Getrennt von DB-Backups sichern. |
| `TOTP_ENCRYPTION_KEY_PREVIOUS`, `TOTP_ISSUER` | – | Rotation bzw. Anzeigename (`docs/betrieb.md` 6.1). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | – | Mailversand; ohne `SMTP_HOST` kein Versand. |

Fest in der Compose-Datei: `NODE_ENV=production` (Cookie `__Host-sid` mit `Secure; HttpOnly; SameSite=Strict`,
HSTS), `HOST=0.0.0.0`, `PORT=3000`, `TRUST_PROXY=1`, `STATIC_DIR=/app/platform/dist`, `TZ=Europe/Berlin`.
Die App läuft mit schreibgeschütztem Dateisystem, ohne Linux-Capabilities, `no-new-privileges`, 512 MB.

## Backup und Wiederherstellung

Das zentrale Backup erkennt den Container am Label `de.appzentrale24.backup: postgres` und sichert per
`pg_dumpall -U "$POSTGRES_USER"` (enthält auch die Rollen; das Passwort von `app_api` ist darin als
SCRAM-Hash enthalten). Der `TOTP_ENCRYPTION_KEY` gehört **nicht** in dasselbe Backup. Diese Einrichtung wird
hier nicht verändert.

Zusätzlich (prüfbar, verschlüsselt, mit Wiederherstellungsprobe):

| Skript | Zweck |
|---|---|
| `deploy/backup.sh --compose deploy/.env` | `pg_dump` (Custom-Format) + Rollen ohne Passwörter + Manifest, mit GPG verschlüsselt (öffentlicher Schlüssel `BACKUP_GPG_RECIPIENT` oder `BACKUP_PASSPHRASE_FILE`), SHA-256-Prüfsumme, optional Übergabe an restic (`BACKUP_HOOK`) |
| `deploy/restore-test.sh --docker --migrations db/migrations <archiv>` | spielt das Archiv in einen Wegwerf-Container ohne Netz ein und prüft Zeilenzahlen, Migrationsstand und RLS; die laufende Umgebung bleibt unberührt |

Einrichtung, Zeitplan, restic-Übergabe und die Notfall-Wiederherstellung Schritt für Schritt:
[`docs/betrieb.md`](../docs/betrieb.md), Abschnitt 5.1.

## Testumgebung `stunden-test.appzentrale24.de` aktualisieren (Server-Sitzung)

**Kurzform (ein Befehl):** `deploy/update-test.sh release/1.0 [--seed-test-env]` führt die Schritte unten aus
(Sicherung, Stand holen, Bauen mit `APP_COMMIT`, Migrationen, Neustart, Healthcheck, optional Testzugänge). Es bricht
ab, wenn `deploy/.env` nicht `STAGE=test` enthält oder das Arbeitsverzeichnis lokale Änderungen hat.

Nur die Container `stunden-test-*` werden angefasst; andere Dienste, der zentrale Caddy und das zentrale Backup
bleiben unverändert. Ausschließlich erfundene Testfirmen, keine echten Mitarbeiterdaten.

```bash
cd /srv/stunden-test
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"   # STAGE=test in deploy/.env
git fetch origin && git checkout <freigegebener Branch oder Tag> && git pull --ff-only
$C config --quiet                     # Pflichtwerte gesetzt?
BACKUP_PASSPHRASE_FILE=/root/.stunden-test-backup-pass deploy/backup.sh --compose deploy/.env   # vorher sichern
$C build                              # neues Image stunden-app:local (enthält db/migrations bis 0016)
$C run --rm migrate                   # nur neue Migrationen (z. B. 0015, 0016); bricht bei veränderten Dateien ab
$C up -d app                          # ersetzt nur stunden-test-app
docker inspect -f '{{.State.Health.Status}}' stunden-test-app            # → healthy (nach bis zu ~1 min)
```

**Testzugänge anlegen** (einmalig je Testdatenbank; verweigert, sobald ein Mandant ohne Test-Kennzeichen
existiert oder die Testfirmen schon angelegt sind):

```bash
$C run --rm migrate node --experimental-strip-types --disable-warning=ExperimentalWarning \
  --import ./server/register.mjs server/src/cli.ts seed-test-env --confirm-test-environment \
  --domain=stunden-test.example [--admin-email=<Adresse des Testers>]
```

Angelegt werden: „Testfirma Gratis (Test)“ (`pilot_free`, kostenlos) und „Testfirma Zahlend (Test)“
(`standard`, Standardpreis je abrechenbarem Mitarbeiter), je Inhaber, Leitung und drei Mitarbeitende
(`inhaber.gratis@…`, `leitung.gratis@…`, `mitarbeiter1.gratis@…` usw.), sowie ein Super-Admin. Die **zufälligen
Passwörter erscheinen nur in dieser Konsolenausgabe** – sofort in einen Passwort-Manager übernehmen; sie werden
nirgends gespeichert. Der Super-Admin muss bei der ersten Anmeldung die Zwei-Faktor-Anmeldung einrichten
(Pflicht für Plattformkonten). Neues Passwort für ein Testkonto: `cli.ts set-password <email>` (Abschnitt
„Betrieb“ in `server/README.md`). Adressen unter `.example` empfangen keine E-Mails – Einladungen daher per
Link (`cli.ts invite-link …`) oder eine eigene Testadresse über `--admin-email` verwenden.

Die Demo-Daten aus `db/seed.sql` (`MIGRATE_SEED=1`) sind eine Alternative für reine Vorführungen; beide zusammen
sind möglich.

## Was hier nicht geprüft wurde

Das Image wurde in der Entwicklungsumgebung **nicht** gebaut (kein Docker-Daemon). Geprüft wurden
`docker compose config`, die einzelnen Build-Schritte ohne Docker (Frontend-Build nur mit `platform/`,
Laufzeit nur mit Produktionsabhängigkeiten, als Nicht-root-Benutzer) und der Migrationsjob gegen PostgreSQL 16
(`tests/server/migrate.test.ts`). Den Image-Bau und einen Start mit Healthcheck prüft der CI-Job
„Container-Image (Bau + Start)“; derselbe Job legt die Testzugänge an, sichert mit `backup.sh --compose` und
führt die Wiederherstellungsprobe mit `restore-test.sh --docker` aus. `backup.sh --url` und
`restore-test.sh --local/--server-url` laufen zusätzlich in `tests/server/backup-restore.test.ts`.
