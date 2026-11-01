# Anlage B zu den AGB: Regelungen zu Verfügbarkeit, Support und Haftung

> **ENTWURF – nicht anwaltlich geprüft.** KI-gestützter Entwurf vom 29.10.2026, keine Rechtsberatung.
> Platzhalter `[OFFEN: …]`, offene Rechtsfragen **⚠ Rechtsfrage**, Entscheidungen des Anbieters **▶ Entscheidung**.

Stand: Entwurf 0.9.1 vom 29.10.2026 (nach KI-Prüfung überarbeitet)

## Teil 1 – Verfügbarkeit

### 1.1 Zielwert

1. Der Anbieter strebt eine Verfügbarkeit des Dienstes von **99,0 % im Kalendermonat** an (Zielwert), gemessen am
   Übergabepunkt (§ 3 Abs. 4 AGB). Gemessen wird durch eine externe Erreichbarkeitsprüfung der Anmeldeseite und
   der Statusschnittstelle im 5-Minuten-Takt; die Messwerte erhält der Kunde auf Anfrage. `[OFFEN: Monitoring
   einrichten – heute nur teilweise vorhanden]`
2. Verfügbar ist der Dienst, wenn sich Nutzer anmelden und Arbeitszeiten erfassen können. Die Offline-Erfassung der
   Mitarbeiter-Anwendung bleibt bei Nichtverfügbarkeit des Servers grundsätzlich möglich; Einträge werden später
   synchronisiert.
3. Nicht als Ausfallzeit zählen:
   - angekündigte Wartungsfenster (Ziff. 1.2),
   - Störungen, die der Anbieter nicht zu vertreten hat, insbesondere höhere Gewalt, Störungen des Internets
     außerhalb des Einflussbereichs des Anbieters, Angriffe Dritter trotz angemessener Schutzmaßnahmen,
   - Störungen, die der Kunde oder seine Nutzer verursachen (z. B. Endgeräte, Netzwerke, Fehlbedienung),
   - Sperrungen nach § 12 AGB.
4. **▶ Entscheidung:** Verbindliche Zusage mit Gutschriften (z. B. 5 % des Monatsentgelts je angefangene 0,5 %
   Unterschreitung, höchstens 25 %) oder – wie in diesem Entwurf – reiner Zielwert. Der Entwurf wählt den
   Zielwert, weil der Betrieb auf **einem** Server (netcup) ohne Hochverfügbarkeit erfolgt. Wird der Zielwert in
   drei aufeinanderfolgenden Monaten erheblich unterschritten (unter 97 %), kann der Kunde den Vertrag
   außerordentlich kündigen; § 543 BGB bleibt unberührt.
   **⚠ Rechtsfrage:** Verhältnis eines Zielwerts zu mietrechtlichen Mängelrechten (Minderung) – Klarstellung, dass
   die gesetzlichen Mängelrechte bei Unterschreitung unberührt bleiben, ist im Entwurf enthalten (Ziff. 1.4).

### 1.2 Wartung

1. Planbare Wartungen führt der Anbieter möglichst **werktags zwischen 22:00 und 06:00 Uhr** oder am Wochenende
   durch und kündigt sie mindestens **zwei Werktage** vorher im Dienst oder per E-Mail an.
2. Wartungsfenster sollen insgesamt **acht Stunden im Kalendermonat** nicht überschreiten.
3. Dringende Sicherheitsupdates dürfen ohne Vorankündigung eingespielt werden; der Anbieter informiert unverzüglich
   danach.

### 1.3 Datensicherung

1. Der Anbieter erstellt **täglich** eine verschlüsselte Sicherung der Datenbank, legt sie zusätzlich außerhalb
   des Servers (Hetzner Storage Box) ab und führt mindestens monatlich eine **dokumentierte**
   Wiederherstellungsprobe durch (siehe TOM); das Ergebnis der letzten Probe teilt er dem Kunden auf Anfrage mit.
   **⚠ Offen (betrieblich, Prüfbefund Nr. 26):** Cronjob am Server und eine Wiederherstellung aus einem echten
   Storage-Box-Archiv sind noch nicht nachgewiesen; vor Vertragsverwendung durchführen und RPO/RTO danach festlegen.
2. Ziele für die Wiederherstellung (keine Garantie): maximaler Datenverlust (RPO) **24 Stunden**, Wiederherstellung
   des Betriebs (RTO) **ein Werktag** nach Feststellung eines Totalausfalls. Bereits auf Endgeräten offline erfasste,
   noch nicht übertragene Einträge werden nach Wiederherstellung nachsynchronisiert.
3. Eine Wiederherstellung einzelner Daten auf Wunsch des Kunden (z. B. nach eigener Fehlbedienung) ist nicht
   geschuldet; der Anbieter kann sie nach Aufwand gesondert anbieten.

### 1.4 Mängelrechte

Die gesetzlichen Mängelrechte nach § 8 AGB bleiben von diesem Teil unberührt.

## Teil 2 – Support

| Punkt | Regelung (Vorschlag) |
|---|---|
| Kanal | E-Mail an `[OFFEN: support@…]`; Störungen zusätzlich `[OFFEN: Telefon/Notfallkontakt]` |
| Supportzeiten | Montag bis Freitag, 09:00–17:00 Uhr (Europe/Berlin), ausgenommen bundeseinheitliche Feiertage und Feiertage am Sitz des Anbieters, 24.12. und 31.12. |
| Berechtigt | vom Kunden benannte Leitungskräfte (Inhaber, Vorgesetzte); Mitarbeitende wenden sich an ihre Leitung |
| Sprache | Deutsch |
| Inhalt | Fragen zur Bedienung, Entgegennahme und Bearbeitung von Störungen und Fehlern; keine Rechts-, Steuer- oder Lohnberatung |

**Reaktionszeiten (Zielwerte innerhalb der Supportzeiten, keine Lösungszeiten):**

| Klasse | Beschreibung | Erste Reaktion |
|---|---|---|
| 1 – kritisch | Dienst insgesamt nicht nutzbar oder Verdacht auf Datenschutz-/Sicherheitsvorfall | 4 Stunden |
| 2 – erheblich | wesentliche Funktion (Anmeldung einzelner Gruppen, Freigabe, Export) gestört, keine Umgehung | 1 Werktag |
| 3 – sonstig | Fehler mit Umgehung, Bedienfragen, Wünsche | 3 Werktage |

**Support-Zugriff auf Daten:** Über die Anwendung sehen Mitarbeitende des Anbieters personenbezogene Daten des
Kunden nur, wenn der Inhaber im Chef-Portal eine befristete Support-Freigabe (1–168 Stunden) erteilt; Erteilung und
Widerruf werden protokolliert. Wenige Administratoren des Anbieters haben zusätzlich einen technischen
Wartungszugang, den sie nur für Störungsbeseitigung, Wiederherstellung, Kontohilfe (z. B. Zurücksetzen der
Zwei-Faktor-Anmeldung) und gesetzliche Pflichten nutzen dürfen; solche Zugriffe werden dokumentiert (AVV § 5).

**Sicherheitsvorfälle:** Meldungen nach AVV § 9 erfolgen unabhängig von den Supportzeiten.

## Teil 3 – Haftung

1. Der Anbieter haftet **unbeschränkt**
   - bei Vorsatz und grober Fahrlässigkeit,
   - für Schäden aus der Verletzung des Lebens, des Körpers oder der Gesundheit,
   - nach dem Produkthaftungsgesetz,
   - im Umfang einer übernommenen Garantie,
   - bei arglistigem Verschweigen eines Mangels.
2. Bei **leichter Fahrlässigkeit** haftet der Anbieter nur bei Verletzung einer wesentlichen Vertragspflicht
   (Kardinalpflicht), also einer Pflicht, deren Erfüllung die ordnungsgemäße Durchführung des Vertrags überhaupt erst
   ermöglicht und auf deren Einhaltung der Kunde regelmäßig vertrauen darf (z. B. Bereitstellung des Dienstes,
   Datensicherung, Vertraulichkeit). Die Haftung ist dann auf den **vertragstypischen, vorhersehbaren Schaden**
   begrenzt.
3. Der Anbieter und der Kunde gehen davon aus, dass der vertragstypische, vorhersehbare Schaden je Schadensfall
   regelmäßig nicht höher ist als `[OFFEN: Betrag, z. B. das Zwölffache des durchschnittlichen Monatsentgelts der
   letzten zwölf Monate, mindestens 5.000 EUR]`. **⚠ Rechtsfrage:** Feste Haftungshöchstbeträge in B2B-AGB sind
   nur wirksam, wenn sie den vertragstypischen Schaden abdecken (BGH-Rechtsprechung zu § 307 BGB); ein zu niedriger
   Betrag macht die Klausel insgesamt angreifbar. Mit der Betriebshaftpflicht-/Cyberversicherung abstimmen.
4. Die verschuldensunabhängige Haftung für anfängliche Mängel (§ 536a Abs. 1 Alt. 1 BGB) ist ausgeschlossen.
5. **Datenverlust:** Für den Verlust von Daten haftet der Anbieter nach Ziff. 1 bis 3. Hat der Kunde zumutbare
   Exporte nach § 5 Abs. 5 AGB unterlassen, ist dies als Mitverschulden zu berücksichtigen (§ 254 BGB). Für Einträge, die nur auf Endgeräten offline gespeichert und nicht synchronisiert
   wurden, gilt § 6 AGB.
6. Der Anbieter haftet nicht für die arbeits-, tarif- oder steuerrechtliche Richtigkeit der vom Kunden eingestellten
   Regeln und der darauf beruhenden Auswertungen, soweit diese auf Vorgaben oder Eingaben des Kunden beruhen
   (§ 3 Abs. 3 AGB). Für Rechenfehler der Software selbst gelten Ziff. 1–3.
7. Die Haftung nach **Art. 82 DSGVO** gegenüber betroffenen Personen bleibt unberührt. Im Innenverhältnis zwischen
   Kunde und Anbieter gelten die Haftungsbeschränkungen dieses Teils auch für Ansprüche aus dem AVV, soweit
   Art. 82 DSGVO dem nicht zwingend entgegensteht. **⚠ Rechtsfrage:** Reichweite von
   Haftungsbeschränkungen im Innenverhältnis für DSGVO-Regress prüfen.
8. Soweit die Haftung beschränkt ist, gilt dies auch für die persönliche Haftung von Organen, Mitarbeitenden und
   Erfüllungsgehilfen des Anbieters.
9. **Verjährung:** Ansprüche des Kunden auf Schadens- und Aufwendungsersatz wegen Mängeln oder leicht fahrlässiger
   Pflichtverletzung verjähren in zwölf Monaten ab dem gesetzlichen Verjährungsbeginn. Dies gilt nicht für Ansprüche
   nach Ziff. 1 und nicht für den Anspruch auf Mangelbeseitigung während der Vertragslaufzeit (vgl. BGH, Urt. v.
   17.02.2010 – VIII ZR 104/09).

---

**Offene Punkte dieses Dokuments**
- ▶ Zielwert vs. verbindliche Verfügbarkeit mit Gutschriften (Teil 1).
- ▶ RPO/RTO nach dem tatsächlich geprüften Backup-Verfahren bestätigen (Wiederherstellung aus der Storage Box ist
  laut Abnahmebericht vom 28.10.2026 noch **nicht** mit einem echten Archiv getestet).
- `[OFFEN]` Supportadresse, Telefon, Haftungshöchstbetrag, Versicherungsschutz.
- Supportzeiten und Reaktionszeiten müssen mit der tatsächlichen personellen Besetzung erfüllbar sein.
