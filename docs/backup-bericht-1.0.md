# Backup-Bericht Stundenwerk 1.0 (Stand 29.10.2026)

Kurz: Sicherung und Wiederherstellung der Stundenwerk-Datenbank sind gebaut und automatisch getestet, aber **nicht mit
einem echten Archiv aus der Hetzner Storage Box**. Diese Entwicklungsumgebung erreicht weder den netcup-Server noch die
Storage Box (Netzwerkregel, SSH gesperrt). Der Test auf dem Server steht noch aus.

## Was tatsächlich getestet wurde

| Prüfung | Wo | Ergebnis |
|---|---|---|
| `deploy/backup.sh --url`: Datenbank mit Demodaten sichern, mit GPG verschlüsseln (Passwortdatei und öffentlicher Schlüssel), SHA-256-Prüfsumme, keine unverschlüsselten Daten auf der Platte | `tests/server/backup-restore.test.ts`, lokal und in der CI | bestanden |
| `deploy/restore-test.sh`: Archiv in eine leere Wegwerf-Datenbank einspielen, Zeilenzahlen, Migrationsstand und Mandantentrennung (RLS) prüfen | derselbe Test | bestanden |
| Manipuliertes Archiv, falsches Passwort, Sicherung ohne Verschlüsselung | derselbe Test | werden abgelehnt (bestanden) |
| Image bauen, starten, Testzugänge anlegen, `backup.sh --compose`, `restore-test.sh --docker` | CI-Job „Container-Image (Bau + Start)“ auf GitHub | bestanden (letzter Lauf auf `release/1.0`) |

Alle Tests arbeiten nur mit erfundenen Daten.

## Was nicht getestet wurde

1. Sicherung auf dem netcup-Server mit der dortigen `deploy/.env`.
2. Übertragung zur Hetzner Storage Box (restic über `BACKUP_HOOK`) und Abruf eines Archivs von dort.
3. Wiederherstellung eines echten Archivs aus der Storage Box.
4. Das bereits vorhandene zentrale Server-Backup (Label `de.appzentrale24.backup: postgres`). Es wurde bewusst nicht
   verändert.

## So wird der echte Test auf dem Server gemacht (ca. 10 Minuten)

Nur die Testumgebung `stunden-test` ist betroffen. Produktive Dienste und das zentrale Backup bleiben unverändert.

```bash
cd /srv/stunden-test
BACKUP_PASSPHRASE_FILE=/root/.stunden-test-backup-pass deploy/backup.sh --compose deploy/.env
# Archiv per restic zur Storage Box (falls BACKUP_HOOK eingerichtet), dann von dort zurückholen:
restic -r <storage-box-repo> restore latest --target /tmp/restore-probe
deploy/restore-test.sh --docker --migrations db/migrations /tmp/restore-probe/<archiv>.gpg
```

Das Ergebnis („alle Prüfungen bestanden“ oder die Fehlermeldung) bitte in diesen Bericht übernehmen. Ausführlich:
`docs/betrieb.md`, Abschnitt 5.1.
