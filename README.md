# K40 Web (Fork von K40 Whisperer)

Steuerungssoftware für K40-Laser mit **M2-Nano**-Controller (sowie M1, M, B2, B1, B, A),
die auf **aktuellen Macs** läuft – auch auf Apple Silicon.

Dieser Fork enthält eine Neuentwicklung im Ordner [`k40-web/`](k40-web/):
eine Web-App in TypeScript, die im Browser (**Google Chrome** oder Microsoft Edge) läuft und per
**WebUSB** direkt mit dem Laser spricht. Python, libusb, XQuartz und Inkscape werden nicht mehr benötigt –
genau an diesen Abhängigkeiten scheitert die ursprüngliche K40-Whisperer-App auf neueren macOS-Versionen.

## Schnellstart

Voraussetzungen: [Node.js](https://nodejs.org) (z. B. `brew install node`) und Google Chrome.

```bash
git clone -b k40-web https://github.com/andreasscheck/k40-whisperer.git
```

Dann im Finder `k40-whisperer/k40-web/start.command` doppelklicken (beim ersten Mal: Rechtsklick → Öffnen).
Die App öffnet sich in Chrome unter <http://localhost:4173>. Alternativ im Terminal:

```bash
cd k40-whisperer/k40-web
npm install
npm run dev
```

Bedienung, Technik und Fehlersuche: siehe [`k40-web/README.md`](k40-web/README.md).

## Funktionen

- SVG, PNG und JPG öffnen (auch per Drag & Drop) – Farbkonvention wie bei K40 Whisperer:
  rote Kontur = Schneiden, blaue Kontur = Vektor-Gravur, alles andere = Raster-Gravur
- Raster in Schwarz/Weiß oder Graustufen (Dithering), Zeilenabstand 0,025–0,127 mm
- Design per Maus auf der Arbeitsfläche positionieren, Joggen, Design-Ecken anfahren
- Innere Konturen zuerst schneiden, Leerfahrten optimieren, mehrere Durchgänge
- Pfad-Simulation mit Laufzeitschätzung, Export als `.EGV`
- Pause / Abbruch mit Not-Halt, Verbindungsstatus mit automatischem Wiederverbinden

## Kompatibilität zum Original

Das Laserprotokoll (EGV-Befehle, Geschwindigkeitscodes, USB-Pakete mit CRC) wurde aus K40 Whisperer
portiert. Automatische Tests vergleichen die erzeugten Daten **Byte für Byte** mit dem Python-Original
in diesem Repository (`egv.py`, `LaserSpeed.py`, `nano_library.py`):

```bash
cd k40-web && npm test
```

**Status:** Die Software ist noch nicht ausführlich an echter Hardware erprobt. Erste Tests bitte mit
niedriger Leistung durchführen und vorher mit den Ecken-Knöpfen den Rahmen abfahren.

Noch nicht übernommen: DXF- und G-Code-Import, Rotationsachse, „Home oben rechts“, Umriss-Abfahrt.

## Ursprüngliche K40-Whisperer-Dateien

Die Python-Quellen von K40 Whisperer (Scorchworks) und die macOS-Paketierung von
[stephenhouser/k40-whisperer](https://github.com/stephenhouser/k40-whisperer)
(`build-macOS.sh`, `update-macOS.sh`, `k40_whisperer.spec`, `macOS.patch` …) liegen unverändert im
Hauptverzeichnis. Sie dienen hier als Referenz für die Tests; die Anleitung zum Bauen der alten App
steht im Upstream-Repository.

Original-Software und Dokumentation: <https://www.scorchworks.com/K40whisperer/k40whisperer.html>

## Lizenz

GPL-3.0 – siehe [`gpl-3.0.txt`](gpl-3.0.txt). K40 Whisperer stammt von Scorch (scorchworks.com),
die macOS-Paketierung von Stephen Houser.
