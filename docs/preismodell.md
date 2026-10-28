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
| In Rechnung gestellt | Rechnung verschickt (Notiz z. B. Rechnungsnummer) |
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

- Rechnungsstellung selbst (Rechnungsnummern, PDF-Rechnung, Versand) ist nicht Teil dieser Umsetzung;
  der Status wird manuell gepflegt.
- Gesperrter Mandant (Firmenzugang gesperrt): Die Berechnung richtet sich nur nach dem Status der
  Mitarbeitenden. Soll ein gesperrter Kunde nicht berechnet werden, Monat auf „Erlassen“ setzen oder
  „Kostenloses Konto“ mit Gültigkeit eintragen.
- Umsatzsteuer: Es werden nur Nettobeträge mit dem Hinweis „zzgl. gesetzlicher USt.“ angezeigt.
