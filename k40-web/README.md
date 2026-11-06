# K40 Web

Neue Steuerungssoftware für K40-Laser mit **M2-Nano**-Controller (und M1, M, B2, B1, B, A) –
als Ersatz für K40 Whisperer, die auf aktuellen Macs nicht mehr läuft.

Läuft im Browser (**Google Chrome** oder Microsoft Edge) und spricht per **WebUSB** direkt mit dem Laser.
Keine Treiber, kein libusb, kein Inkscape, kein Python nötig.

## Starten

Doppelklick auf `start.command` (beim ersten Mal: Rechtsklick → Öffnen, wegen Gatekeeper).
Das Skript baut die App und öffnet sie in Chrome unter <http://localhost:4173>.

Oder im Terminal:

```bash
npm install
npm run dev        # Entwicklung: http://localhost:5173
```

## Bedienung

1. **Laser verbinden** → im Chrome-Dialog das Gerät „USB-EPP/I2C… CH341A“ (1a86:5512) wählen.
   Der Kopf fährt danach in die Ausgangsposition (oben links). Beim nächsten Start verbindet sich die App automatisch.
2. **Datei öffnen** oder per Drag & Drop: SVG, PNG, JPG.
   - Kontur **rot** (#FF0000) → Vektor-Schnitt
   - Kontur **blau** (#0000FF) → Vektor-Gravur
   - alles andere → Raster-Gravur (Schwarz/Weiß oder Graustufen per Dithering)
3. Design positionieren: Pfeiltasten/Jog-Pad oder **mit der Maus auf der Arbeitsfläche ziehen**.
   Der Laserkopf steht immer an der oberen linken Ecke des Designs (Startpunkt).
   Mit den Ecken-Knöpfen fährt der Kopf die Ecken des Designs ab (Rahmen prüfen).
4. Vorgänge anhaken, Geschwindigkeit (mm/s) und Durchgänge einstellen → **Start**.
   **Stopp** pausiert sofort und fragt dann: abbrechen (Not-Halt) oder fortsetzen.

### Verbindungsstatus

Der Punkt in der Karte „Laser“ zeigt den Zustand:
grau = nicht verbunden (Simulation), grün = verbunden, orange = Auftrag läuft,
rot = verbunden, aber der Controller antwortet nicht (z. B. Laser ausgeschaltet).
Im Leerlauf fragt die App alle 3 Sekunden den Status ab. Wird der Laser eingesteckt oder eingeschaltet,
verbindet sie sich automatisch neu (wenn er in Chrome schon einmal freigegeben wurde) – danach „Home“ drücken.

### Vorschau und Export

„Pfad-Simulation“ zeigt vorab genau die Wege, die an den Laser gehen (dekodiert aus den echten
Befehlsdaten) inkl. geschätzter Dauer. Ohne angeschlossenen Laser funktioniert alles außer dem Senden.
„EGV speichern“ erzeugt eine .EGV-Datei (kompatibel zu K40 Whisperer/LaserDRW).

## Technik

| Bereich | Datei |
|---|---|
| Speed-Codes (M2 u.a.) | `src/core/laserSpeed.ts` |
| EGV-Befehlserzeugung (Port von egv.py) | `src/core/egv.ts` |
| Schneidreihenfolge, Raster, Auftrag | `src/core/job.ts` |
| SVG-Pfade → Linienzüge | `src/core/pathFlatten.ts` |
| EGV-Simulator (Vorschau/Tests) | `src/core/egvSim.ts` |
| USB-Pakete + CRC | `src/usb/packets.ts` |
| WebUSB-Treiber | `src/usb/k40usb.ts` |
| SVG/Bild-Import, Raster-Rendering | `src/io/design.ts` |
| Oberfläche | `index.html`, `src/main.ts`, `src/ui/styles.css` |

### Tests

```bash
npm test
```

Die Golden-Tests vergleichen die erzeugten Laserbefehle **Byte für Byte** mit dem Original-Code
von K40 Whisperer (`../egv.py`, `../LaserSpeed.py`, `../nano_library.py`). Referenzdaten neu erzeugen:
`npm run golden`.

## Fehlersuche

- *„WebUSB nicht verfügbar“*: Safari/Firefox unterstützen kein WebUSB → Chrome oder Edge verwenden.
- *Gerät erscheint nicht im Auswahldialog*: USB-Kabel/Laser einschalten; ggf. installierten
  WCH-CH34x-Treiber entfernen, falls er das Gerät belegt.
- *„Zugriff verweigert“ beim Verbinden*: K40 Whisperer oder ein anderes Programm, das den Laser
  geöffnet hat, beenden.
- Maße stimmen nicht exakt → Einstellungen → Kalibrierung X/Y (z.B. 1,002).

Lizenz: GPL-3.0 (wie K40 Whisperer, von dem Protokoll-Code portiert wurde).
