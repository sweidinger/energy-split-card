# Energy Split Card

Gestapeltes Verbrauchsdiagramm für Home Assistant mit **frei wählbaren Statistiken**, gesteuert über die native Datumsauswahl des Energie-Dashboards (`energy-date-selection`). Tag, Woche, Monat und Jahr mit Vor- und Zurückblättern funktionieren genauso wie im Energie-Dashboard.

Gedacht für Fälle, die das Energie-Dashboard nicht abdeckt, etwa **Gas nach Zweck** (Heizung und Warmwasser getrennt), Wärme, Wasser oder beliebige Teilzähler. Optional zeigt die Karte zusätzlich zur Summe einen Anteil **„Nicht zugeordnet“** (Gesamtzähler minus Summe der Teilzähler), wie bei den einzelnen Verbrauchern im Strom-Dashboard.

## Funktionen

- **Zeitraum:** folgt der Karte `energy-date-selection` auf derselben Ansicht.
- **Auflösung:** stündliche, tägliche oder monatliche Balken, automatisch passend zum Zeitraum (wie im Original).
- **Daten:** aus den Langzeitstatistiken (`recorder/statistics_during_period`). Jeder Sensor mit `state_class: total` oder `total_increasing` funktioniert.
- **Diagramm:** gestapelte Balken mit Tooltip.
- **Tabelle:** Verbrauch, Anteil und optional Kosten je Quelle. Ein Klick auf eine Zeile blendet die Quelle aus oder wieder ein.
- **Anpassung:** übernimmt Farben und Schriften aus deinem Theme, Hell- und Dunkelmodus. Texte auf Deutsch und Englisch.
- **Technik:** keine Abhängigkeiten, kein Build-Schritt, nur stabile öffentliche APIs.

## Installation

### HACS (benutzerdefiniertes Repository)

1. In HACS **⋮ → Benutzerdefinierte Repositories** öffnen.
2. `https://github.com/sweidinger/energy-split-card` als Typ **Dashboard** hinzufügen.
3. „Energy Split Card“ installieren und den Browser neu laden.

### Manuell

`energy-split-card.js` nach `/config/www/` kopieren und als Dashboard-Ressource registrieren:

```yaml
url: /local/energy-split-card.js
type: module
```

## Konfiguration

Die Karte braucht auf derselben Ansicht eine Datumsauswahl:

```yaml
- type: energy-date-selection
- type: custom:energy-split-card
  title: Gasverbrauch
  price_entity: sensor.octopus_gas_price
  total_entity: sensor.gasverbrauch_energie
  series:
    - entity: sensor.gas_heizung
      name: Heizung
    - entity: sensor.gas_warmwasser
      name: Warmwasser
      color: "#ff9800"
```

| Option | Pflicht | Beschreibung |
|---|---|---|
| `series` | ja | Liste der Quellen: `entity` (Statistik-ID), optional `name` und `color` |
| `title` | nein | Überschrift |
| `total_entity` | nein | Gesamtzähler. Die Differenz zur Summe der Quellen erscheint als „Nicht zugeordnet“. |
| `price_entity` | nein | Preis pro Einheit (z. B. €/kWh). Ergänzt die Kostenspalte, gerechnet mit dem **aktuellen** Preis. |
| `unit` | nein | Einheit für die Anzeige (Standard: Einheit der ersten Quelle) |
| `collection_key` | nein | Für mehrere Datumsauswahlen auf einer Ansicht. Muss mit `energy_` beginnen und dem `collection_key` der Datumsauswahl entsprechen. |
| `chart_height` | nein | Diagrammhöhe in px (Standard 240) |
| `show_table` | nein | Tabelle unter dem Diagramm anzeigen (Standard `true`) |

Ohne Datumsauswahl auf der Seite zeigt die Karte den heutigen Tag und einen Hinweis.

## Hinweise

- Die Kosten sind eine Näherung mit dem aktuellen Arbeitspreis, kein Abrechnungswert.
- Gruppierung und Einheiten kommen direkt aus dem Recorder. Die Quellen sollten dieselbe Einheit haben.
- Die Karte liest die Datumsauswahl über das Collection-Objekt des Energie-Dashboards. Dieser Weg wird auch von anderen Karten genutzt, ist aber keine offiziell dokumentierte API.

## Lizenz

MIT
