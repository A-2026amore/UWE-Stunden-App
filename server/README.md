# Node-API (eigener Server)

Kleine HTTP-API vor PostgreSQL 16 – ohne Framework, nur Node-Bordmittel (`node:http`,
`node:crypto`) und `pg`. Die Sicherheitsgrenze ist die Datenbank (Row Level Security,
siehe `docs/database.md`, `docs/security.md`); die API prüft Sitzung, Eingaben, Pausenregeln
und schützt vor CSRF/Brute Force.

```
Browser ──HTTPS──▶ Caddy ──▶ Node-API (127.0.0.1:3000) ──▶ PostgreSQL (lokal, Rolle app_api)
                                   │ je Anfrage: begin; set local role app_user;
                                   │ set_config('request.jwt.claims', '{"sub":"<geprüfte user-id>"}', true)
```

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/main.ts` | Startpunkt (HTTP-Server, sauberes Beenden bei SIGTERM) |
| `src/config.ts` | Konfiguration ausschließlich aus Umgebungsvariablen |
| `src/db.ts` | Pool (`app_api`), Transaktion je Anfrage mit `set local role` |
| `src/http.ts` | Routing, JSON-Bodys mit Größenlimit, Cookies, Sicherheitsheader, CORS, CSRF |
| `src/app.ts` | Anmeldung, Sitzungen, Passwort-Reset, Einladungen, Rate-Limits |
| `src/routes.ts` | Fach-Endpunkte für alle Repository-Methoden, Pausenprüfung mit `platform/src/core` |
| `src/auth.ts` | scrypt-Passwörter, Sitzungs-Token (nur SHA-256-Hash in der DB) |
| `src/twoFactor.ts` | Zwei-Faktor-Anmeldung (TOTP): Verschlüsselung des Geheimnisses, Code-Prüfung mit Replay-Schutz, Wiederherstellungscodes, zweiter Anmeldeschritt |
| `src/static.ts` | Optional: Auslieferung von `platform/dist` (`STATIC_DIR`) mit eigener CSP |
| `src/mailer.ts` | E-Mail (minimaler SMTP-Client; ohne SMTP: Ausgabe ins Log nur in Entwicklung) |
| `src/cli.ts` | Betriebsbefehl `set-password` |
| `src/migrate.ts` | Migrationsjob: `db/migrations` als Eigentümer einspielen (Versionstabelle `ops.schema_migrations` mit Prüfsumme), Passwort für `app_api` setzen (`deploy/README.md`) |
| `register.mjs`, `resolve-ts.mjs` | Lädt TypeScript direkt (Node-Typ-Entfernung) inkl. `platform/src/core` |

Es gibt **keinen Build-Schritt**: Node ≥ 22.6 führt die `.ts`-Dateien direkt aus
(Typen werden entfernt; ab Node 22.18 ohne Flag). Typprüfung: `npx tsc -p server/tsconfig.json`.

## Lokal starten

Voraussetzungen: Node 22 (≥ 22.6), PostgreSQL 16, `npm ci` im Repository.

```bash
# 1. Datenbank anlegen und Schema einspielen (als Superuser)
createdb uwe_zeit
for f in db/migrations/*.sql; do psql -d uwe_zeit -v ON_ERROR_STOP=1 -f "$f"; done
psql -d uwe_zeit -v ON_ERROR_STOP=1 -f db/seed.sql           # nur Demo/Entwicklung!
psql -d uwe_zeit -c "alter role app_api login password 'lokales-dev-passwort'"

# 2. Demo-Passwort setzen (über die regulären Reset-Funktionen; Passwort per stdin)
export DATABASE_URL='postgres://app_api:lokales-dev-passwort@127.0.0.1:5432/uwe_zeit'
echo 'Demo-Passwort-123' | node --experimental-strip-types --import ./server/register.mjs server/src/cli.ts set-password inhaber@demo-krankentransporte.example

# 3. API starten (Standard: 127.0.0.1:3000, Herkunft http://localhost:5173)
node --experimental-strip-types --disable-warning=ExperimentalWarning \
     --import ./server/register.mjs server/src/main.ts
```

Ohne SMTP stehen Passwort-Reset- und Einladungs-E-Mails (mit Link) im Log – **nur** wenn
`NODE_ENV` nicht `production` ist. In Produktion ohne SMTP wird nur eine Warnung ohne Inhalt geloggt.

## Umgebungsvariablen

| Variable | Pflicht | Standard | Bedeutung |
|---|---|---|---|
| `DATABASE_URL` | ja | – | Verbindung als **`app_api`** (nie als Superuser). Sonderzeichen im Passwort URL-kodieren. |
| `PUBLIC_ORIGIN` | in Produktion | `http://localhost:5173` | Erlaubte Browser-Herkunft(en), kommagetrennt; die erste wird für Links in E-Mails verwendet. In Produktion nur `https://`. |
| `NODE_ENV` | – | – | `production` aktiviert Secure-Cookies, HSTS und verbietet Log-Ausgabe von E-Mails. |
| `HOST` / `PORT` | – | `127.0.0.1` / `3000` | Nur lokal lauschen; nach außen geht es über Caddy. |
| `TRUST_PROXY` | – | aus | `1` = Client-IP aus `X-Forwarded-For` (letzter Eintrag) – nur hinter dem eigenen Proxy setzen. |
| `TRUST_PROXY_CIDRS` | – | leer | Netze (CIDR oder einzelne IPs, kommagetrennt), aus denen `X-Forwarded-For` ausgewertet wird, z. B. das Docker-Netz des Proxys. Leer = jeder Absender (bisheriges Verhalten). Ungültige Einträge verhindern den Start. |
| `SESSION_TTL_HOURS` | – | `12` | Absolute Sitzungsdauer. |
| `SESSION_IDLE_MINUTES` | – | `120` | Sitzung endet nach so langer Inaktivität. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | – | – | Mailversand. `SMTP_TLS`: `implicit` (465), `starttls` (587, Standard), `none` (nur lokal/Test, in Produktion verboten). |
| `RESET_LINK_PATH` / `INVITE_LINK_PATH` | – | `/passwort-neu` / `/einladung` | Pfade der Frontend-Seiten; das Token hängt als `#token=…` (Fragment, landet in keinem Server-Log). |
| `STATIC_DIR` | – | aus | Verzeichnis des API-Builds (`VITE_DATA_MODE=api npm run build` → `platform/dist`). Gesetzt: alles außer `/api/…` wird als Datei daraus ausgeliefert (nur GET/HEAD, strenge CSP, siehe `docs/betrieb.md` Abschnitt 7). Fehlt das Verzeichnis, startet die API nicht. |
| `RATE_LIMIT_WINDOW_MINUTES` | – | `15` | Zeitfenster der Rate-Limits. |
| `RATE_LIMIT_LOGIN_PER_ACCOUNT` | – | `5` | Fehlversuche je IP + E-Mail. |
| `RATE_LIMIT_LOGIN_PER_IP` | – | `100` | Anmeldeversuche je IP. |
| `RATE_LIMIT_RESET_PER_ACCOUNT` | – | `3` | Reset-Anfragen je IP + E-Mail. |
| `RATE_LIMIT_TOKEN_PER_IP` | – | `20` | Einlösen von Reset-/Einladungs-Links je IP. |
| `RATE_LIMIT_2FA_PER_ACCOUNT` / `RATE_LIMIT_2FA_PER_IP` | – | `5` / `50` | Falsche Zwei-Faktor-Codes je Konto bzw. IP. |
| `TOTP_ENCRYPTION_KEY` | in Produktion | Entwicklungsschlüssel | 32 Byte (Base64 oder 64 Hex), verschlüsselt die TOTP-Geheimnisse. Erzeugen: `openssl rand -base64 32`. Getrennt von DB-Backups sichern; Rotation: `docs/betrieb.md` Abschnitt 6.1. |
| `TOTP_ENCRYPTION_KEY_PREVIOUS` | – | leer | Frühere Schlüssel (kommagetrennt), nur zum Entschlüsseln während einer Rotation. |
| `TOTP_ISSUER` | – | `Stundenwerk` | Anzeigename in der Authenticator-App. |

Ein `SESSION_SECRET` wird nicht benötigt: Sitzungs-Token sind 32 zufällige Bytes, die Datenbank
speichert nur ihren SHA-256-Hash.

## Sicherheit (Kurzüberblick)

- **Anmeldung:** scrypt (N=32768, r=8, p=1, 16 Byte Salt), Vergleich mit `timingSafeEqual`; unbekannte
  Konten durchlaufen denselben Rechenaufwand; immer dieselbe Fehlermeldung.
- **Cookie:** `__Host-sid` (bei HTTPS), `HttpOnly; Secure; SameSite=Strict; Path=/`, Ablauf + Leerlauf-Timeout.
- **CSRF:** SameSite=Strict, zusätzlich bei POST/PUT/PATCH/DELETE Pflicht `Content-Type: application/json`
  und `Origin` aus `PUBLIC_ORIGIN` (Clients ohne Browser müssen `Origin` mitsenden).
- **Rate-Limits:** im Speicher des Prozesses → gelten **nur für eine Instanz**. Bei mehreren
  Instanzen ist ein gemeinsamer Speicher (z. B. Tabelle in PostgreSQL) nötig.
- **Header:** CSP `default-src 'none'; frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Cache-Control: no-store`, HSTS bei HTTPS.
- **Logo-Upload:** nur PNG/JPEG/WebP als Data-URL bis 300 KB, Inhalt per Dateisignatur geprüft;
  **SVG wird abgelehnt** (kann Skripte enthalten), außerdem https-URLs und relative Pfade.
- **Logs:** JSON-Zeilen mit Methode, Pfad, Status, Dauer – nie Bodys, Cookies, Query-Strings,
  Passwörter oder Tokens.

## Tests

```bash
npx vitest run --project db --no-file-parallelism tests/server
```

`static.test.ts` prüft `STATIC_DIR` (CSP, Cache-Header, Weiterleitung `/passwort-neu` → `/passwort-neu/`,
keine versteckten Dateien/Traversal/Symlinks, `/api` bleibt API) und dass Einladungsantworten nur
`invitation: {expiresAt, delivery}` enthalten, nie Token oder Link.

Startet einen Wegwerf-PostgreSQL (oder nutzt `DATABASE_URL` als Superuser), spielt Migrationen +
Seed ein, setzt Demo-Passwörter über die Auth-Funktionen und prüft die API über echtes HTTP
(u. a. Mandantentrennung für jede Ressource, Rollen, CSRF, Rate-Limit, Reset ohne Kontenaufzählung,
Pausenregeln, Versionskonflikte). `process.test.ts` startet den Server zusätzlich genau wie oben
beschrieben als eigenen Prozess.

## Betrieb auf dem Hetzner-Server (Beispiel, ohne Geheimnisse)

Annahmen: Ubuntu LTS, Repository unter `/srv/uwe-zeit`, Systembenutzer `uwe-api`,
PostgreSQL 16 lauscht nur auf `127.0.0.1`, Domain `zeit.example.de` (Platzhalter).

```bash
sudo adduser --system --group --home /srv/uwe-zeit uwe-api
cd /srv/uwe-zeit && sudo -u uwe-api npm ci   # Build-Werkzeuge nötig; zur Laufzeit reicht `npm ci --omit=dev` (nur pg)
sudo -u uwe-api env VITE_DATA_MODE=api npm run build   # Frontend (API-Modus) nach platform/dist
```

**Datenbank:** Migrationen als Superuser einspielen (siehe oben, **ohne** `db/seed.sql`), dann
`alter role app_api login password '…'` (Passwort aus dem Passwortmanager). In `pg_hba.conf`:
`host uwe_zeit app_api 127.0.0.1/32 scram-sha-256`. Ersten Super-Admin anlegen:

```sql
insert into auth.users (email) values ('admin@firma.example') returning id;
insert into public.platform_admins (user_id, role) values ('<id von oben>', 'super_admin');
```

danach Passwort mit `server/src/cli.ts set-password admin@firma.example` setzen.

**Umgebungsdatei** `/etc/uwe-zeit/api.env` (Eigentümer root, Gruppe uwe-api, Rechte `640` bzw. `600`):

```ini
NODE_ENV=production
DATABASE_URL=postgres://app_api:<PASSWORT>@127.0.0.1:5432/uwe_zeit
PUBLIC_ORIGIN=https://zeit.example.de
TRUST_PROXY=1
PORT=3000
SMTP_HOST=<smtp-server>
SMTP_PORT=587
SMTP_TLS=starttls
SMTP_USER=<benutzer>
SMTP_PASSWORD=<passwort>
SMTP_FROM=noreply@zeit.example.de
```

**systemd** `/etc/systemd/system/uwe-zeit-api.service`:

```ini
[Unit]
Description=UWE Zeiterfassung API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=uwe-api
Group=uwe-api
WorkingDirectory=/srv/uwe-zeit
EnvironmentFile=/etc/uwe-zeit/api.env
ExecStart=/usr/bin/node --experimental-strip-types --disable-warning=ExperimentalWarning --import ./server/register.mjs server/src/main.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload && sudo systemctl enable --now uwe-zeit-api` · Logs: `journalctl -u uwe-zeit-api`.

**Caddy** – empfohlen mit `STATIC_DIR=/srv/uwe-zeit/platform/dist` in der Umgebungsdatei: dann reicht
`reverse_proxy 127.0.0.1:3000` für alles (Header und CSP setzt die API, siehe `docs/betrieb.md` Abschnitt 7.2).
Alternative ohne `STATIC_DIR` – Caddy liefert die Dateien selbst aus und muss dann auch die CSP setzen
(`/etc/caddy/Caddyfile`, TLS-Zertifikat automatisch über Let's Encrypt):

```caddy
zeit.example.de {
	encode zstd gzip
	handle /api/* {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		root * /srv/uwe-zeit/platform/dist
		try_files {path} {path}/index.html /index.html
		file_server
	}
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		X-Frame-Options "DENY"
		Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
		-Server
	}
}
```

Frontend und API liegen so unter **derselben Herkunft** – CORS wird nicht gebraucht, das
Cookie bleibt `SameSite=Strict`. Firewall: nur 22 und 443 (80 für die ACME-Weiterleitung).

**Backups (Hinweis):** täglich `pg_dump -Fc uwe_zeit`, verschlüsselt (z. B. `age`/`gpg`) in einen
getrennten EU-Speicher (z. B. Hetzner Storage Box); zusätzlich WAL-Archivierung für
Point-in-Time-Recovery. Wiederherstellung regelmäßig testen (siehe `docs/betrieb.md`).
Umgebungsdatei und Passwörter gehören in den Passwortmanager, nicht ins Backup-Archiv im Klartext.
