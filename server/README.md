# AppZentrale24 – Servereinrichtung (netcup RS 2000, Debian 13)

Ein gemeinsamer Server für drei Anwendungen: BEGIVO, Stunden-App und KI-Telefonie.
Die Anleitung ist so geschrieben, dass sie ohne Linux-Vorkenntnisse Schritt für Schritt funktioniert.
Jeder Schritt, der etwas verändert, fragt vorher nach.

## Architektur

```
Internet ──► Firewall (ufw: nur 22, 80, 443)
              │
              ▼
        Caddy (Reverse Proxy, HTTPS automatisch)   ← einziger Container mit offenen Ports
         │            │              │              │
   begivo.…      stunden.…      telefon.…      status.…
   BEGIVO-App    Stunden-API    Telefonie-API   Uptime Kuma
   + eigene DB   + eigene DB    + eigene DB
                                + Redis
```

- **Getrennte Umgebungen:** Jede Anwendung liegt in `/srv/appzentrale24/<app>` mit eigener `docker-compose.yml`,
  eigener `.env` (Geheimnisse, `chmod 600`), eigenem internen Netz und **eigener PostgreSQL-Datenbank**.
  Die Anwendungen sehen sich gegenseitig nicht. Nur der Proxy erreicht sie über das Netz `proxy`.
- **Keine Ports der Apps nach außen:** Docker umgeht ufw bei veröffentlichten Ports. Deshalb veröffentlicht nur Caddy
  Ports, alle Datenbanken sind von außen unerreichbar.
- **Benutzer:** Die Anmeldung erfolgt nur als `appadmin` mit SSH-Schlüssel. Der root-Login ist gesperrt, Passwort-Login ist aus.
  Eine Notfallkonsole gibt es im netcup SCP (VNC).
- **Updates:** Sicherheitsupdates laufen täglich automatisch, ein Neustart erfolgt bei Bedarf um 04:30 Uhr. Docker-Images aktualisiere ich
  bewusst per Pull Request (feste Versionen, kein `latest`).
- **Backup:** Die Sicherung läuft jede Nacht um 02:15 Uhr mit restic (AES-256). Sie umfasst Datenbank-Dumps, Uploads und Konfiguration und geht
  **auf einen externen Speicher**. Den Wiederherstellungstest führen Sie monatlich mit `restore-test.sh` durch.
- **Monitoring:** Uptime Kuma überwacht alle Adressen und Zertifikate und benachrichtigt per E-Mail oder App. Die KI-Telefonie
  hat zusätzlich eine eigene Betriebsüberwachung.

## Ablauf

| Schritt | Wo | Was | Ändert etwas? |
|---|---|---|---|
| 0 | Windows-PC | `00-pruefen-windows.ps1`: DNS-Bericht und SSH-Test | nein |
| 1 | Server | `01-bestandsaufnahme.sh` | nein |
| 2 | Server | `02-grundschutz.sh`: Updates, Firewall, fail2ban, SSH-Härtung | ja, fragt nach |
| 3 | Server | `03-docker.sh`: Docker, Verzeichnisse | ja |
| 4 | netcup CCP | DNS-Einträge nach `DNS-PLAN.md` | **nur nach Freigabe** |
| 5 | Server | Proxy und Monitoring starten | ja |
| 6 | Server | Backup einrichten (externer Speicher nötig) | ja |
| 7 | Server | Anwendungen einzeln deployen | je App nach Freigabe |

### Schritt 0 – auf dem Windows-PC

PowerShell öffnen und Folgendes ausführen:

```powershell
cd $env:USERPROFILE\Downloads
Invoke-WebRequest https://raw.githubusercontent.com/A-2026amore/UWE-Stunden-App/claude/stoic-johnson-3jt324/server/00-pruefen-windows.ps1 -OutFile 00-pruefen-windows.ps1
powershell -ExecutionPolicy Bypass -File .\00-pruefen-windows.ps1
```

Danach den Inhalt von `dns-bericht.txt` in den Chat kopieren.

### Schritt 1 bis 3 – auf dem Server

```powershell
ssh -i $env:USERPROFILE\.ssh\appzentrale24_ed25519 appadmin@159.195.199.222
```

```bash
sudo apt-get update && sudo apt-get -y install git
git clone -b claude/stoic-johnson-3jt324 https://github.com/A-2026amore/UWE-Stunden-App.git ~/kit
cd ~/kit/server
sudo bash 01-bestandsaufnahme.sh | tee ~/bestandsaufnahme.txt   # Ausgabe in den Chat kopieren
sudo bash 02-grundschutz.sh      # danach in ZWEITEM Fenster SSH testen!
sudo bash 03-docker.sh
exit                             # neu anmelden, damit Docker-Rechte gelten
```

### Schritt 5 – Proxy und Monitoring

```bash
cp -r ~/kit/server/proxy/. /srv/appzentrale24/proxy/
cp -r ~/kit/server/monitoring/. /srv/appzentrale24/monitoring/
cd /srv/appzentrale24/proxy
cp .env.example .env && chmod 600 .env
docker run --rm caddy:2.10-alpine caddy hash-password --plaintext 'SICHERES-PASSWORT'   # Ergebnis in .env bei INTERN_HASH, jedes $ als $$
nano .env
docker compose run --rm caddy caddy validate --config /etc/caddy/Caddyfile
docker compose up -d
cd ../monitoring && docker compose up -d
```

Uptime Kuma: `https://status.appzentrale24.de` öffnen, Administrator anlegen und Monitore für alle Subdomains hinzufügen.

### Schritt 6 – Backup

Nötig ist ein externer Speicher, zum Beispiel netcup Storage Space oder eine Storage Box. Er ist kostenpflichtig, deshalb entscheiden Sie darüber.

```bash
sudo install -d -m 700 /etc/appzentrale24
sudo cp ~/kit/server/backup/backup.env.example /etc/appzentrale24/backup.env
sudo chmod 600 /etc/appzentrale24/backup.env && sudo nano /etc/appzentrale24/backup.env
sudo cp ~/kit/server/backup/*.sh /srv/appzentrale24/backup/
sudo cp ~/kit/server/backup/appzentrale24-backup.{service,timer} /etc/systemd/system/
sudo bash -c 'set -a; . /etc/appzentrale24/backup.env; restic init'
sudo systemctl daemon-reload && sudo systemctl enable --now appzentrale24-backup.timer
sudo systemctl start appzentrale24-backup.service && sudo journalctl -u appzentrale24-backup -n 30
```

## Wichtig

- Private Schlüssel, Passwörter und `.env`-Inhalte **nie** in den Chat oder ins Repository.
- Das restic-Passwort zusätzlich offline aufbewahren. Ohne es sind die Sicherungen unbrauchbar.
- Keine Anwendung wird ohne Ihre ausdrückliche Freigabe ohne Passwortschutz veröffentlicht.
