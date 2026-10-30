# Betrieb ohne GitHub

Stand: 30.10.2026 · gilt für die Testumgebung `stunden-test.appzentrale24.de` und später genauso für die Produktion.

## 1. Kurzfassung

- **Der Server holt nichts mehr von GitHub.** Neue Versionen kommen als **signiertes Release-Paket** (eine Datei
  plus Signatur) auf den Server. Der Server nimmt nur Pakete an, die mit Arifs Schlüssel signiert sind, und stellt
  danach – wie bisher – nur den ausdrücklich freigegebenen Commit bereit.
- **Tests laufen ohne GitHub Actions** in einem Wegwerf-Container (`deploy/pruefen.sh`), auf dem Server oder auf
  jedem Rechner mit Docker. Die Online-Prüfung der Testumgebung läuft ebenfalls ohne GitHub (`deploy/test-env-check.sh`).
- **Sicherungen** gehen weiter verschlüsselt auf die Hetzner Storage Box (restic, unverändert). Jedes angenommene
  Paket wird zusätzlich dort abgelegt.
- **Ehrliche Grenze:** Claude entwickelt technisch in einem GitHub-Repository – andere Quellen kann Claude Code in
  der Cloud nicht bearbeiten. GitHub bleibt deshalb **nur Arbeitsplatz für die Entwicklung**. Fällt GitHub aus oder
  wird gesperrt, läuft der Betrieb weiter; nur neue Änderungen durch Claude warten dann.

## 2. Was heute noch an GitHub hängt

| Stelle | Heute | Danach |
|---|---|---|
| Einrichtung des Servers | `curl` von `raw.githubusercontent.com` | Skript per `scp` vom eigenen PC, Prüfsumme vergleichen |
| Code auf dem Server | `git fetch` von `github.com` (Timer, `stunden-test-freigeben`) | eigenes Repository `/srv/git/UWE-Stunden-App.git` auf dem Server, gefüllt nur aus signierten Paketen |
| Freigabe | `stunden-test-freigeben <commit>` | unverändert – zusätzlich muss der Commit aus einem geprüften Paket stammen |
| Automatische Tests (CI) | GitHub Actions | `deploy/pruefen.sh <commit>` |
| Prüfung der Testumgebung | Workflow „Testumgebung prüfen“ | `deploy/test-env-check.sh <commit>` |
| Alt-App UWE (Produktion) | GitHub Pages `a-2026amore.github.io` | **bleibt vorerst**, siehe Abschnitt 6 |

## 3. Ablauf einer neuen Version

1. **Claude** entwickelt und testet wie bisher, baut am Ende mit `deploy/release-paket.sh <commit>` das Paket
   `stundenwerk-<commit12>.bundle` (+ `.sha256`) und legt es in Arifs Ordner `C:\Users\User\appzentrale24\pakete\`.
   Im Chat nennt Claude Commit und SHA-256-Prüfsumme.
2. **Arif** startet auf dem PC `deploy/windows/paket-hochladen.ps1 -Paket <datei>`: vergleicht die Prüfsumme,
   signiert mit seinem Schlüssel (Passphrase), lädt per `scp` hoch und gibt auf dem Server frei.
3. **Server** (`stunden-test-paket … --freigeben`): prüft Signatur, Prüfsumme und dass das Paket genau einen Commit
   enthält, übernimmt ihn ins eigene Repository, legt eine Kopie auf die Storage Box und setzt die Freigabe. Der Timer
   baut, migriert, startet neu, prüft Gesundheit, sichert und macht die Wiederherstellungsprobe (wie bisher).
4. Optional danach: `deploy/test-env-check.sh <commit>` (HTTPS, Header, Schnittstellen, Anmeldeseiten).

Server-Zugang: Benutzer `appadmin` mit dem vorhandenen Schlüssel `appzentrale24_ed25519` (kein root-Login per SSH),
Server-Befehle über `sudo` (fragt das appadmin-Passwort). Ohne das Skript geht Schritt 2 auch von Hand (PowerShell,
im Ordner des Pakets; Passphrasen von Hand tippen – Einfügen per Rechtsklick war bei der Einrichtung unzuverlässig):

```powershell
$K = "$env:USERPROFILE\.ssh\appzentrale24_ed25519"
ssh-keygen -Y sign -f "$env:USERPROFILE\.ssh\stundenwerk_paket" -n stundenwerk-paket <datei>
scp -i $K <datei> <datei>.sig <datei>.sha256 appadmin@159.195.199.222:
ssh -t -i $K appadmin@159.195.199.222 "sudo stunden-test-paket ~/<datei> --freigeben"
```

**Warum signieren, wenn doch per SSH hochgeladen wird?** Die SSH-Anmeldung schützt den Weg. Die Signatur legt
zusätzlich fest, *wer* eine Version liefern darf – auch wenn ein Paket später über die Storage Box oder einen
anderen Weg kommt. Ohne Arifs privaten Schlüssel nimmt der Server nichts an, auch nicht von Claude.

## 4. Einmalige Umstellung (ca. 15 Minuten)

Durchgeführt am 30.10.2026 (Testserver). Auf dem **PC** (PowerShell):

```powershell
ssh -V                                     # OpenSSH mindestens 8.1 (Arifs PC: 9.5)
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\stundenwerk_paket" -C stundenwerk-paket   # Passphrase von Hand tippen
(Get-FileHash C:\Users\User\appzentrale24\pakete\umstellen-ohne-github.sh).Hash          # mit dem Chat vergleichen
$K = "$env:USERPROFILE\.ssh\appzentrale24_ed25519"
scp -i $K "$env:USERPROFILE\.ssh\stundenwerk_paket.pub" C:\Users\User\appzentrale24\pakete\umstellen-ohne-github.sh appadmin@159.195.199.222:
ssh -i $K appadmin@159.195.199.222 "sha256sum umstellen-ohne-github.sh"                   # gleiche Prüfsumme
ssh -t -i $K appadmin@159.195.199.222 "sudo bash ~/umstellen-ohne-github.sh ~/stundenwerk_paket.pub"
ssh -t -i $K appadmin@159.195.199.222 "sudo stunden-test-freigeben --status"             # Quelle: /srv/git/UWE-Stunden-App.git
```

Der private Schlüssel `stundenwerk_paket` (ohne `.pub`) bleibt auf dem PC und gehört zusätzlich in KeePassXC.
Neuer Signier-Schlüssel (z. B. verloren): neu anlegen und das Umstellungs-Skript mit der neuen `.pub` erneut
ausführen – es ist wiederholbar und ersetzt den eingetragenen Schlüssel.

Das Skript (`deploy/umstellen-ohne-github.sh`) übernimmt nur den gerade freigegebenen Commit in das eigene
Repository, stellt den Checkout darauf um, trägt den Schlüssel ein und installiert `stunden-test-paket` sowie eine
neue `stunden-test-freigeben`. Container werden **nicht** neu gestartet; die laufende App bleibt unberührt.
**Rückweg:** `sudo bash ~/umstellen-ohne-github.sh --zurueck` (Quelle wieder GitHub, alte `stunden-test-freigeben`).

## 5. Tests ohne GitHub Actions

```bash
cd /srv/stunden-test
deploy/pruefen.sh <commit>          # Lint, Typecheck, Unit, Build, Datenbank/RLS + Server (ca. 5–10 min)
deploy/pruefen.sh <commit> --voll   # zusätzlich Browsertests (Chromium, Android, iPhone-WebKit) und Gesamttest
```

Der Code des Commits wird per `git archive` in einen Wegwerf-Container gestreamt (Playwright-Image, PostgreSQL 16
darin). Der Container bekommt höchstens 2 CPUs / 4 GB RAM, keine Ports, keine Server-Verzeichnisse, keine
Geheimnisse. Protokoll: `/var/lib/stunden-test/pruefung-<commit12>.log`. Abweichung zu GitHub Actions: Der
Prüfcontainer nutzt die Node-Version des Playwright-Images; das App-Image selbst läuft mit Node 22 und wird bei jeder
Bereitstellung gebaut und auf Gesundheit geprüft. Nicht enthalten: Geheimnis-Scan (gitleaks) und CodeQL.

Bis zur Umstellung können die GitHub-Workflows weiterlaufen; sie schaden nicht, der Server hängt nur nicht mehr
davon ab.

## 6. Was danach noch von außen kommt (ehrlich)

- **Docker Hub** (Basis-Images `node`, `postgres`, per Digest festgenagelt), **npm-Registry** (gehört ebenfalls zu
  GitHub/Microsoft), **Ubuntu-Paketquellen** und **mcr.microsoft.com** (Prüf-Image). Diese werden beim Bauen bzw.
  Prüfen geladen. **Stufe 2 (möglich, noch nicht gebaut):** Das fertige App-Image wird mit ins Paket gelegt
  (`docker save`, signiert); dann braucht der Server beim Ausrollen gar keine fremde Quelle mehr. Nachteil: Paket
  ca. 150–250 MB statt < 1 MB.
- **Alt-App UWE auf GitHub Pages:** Die Mitarbeitenden speichern ihre Stunden im Browser **unter der Adresse
  `a-2026amore.github.io`**. Ein Umzug auf eine eigene Adresse würde diese Daten auf den Geräten nicht mitnehmen.
  Empfehlung: Alt-App bis zum Wechsel auf Stundenwerk dort lassen und danach abschalten – nicht vorher umziehen.
- **Claude-Entwicklung** bleibt im GitHub-Repository (siehe 1). Empfehlung: Repository auf **privat** stellen,
  sobald die Alt-App nicht mehr über GitHub Pages läuft (Pages für private Repositories ist kostenpflichtig).

## 7. Offene Punkte

- Der Server läuft bei netcup; die Storage Box ist bei Hetzner. Ein Umzug des Servers zu Hetzner ändert an diesem
  Verfahren nichts (gleiche Skripte), wäre aber ein eigener Schritt.
- Einrichtung und Probe-Paket am 30.10.2026 auf dem Testserver erfolgreich (Paket 6990943 geprüft und übernommen,
  nicht ausgerollt). `deploy/windows/paket-hochladen.ps1` selbst ist noch nicht auf Windows gelaufen.
- Storage Box: einmalig `sudo bash storagebox-einrichten.sh u704070-sub1 u704070.your-storagebox.de`
  (`deploy/storagebox-einrichten.sh`; Sub-Account „AppZentrale24 Backup“, Repository `stundenwerk-test` in dessen
  Verzeichnis). Danach gehen Sicherungen und Paket-Kopien per restic auf die Box. Die Passwortdateien
  `/root/.stunden-test-restic-pass` und `/root/.stunden-test-backup-pass` gehören zusätzlich in KeePassXC.
  Sicherungen entstehen bisher nur bei jeder Bereitstellung, nicht täglich.
- `deploy/test-env-check.sh` konnte aus der Entwicklungsumgebung nicht gegen die echte Adresse laufen (Netzsperre).
