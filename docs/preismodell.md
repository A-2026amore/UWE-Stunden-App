# Preismodell

Verbindliche Entscheidung des Auftraggebers vom 28.10.2026. Umsetzung: Migration
`db/migrations/0012_billing.sql`, Fachlogik `platform/src/core/billing.ts`, Chef-Portal „Abrechnung“,
Super-Admin „Umsatz“ und „Preismodell“.

## Kurz gesagt

- **5,00 € netto je abrechenbarem Mitarbeiter und Monat**, zzgl. gesetzlicher USt.
- Keine Grundgebühr, keine Mindestanzahl, keine Staffeln.
- Beispiele: 5 Mitarbeiter → 25,00 €, 20 → 100,00 €, 100 → 500,00 € (jeweils netto).
- Kostenlose Kundenkonten (Pilot, Test) und Sonderpreise je Kunde sind möglich.
- Es ist **kein Zahlungsdienstleister** angebunden: Abrechnung manuell, keine Abbuchungen, keine Kontodaten.

## Wer wird berechnet?

| Person | Im Monat berechnet? |
|---|---|
| Mitarbeiter/in, im Monat mindestens zeitweise aktiv | **ja** |
| Mitarbeiter/in, im Laufe des Monats gesperrt oder deaktiviert | **ja**, für diesen Monat – ab dem Folgemonat nicht mehr (Sperre am 10.11. → November ja, Dezember nein) |
| Mitarbeiter/in, den ganzen Monat gesperrt oder deaktiviert | nein |
| Nur eingeladen, nie aktiv gewesen | nein |
| Inhaber/in oder Vorgesetzte ohne eigene Arbeitszeiten im Monat | nein (kostenlos) |
| Inhaber/in oder Vorgesetzte **mit** eigenen Arbeitszeiten im Monat (nicht gelöscht) | **ja** |
| Wechsel von Mitarbeiter/in zu Vorgesetzte/r im Monat | ja für diesen Monat (war als Mitarbeiter/in aktiv) |

Monatsgrenzen gelten nach deutscher Zeit (Europe/Berlin): Wer am 30.09. um 23:30 Uhr aktiviert wird,
zählt für September; wer am 01.10. um 00:30 Uhr aktiviert wird, erst für Oktober.

## Mitarbeiterstatus

| Status | Bedeutung | Anmeldung | Daten |
|---|---|---|---|
| Eingeladen | Einladung verschickt, noch nicht angenommen | – | bleiben |
| Aktiv | arbeitet mit der App | ja | bleiben |
| **Gesperrt** (neu) | vorübergehend, z. B. Diensthandy verloren, längere Abwesenheit | **nein**, sofort (auch laufende Sitzungen) | bleiben |
| Deaktiviert | ausgeschieden | nein | bleiben |

Im Chef-Portal (Mitarbeiter): aktive Personen **sperren** oder **deaktivieren**, gesperrte **entsperren**
oder deaktivieren, deaktivierte wieder **aktivieren**. Jede Änderung braucht einen Grund und steht im
Änderungsprotokoll. Niemand sperrt sich selbst; Leitungspersonen sperrt nur der Inhaber.

Technisch: Jede Status- und Rollenänderung wird mit Zeitpunkt in einer Historie gespeichert
(`employee_status_history`). Daraus ergibt sich, ob jemand „im Monat aktiv“ war.

## Preise und Sonderkonditionen (Super-Admin)

- **Standardpreis** (Super-Admin → „Preismodell“): 5,00 € netto, änderbar nur mit Begründung; jede
  Änderung steht im Plattform-Protokoll.
- **Sonderkondition je Kunde** (Mandanten → Verwalten → Lizenz):
  - eigener Preis je Mitarbeiter (z. B. 3,50 €),
  - „Kostenloses Konto“ (z. B. Testkunde),
  - Gültigkeit von/bis – gilt für **jeden Monat, den der Zeitraum berührt** (kundenfreundlich bei
    Teilmonaten); leer = unbefristet,
  - Notiz.
- **Pilotkunden** (Lizenz „Kostenlos – Pilot“, bisher `pilot_free`) sind immer kostenlos, ohne
  Zahlungsdaten und ohne automatische Umstellung. Bestehende Pilotlizenzen wurden unverändert übernommen.
- Die übrigen Lizenzen (Standard, Business, Enterprise) unterscheiden sich nur noch in der
  Mitarbeiter-Obergrenze, nicht im Preis.

Reihenfolge der Preisfindung je Monat: Pilot → kostenlos · sonst kostenloses Konto (wenn gültig) →
0 € · sonst Sonderpreis (wenn gültig) · sonst Standardpreis.

## Abrechnung je Monat

**Chef-Portal → Abrechnung** (Inhaber und Vorgesetzte): laufender Monat als Vorschau, frühere Monate
mit Anzahl, Preis je Person, Summe netto und Status; Liste der berechneten Personen mit Grund.

**Super-Admin → Umsatz**: je Monat alle Kunden mit Anzahl, Kondition, Preis, Betrag und Status; Summen
(ohne Demo-Kunden, erlassene Monate getrennt). Das Plattformpersonal sieht **nur Zahlen, keine Namen**.

**Abrechnungsstatus** (nur Super-Admin, erst nach Monatsende):

| Status | Bedeutung |
|---|---|
| Offen | noch nicht abgerechnet – Werte sind vorläufig |
| In Rechnung gestellt | Rechnung erzeugt (automatisch beim Erzeugen, Notiz „Rechnung SW-…“) oder manuell gesetzt |
| Bezahlt | Zahlung eingegangen |
| Erlassen | wird nicht berechnet – **Grund ist Pflicht** |

Jede Statusänderung steht im Protokoll (Plattform und Mandant), ohne Namen von Mitarbeitenden.

## Feste Werte für vergangene Monate (Entscheidung)

Gewählt: **Festschreiben beim Abschluss** plus Berechnung aus der Historie.

- Solange ein Monat „Offen“ ist, wird er aus der Statushistorie, den Arbeitszeiten und der aktuellen
  Kondition berechnet.
- Sobald der Super-Admin einen vergangenen Monat auf „In Rechnung gestellt“, „Bezahlt“ oder „Erlassen“
  setzt, werden **Anzahl, Preis, Betrag, Kondition und die Liste der berechneten Personen
  festgeschrieben**. Spätere Änderungen (Preis, Kondition, nachträglich gelöschte Zeiten der Leitung,
  Korrekturen) ändern diesen Monat nicht mehr.
- Wiederöffnen (Status „Offen“) ist möglich, braucht einen Grund und wird protokolliert; danach wird
  wieder live berechnet.

Warum nicht nur aus der Historie? Die Historie selbst ist stabil, aber Preise, Konditionen und
(gelöschte) Arbeitszeiten der Leitung können sich nachträglich ändern. Die festgeschriebene Rechnung
muss dagegen exakt so bleiben, wie sie verschickt wurde.

## Gesperrte und deaktivierte Firmen (Entscheidung 28.10.2026)

Eine Firma, die gesperrt („vorübergehend gesperrt“) oder deaktiviert („Vertrag beendet“) wird, kostet
**ab dem Folgemonat 0 €**. Der Monat, in dem gesperrt wurde, wird noch voll berechnet.

- Beispiel: gesperrt am 10.11. → November wird berechnet, Dezember 0 €.
- Wird die Firma im Laufe eines Monats wieder aktiviert, wird dieser Monat wieder berechnet.
- Grundlage ist die Statushistorie der Firma (seit Migration 0018); Monatsgrenzen nach deutscher Zeit.
- **Super-Admin → Umsatz** zeigt in der Spalte Kondition „Firma gesperrt – nicht berechnet“ mit Datum und
  Grund der Sperre. **Chef-Portal → Abrechnung** zeigt dem Kunden den Hinweis mit Datum, ohne den internen Grund.
- Die Zahl der Personen wird zur Information weiter angezeigt; der Betrag ist 0 €.
- Bereits festgeschriebene Monate ändern sich nicht.

## Rechnungen (Super-Admin → Rechnungen)

- **Rechnungsnummer** `SW-2026-000001`: Präfix (Einstellung), Jahr des Rechnungsdatums, laufende Nummer je Jahr.
  Lückenlos und eindeutig, auch wenn zwei Rechnungen gleichzeitig erzeugt werden; eine Nummer wird nie
  wiederverwendet. Entwürfe bekommen keine Nummer.
- **Inhalt eingefroren:** Absender, Empfänger, Positionen („Zeiterfassung – abrechenbare Mitarbeitende MM/JJJJ“,
  Anzahl × Preis), USt-Satz, Beträge, Rechnungs- und Fälligkeitsdatum. Keine Namen von Mitarbeitenden.
- **Storno:** erzeugt eine Stornorechnung mit eigener Nummer und negativen Beträgen; die ursprüngliche Rechnung
  bleibt erhalten und wird als storniert gekennzeichnet. Gelöscht wird nichts. Danach kann für den Monat eine neue
  Rechnung erzeugt werden.
- **Umsatzsteuer:** voreingestellt 19 %. Solange der Satz nicht als „vom Auftraggeber bestätigt“ markiert ist,
  steht auf jeder Rechnung der Hinweis „USt-Satz vom Auftraggeber zu bestätigen“.
- **Zahlungsziel** (Standard 14 Tage) und Zahlungshinweis (z. B. Bankverbindung) sind Einstellungen.
- **Pflichtangaben nach § 14 UStG** (Name und Anschrift des Absenders, Steuernummer oder USt-IdNr.) trägt der
  Super-Admin ein. Fehlt etwas – auch die Anschrift des Kunden im Firmenprofil –, ist nur ein **Entwurf** mit dem
  Wasserzeichen „Entwurf – Pflichtangaben fehlen“ möglich.
- Beim Erzeugen wird ein noch offener Monat als „In Rechnung gestellt“ festgeschrieben. Für den laufenden Monat,
  erlassene Monate und 0-€-Monate gibt es keine Rechnung.
- PDF mehrseitig bei Bedarf („Seite x von y“). Der Kunde (Inhaber) sieht seine Rechnungen im Chef-Portal unter
  „Abrechnung“ und kann sie als PDF laden.
- Kein Versand, keine Zahlungsabwicklung, kein externer Dienst.
- Eine **Wiederöffnung eines Monatsnachweises** (Korrektur nach Freigabe) ändert weder die festgeschriebene
  Abrechnung noch eine Rechnung: Berechnet werden Personen, nicht Stunden.

## Zahlungsdienstleister

Nur vorbereitet: Schnittstelle `PaymentProvider` in `server/src/payment.ts` mit der einzigen
Umsetzung `none`. Sie macht keine externen Aufrufe, speichert keine Konto- oder Kartendaten und lehnt
jede Abbuchung ab. Die Umgebungsvariable `PAYMENT_PROVIDER` akzeptiert nur `none`; jeder andere Wert
verhindert den Serverstart. Eine echte Anbindung braucht Ihre Freigabe, einen Vertrag, eine
Datenschutzprüfung und eine eigene Umsetzung mit Tests.

## Datenschutz

- Kunden (Inhaber, Vorgesetzte) sehen nur die eigene Abrechnung, mit Namen.
- Mitarbeitende sehen keine Abrechnung.
- Plattformpersonal sieht nur Zahlen je Kunde (Anzahl, Beträge, Kondition, Status) – weder Namen noch
  die Liste der berechneten Personen noch die Statushistorie. Das setzt die Datenbank durch (RLS).
- Fremde Abrechnungen sind für Kunden technisch nicht abrufbar (geprüft in `tests/db/billing.test.ts`).

## Offene Punkte (Entscheidung des Auftraggebers)

- Rechnungen werden erzeugt (siehe oben), aber nicht versendet; Zahlungseingang wird manuell als „Bezahlt“ gepflegt.
- USt-Satz 19 % ist vom Auftraggeber zu bestätigen; Absenderangaben (§ 14 UStG) sind einzutragen.
- Umsatzsteuer: Es werden nur Nettobeträge mit dem Hinweis „zzgl. gesetzlicher USt.“ angezeigt.
