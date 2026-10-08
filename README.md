# Energy Split Card

Gestapeltes Verbrauchsdiagramm für Home Assistant mit **frei wählbaren Statistiken**, gesteuert über die native Datumsauswahl des Energie-Dashboards (`energy-date-selection`). Tag, Woche, Monat und Jahr mit Vor- und Zurückblättern funktionieren genauso wie im Energie-Dashboard.

Gedacht für Fälle, die das Energie-Dashboard nicht abdeckt, etwa **Gas nach Zweck** (Heizung und Warmwasser getrennt), Wärme, Wasser oder beliebige Teilzähler. Optional zeigt die Karte zusätzlich zur Summe einen Anteil **„Nicht zugeordnet“** (Gesamtzähler minus Summe der Teilzähler), wie bei den einzelnen Verbrauchern im Strom-Dashboard.

## Funktionen

- **Zeitraum:** folgt der Karte `energy-date-selection` auf derselben Ansicht.
- **Auflösung:** stündliche, tägliche oder monatliche Balken, automatisch passend zum Zeitraum (wie im Original).
- **Daten:** aus den Langzeitstatistiken (`recorder/statistics_during_period`). Jeder Sensor mit `state_class: total` oder `total_increasing` funktioniert.
- **Diagramm:** gestapelte Balken mit Tooltip.
- **Summentabelle:** Energie und Kosten je Quelle wie die Karte „Summen“ im Energie-Dashboard. Ein Klick auf eine Zeile blendet die Quelle aus oder wieder ein.
- **Kosten:** echte Kosten aus einer Kostenstatistik (z. B. dem `_cost`-Sensor des Energie-Dashboards), anteilig je Quelle verteilt, oder näherungsweise über einen aktuellen Preis.
- **Optik:** Diagramm, Achsen, Summen-Badge und Tabelle im Stil des Energie-Dashboards. Diagramm und Tabelle lassen sich als zwei Karten nebeneinander anzeigen.
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
  total_entity: sensor.gasverbrauch_energie
  cost_entity: sensor.gasverbrauch_energie_cost
  series:
    - entity: sensor.gas_heizung
      name: Heizung
    - entity: sensor.gas_warmwasser
      name: Warmwasser
      color: "#ff9800"
```

Wie im Energie-Dashboard, mit Diagramm und Summen nebeneinander und der Datumsauswahl als schwebender Fußzeile einer Abschnittsansicht:

```yaml
type: sections
max_columns: 3
footer:
  card:
    type: energy-date-selection
sections:
  - type: grid
    column_span: 2
    cards:
      - type: custom:energy-split-card
        display: chart
        title: Gasverbrauch
        # total_entity, cost_entity, series wie oben
  - type: grid
    cards:
      - type: custom:energy-split-card
        display: table
        title: Summen
        total_label: Gas gesamt
        # total_entity, cost_entity, series wie oben
```

| Option | Pflicht | Beschreibung |
|---|---|---|
| `series` | ja | Liste der Quellen: `entity` (Statistik-ID), optional `name` und `color` |
| `title` | nein | Überschrift |
| `total_entity` | nein | Gesamtzähler. Die Differenz zur Summe der Quellen erscheint als „Nicht zugeordnet“. |
| `cost_entity` | nein | Kostenstatistik zum Gesamtzähler (z. B. `sensor.gasverbrauch_energie_cost`). Die Kosten jeder Stunde, jedes Tages oder Monats werden im Verhältnis der Energie auf die Quellen verteilt. Diese Werte entsprechen dem Energie-Dashboard. |
| `price_entity` | nein | Ersatz ohne `cost_entity`: Preis pro Einheit, gerechnet mit dem **aktuellen** Preis. |
| `display` | nein | `both` (Standard), `chart` oder `table` |
| `total_label` | nein | Beschriftung der Summenzeile (Standard „Gesamt“) |
| `show_share` | nein | Spalte mit Prozentanteil in der Tabelle (Standard `false`) |
| `unit` | nein | Einheit für die Anzeige (Standard: Einheit der ersten Quelle) |
| `collection_key` | nein | Für mehrere Datumsauswahlen auf einer Ansicht. Muss mit `energy_` beginnen und dem `collection_key` der Datumsauswahl entsprechen. |
| `chart_height` | nein | Diagrammhöhe in px (Standard 300) |

Ohne Datumsauswahl auf der Seite zeigt die Karte den heutigen Tag und einen Hinweis.

## Hinweise

- Mit `cost_entity` sind die Kosten identisch zum Energie-Dashboard. Mit `price_entity` sind sie nur eine Näherung über den aktuellen Preis.
- Gruppierung und Einheiten kommen direkt aus dem Recorder. Die Quellen sollten dieselbe Einheit haben.
- Die Karte liest die Datumsauswahl über das Collection-Objekt des Energie-Dashboards. Dieser Weg wird auch von anderen Karten genutzt, ist aber keine offiziell dokumentierte API.

## Lizenz

MIT
