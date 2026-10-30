# Preismodell

Verbindliche Entscheidung des Auftraggebers vom 28.10.2026, geändert am 30.10.2026 (Bruttopreis,
keine kostenlosen Konten, Aktionscodes, 12-Monats-Abo und Monatstarif). Umsetzung: Migrationen
`db/migrations/0012_billing.sql`, `0022_promo_codes_gross_prices.sql` und `0023_subscriptions.sql`,
Fachlogik `platform/src/core/billing.ts` und `platform/src/core/subscription.ts`, Chef-Portal „Abrechnung“
(Karte „Tarif“), Super-Admin „Umsatz“, „Preismodell“ und „Aktionscodes“.

## Kurz gesagt

- **12-Monats-Abo: 5,00 € brutto** je abrechenbarem Mitarbeiter und Monat, inkl. gesetzlicher USt.
  (bei 19 %: 4,20 € netto + 0,80 € USt.).
- **Monatstarif: 6,50 € brutto** je abrechenbarem Mitarbeiter und Monat. **Ohne Wahl gilt der Monatstarif.**
- Keine Grundgebühr, keine Mindestanzahl, keine Staffeln.
- Beispiel 20 Mitarbeitende: 100,00 € im 12-Monats-Abo, 130,00 € im Monatstarif (jeweils brutto).
- **Keine kostenlosen Konten** für neue Kunden. Rabatte bis 100 % gibt es nur über **Aktionscodes**
  (siehe unten); der Rabatt läuft, bis der Super-Admin ihn beendet. Sonderpreise je Kunde bleiben möglich.
- Es ist **kein Zahlungsdienstleister** angebunden: Abrechnung manuell, keine Abbuchungen, keine Kontodaten.

## Tarife, Testphase und Kündigung (seit 30.10.2026)

| | 12-Monats-Abo | Monatstarif |
|---|---|---|
| Preis je Mitarbeiter/Monat (brutto) | 5,00 € (Standardpreis) | 6,50 € |
| Laufzeit | 12 Monate fest, ab dem 1. eines Monats | monatlich |
| Verlängerung | jeweils um 6 Monate, wenn nicht bis zum letzten Tag der Laufzeit gekündigt (Kündigungsfrist in Tagen einstellbar, Standard 0) | läuft weiter |
| Kündigung | zum Ende der Laufzeit; wahlweise „danach im Monatstarif weiter“ | zum Ende des laufenden Monats |

- **Vertragsschluss:** Bei der ersten Anmeldung sieht der Inhaber nur „Firma freischalten“: Bestätigung als
  Unternehmer (§ 14 BGB), Zustimmung zu AGB (mit Anlage A) und AVV, Tarifwahl (Monatstarif vorausgewählt).
  Zeitpunkt und Versionen werden gespeichert. Vorher können Vorgesetzte und Mitarbeitende das Konto nicht nutzen.
- **Wechsel:** Monatstarif → 12-Monats-Abo jederzeit ab dem Folgemonat (in der Testphase ab dem ersten
  bezahlten Monat). 12-Monats-Abo → Monatstarif nur zum Laufzeitende (kündigen mit „danach monatlich weiter“).
- **Kündigung zurücknehmen** geht, solange der Vertrag noch nicht beendet ist.
- **Nach dem Vertragsende** wird nichts berechnet („Kein laufender Vertrag“); der Inhaber kann einen neuen Tarif
  wählen.
- **Einführungsangebot:** Der Super-Admin legt einen Zeitraum fest (von/bis, Anlagedatum des Mandanten) und
  die Länge der Testphase (Standard 3 Monate). Die Testphase reicht bis zum Ende des Kalendermonats, in dem
  diese Monate enden (angelegt am 15.11. → kostenlos bis 28.02.). Abgerechnet wird ab dem Folgemonat.
  Ohne Zeitraum gibt es keine Testphase.
- **Willkommenscode:** Optional ein Aktionscode, der in der Einladung jedes neuen Mandanten steht, solange er
  einlösbar ist.
- **Bestehende Kunden** (vor 0023): keine Testphase, Monatstarif ab dem Anlagemonat. Der Demo-Mandant
  „Muster Pflegedienst“ wird daher mit 6,50 € berechnet.
- Reihenfolge der Preisregeln je Monat: Firma gesperrt → Pilot → kostenloses Konto → Testphase →
  kein Vertrag (0 €) → Sonderpreis → 12-Monats-Abo bzw. Monatstarif → Aktionsrabatt darauf.
- Abgeschlossene Monate und ausgestellte Rechnungen ändern sich nie.
- Jede Tarifänderung steht im Änderungsprotokoll (Vertrag abgeschlossen, Tarif gewählt, gekündigt,
  Kündigung zurückgenommen); Änderungen der Preiseinstellungen im Plattform-Protokoll.

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

- **Preise und Tarifeinstellungen** (Super-Admin → „Preismodell“, ein Formular mit Begründung):
  12-Monats-Abo (Standardpreis, 5,00 €), Monatstarif (6,50 €), Einführungsangebot von/bis, Testphase in
  Monaten, Kündigungsfrist in Tagen, Willkommenscode. Jede Änderung steht im Plattform-Protokoll.
- **Sonderkondition je Kunde** (Mandanten → Verwalten → Lizenz):
  - eigener Preis je Mitarbeiter, brutto (z. B. 3,50 €),
  - „Kostenloses Konto“ – nur noch für bestehende Konten sichtbar (Haken entfernen = kostenpflichtig),
  - Gültigkeit von/bis – gilt für **jeden Monat, den der Zeitraum berührt** (kundenfreundlich bei
    Teilmonaten); leer = unbefristet,
  - Notiz.
- **Pilotkunden** (Lizenz „Kostenlos – Pilot“, `pilot_free`): seit 30.10.2026 nicht mehr für neue Kunden
  wählbar. Bestehende Pilotlizenzen bleiben unverändert kostenlos, bis der Super-Admin sie umstellt.
- Die übrigen Lizenzen (Standard, Business, Enterprise) unterscheiden sich nur noch in der
  Mitarbeiter-Obergrenze, nicht im Preis.

Reihenfolge der Preisfindung je Monat: Firma ganzen Monat gesperrt → 0 € · Pilot → kostenlos · sonst
kostenloses Konto (wenn gültig) → 0 € · Testphase → 0 € · kein laufender Vertrag → 0 € · sonst Sonderpreis
(wenn gültig) oder Preis des Tarifs (12-Monats-Abo bzw. Monatstarif), davon ggf. der Aktionsrabatt
(gerundet auf ganze Cent).

## Aktionscodes (Entscheidung 30.10.2026)

- **Anlegen** (Super-Admin → „Aktionscodes“): Code (6–32 Zeichen, A–Z, Ziffern, Bindestrich; Knopf
  „Zufallscode erzeugen“), Nachlass 1–100 %, optional maximale Zahl der Einlösungen, „einlösbar bis“ und
  interne Notiz. Support sieht die Codes nur.
- **Einlösen** (Chef-Portal → „Abrechnung“, nur der Inhaber): Code eingeben. Je Firma läuft höchstens ein
  Rabatt; denselben Code kann eine Firma nur einmal einlösen. Unbekannte, beendete, abgelaufene und
  ausgeschöpfte Codes ergeben dieselbe Meldung; mehr als 10 Versuche in 15 Minuten werden gebremst.
- **Wirkung:** Der Rabatt gilt für **jeden Monat, den die Laufzeit berührt** – auch den Monat des
  Einlösens – und läuft **ohne Enddatum**, bis der Super-Admin ihn beendet.
- **Beenden** (Begründung Pflicht, protokolliert): je Kunde („Rabatt beenden“ in der Liste oder im Mandanten)
  oder für den ganzen Code („Code beenden“: keine neuen Einlösungen, alle laufenden Rabatte enden). Der
  **Monat des Beendens bleibt rabattiert**, ab dem Folgemonat gilt der normale Preis. Beispiel: eingelöst am
  15.07., beendet am 20.09. → Juli bis September rabattiert, ab Oktober der normale Preis des Tarifs.
- Laut AGB (§ 4) teilt der Anbieter dem Kunden das Ende vorher in Textform mit. Überall, wo ein Code oder
  ein laufender Rabatt angezeigt wird, steht der Hinweis „Rabatt bis auf Weiteres; der Anbieter kann ihn zum
  Ende eines Kalendermonats beenden.“
- Ein 100-%-Monat kostet 0 € – dafür gibt es keine Rechnung. Bei Teilrabatt steht auf der Rechnung
  „(Aktionscode CODE, −50 %)“.
- Abrechnung: Kondition „Aktionscode“; Chef-Portal und Umsatz zeigen Code und Nachlass.

## Abrechnung je Monat

**Chef-Portal → Abrechnung** (Inhaber und Vorgesetzte): laufender Monat als Vorschau, frühere Monate
mit Anzahl, Preis je Person, Summe (brutto) und Status; Liste der berechneten Personen mit Grund.

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
- **Umsatzsteuer:** voreingestellt 19 %. Seit 30.10.2026 sind die Preise **brutto**: Die Rechnung weist den
  Gesamtbetrag brutto, die enthaltene USt. (`round(brutto × Satz / (100 + Satz))`) und die Summe netto aus.
  Ältere Rechnungen behalten ihre gespeicherten Beträge (Nettopositionen). Solange der Satz nicht als „vom Auftraggeber bestätigt“ markiert ist,
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
- Umsatzsteuer: Alle Beträge in den Apps sind Bruttobeträge mit dem Hinweis „inkl. gesetzlicher USt.“.
