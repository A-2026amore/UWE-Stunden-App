# Designsystem „Schichtklar24“

Stand: 28.10.2026 · Branch `feature/design-stundenwerk`

Produktname: **Schichtklar24** (vorläufig, vorbehaltlich Markenprüfung). Der Name steht an genau einer Stelle:
`PRODUCT_NAME` in `platform/src/design/branding.ts`. Der Zusatz „Arbeitstitel“ wird nicht mehr angezeigt.

## Grundsätze

- Benutzerfreundlichkeit vor Dekoration: große Touch-Ziele (mind. 44 px, Speichern 52 px), klare Hierarchie,
  wenige Farben, Zahlen in Tabellenziffern.
- Eine Designsprache für Mitarbeiter-App, Chef-Portal, Super-Admin, Anmeldung und E-Mail-Link-Seiten.
- Keine externen Dienste zur Laufzeit: keine CDNs, keine Google Fonts, keine Diagramm-Bibliothek.
- Strenge Content-Security-Policy bleibt gültig (`style-src 'self'`): Farben werden nur über das CSSOM gesetzt.

## Bausteine

| Bereich | Datei | Inhalt |
|---|---|---|
| Tokens | `design/tokens.css` | Farben (hell/dunkel), Typografie, Abstände (4-px-Raster), Radien, Schatten, Bewegung |
| Komponenten-CSS | `design/components.css` | Buttons, Karten, Kennzahlen, Tabellen (mobil als Karten), Dialoge (mobil als Bottom-Sheet; `wide` für Dialoge mit Tabellen, z. B. Verlauf eines Monatsnachweises), Navigation, Anmeldeseiten, Diagramme, Skeleton |
| Komponenten | `design/components.tsx` | u. a. `StatTile` (mit Symbol/Link als Kennzahl-Kachel), `BarChart` (SVG), `Skeleton`, `Avatar`, `ThemeSwitch`, `Sidebar` mit Gruppen |
| Logo | `design/logo.tsx`, `public/product-mark.svg` | Produktlogo „Haken-Uhr“ (Uhr auf dunkelblauer Kachel, Zeiger als türkiser Haken; Quelle `marke/logos` im Projektordner), inline SVG; App-Icons in `public/app/icons` |
| Symbole | `design/icons.tsx` | 24-px-Strichsymbole, erweitert (Sonne, Mond, Euro, Karte, …) |
| Farbschema | `design/theme.ts` | Hell/Dunkel/System, Speicherung lokal |
| Schrift | `design/fonts/` | Inter (variabel, latin + latin-ext, woff2), Lizenz SIL OFL 1.1 in `OFL.txt` |

## Hell- und Dunkelmodus

- Standard ist „System“ (folgt dem Betriebssystem). Umschalter „System / Hell / Dunkel“: Mitarbeiter-App →
  Profil → „Darstellung“, Chef-Portal und Super-Admin → unten in der Seitenleiste, Demo-Startseite.
- Die Auswahl wird nur auf dem Gerät gespeichert (`localStorage`, Schlüssel `stundenwerk_theme`), keine
  Übertragung an den Server. Ist der Speicher gesperrt, gilt die Auswahl für die aktuelle Seite.
- Umsetzung: `<html data-theme="light|dark">`; alle Farben sind Tokens. `prefers-reduced-motion` schaltet
  Übergänge und Animationen ab.

## Firmen-Branding in beiden Modi

`applyBranding()` leitet aus den Firmenfarben zwei Sätze ab (`brandVariables` hell, `brandVariablesDark`
dunkel) und setzt sie als `--light-brand-*` bzw. `--dark-brand-*`. Regeln:

- Text in Markenfarbe wird automatisch abgedunkelt (hell) bzw. aufgehellt (dunkel), bis er mind. 4,5 : 1 auf
  Fläche und Tönung erreicht (WCAG AA).
- Buttons bekommen weiße oder dunkle Schrift mit mind. 4,5 : 1; sehr dunkle Markenfarben werden im Dunkelmodus
  angehoben, damit Buttons sich vom Hintergrund abheben (mind. 3 : 1).
- Firmenlogos (für helle Flächen gestaltet) stehen im Dunkelmodus auf einer hellen Plakette.
- Ohne Firma (Anmeldung, Super-Admin) gelten die Produktfarben (Indigo). Die CSS-Rückfallwerte in
  `tokens.css` entsprechen genau diesen Produktfarben – geprüft in `branding.test.ts`, ebenso alle
  Kontrastpaare der Status- und Textfarben in beiden Modi.

## Layouts

- **Anmeldung** (Mitarbeiter, Chef, Admin, Passwort neu, Einladung, 2FA-Einrichtung): ab 960 px zweigeteilt –
  links Markenfläche mit Kurzbeschreibung, rechts Formular; mobil einspaltig. Ist auf dem Gerät eine Firma
  bekannt (letzte Anmeldung in diesem Bereich), erscheint ihr Logo bzw. Name (nur Name und Logo werden lokal
  gemerkt, keine Personendaten).
- **Chef-Portal / Super-Admin**: Seitenleiste mit Gruppen ab 1024 px; darunter (Tablet, Handy) Kopfzeile mit
  Menü-Schaltfläche und ausklappbarer Leiste. Offene Korrekturanfragen und Monatsnachweise erscheinen als Zahl
  an den Menüpunkten. Fußbereich: Person, Farbschema, Abmelden.
- **Chef-Dashboard**: fünf Kennzahlen (Stunden des Monats, offene Monatsnachweise, offene Korrekturanfragen,
  Mitarbeitende, Kosten des Monats – Vorschau aus der Abrechnung), Balkendiagramm Stunden je Tag/Woche
  (reines SVG, Werte zusätzlich als Liste für Screenreader), Stunden je Person, Tabellen der offenen Vorgänge.
  Die Diagrammwerte sind reine Anzeige (`apps/shared/charts.ts`); maßgeblich bleiben die Zahlen der Fachlogik.
- **Mitarbeiter-App**: Kopfzeile mit Firmenlogo und Person, Tab-Leiste unten (auf Tablet/Desktop schwebend)
  mit hervorgehobenem „Erfassen“, Safe-Area (`env(safe-area-inset-*)`) oben, unten und seitlich,
  Monatsansicht mit Tagesdiagramm.

## PDF-Stundennachweis

`core/pdf.ts`: Kopf mit Firmenlogo/-name und Titel „STUNDENNACHWEIS“, Infofeld (Mitarbeiter/in,
Personalnummer, Zeitraum, Status), Tabelle mit farbigem Kopf und Zebra-Streifen, Wochentag beim Datum,
rechtsbündige Stunden, Summenblock (Gesamt, Einsätze, Arbeitstage, Pausen), Fußzeile mit Erstellungsdatum,
„Erstellt mit Schichtklar24“ und „Seite x von y“. Zeilenhöhen und Seitenumbrüche sind unverändert: der Nachweis
bleibt mehrseitig und gut lesbar (Vergleichstest gegen den Altgenerator `uwe-pdf.js`).

## Prüfung

- Unit-Tests: `branding.test.ts` (Kontrast hell/dunkel, Token-Rückfallwerte), `theme.test.ts`,
  `charts.test.ts`, `pdf.test.ts`.
- Screenshots (Demo-Daten, hell/dunkel, Desktop 1440×900, Tablet 820×1180, iPhone 390×844):
  `/mnt/project-files/screenshots/design-1.0/`.
- Nicht geprüft: echte iPhone-/Android-Geräte (nur Browser-Emulation), Windows-Hochkontrastmodus.
