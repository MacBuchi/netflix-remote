# Couch Remote für Netflix

Netflix läuft in Chrome auf PC oder Mac, das Android-Handy ist die Fernbedienung.
Aktuell: vollständige Player-Steuerung. Als Nächstes: Film-Browser auf dem Handy (siehe [PLAN.md](PLAN.md)).

## Funktionen

- Play/Pause, ±10 Sekunden, Zeitleiste zum Springen
- Lautstärke (Regler, Leiser/Lauter, Stumm)
- Intro/Rückblick überspringen, nächste Folge
- Tonspur und Untertitel wählen
- Vollbild an/aus, zurück zur Übersicht, Netflix am PC öffnen
- Einmal per QR-Code koppeln, danach verbindet sich das Handy automatisch – auch nach Neuladen der Netflix-Seite
- Mehrere Rechner (z. B. PC und Mac) koppelbar

## Einrichtung

### 1. Extension in Chrome installieren (PC/Mac)

```bash
npm install
npm run build:ext
```

Dann `chrome://extensions` öffnen → „Entwicklermodus“ einschalten → „Entpackte Erweiterung laden“ →
Ordner `extension/dist` wählen.

Ohne eigenen Build: Im Tab „Actions“ des Repos beim letzten CI-Lauf das Artefakt
`couch-remote-extension` herunterladen, entpacken und diesen Ordner laden.

### 2. Handy-App veröffentlichen (einmalig)

Die Handy-App wird über GitHub Pages ausgeliefert:
Repo → Settings → Pages → Source: **GitHub Actions**. Danach baut der Workflow
„Deploy phone app“ bei jedem Push auf `master` die App nach
`https://macbuchi.github.io/netflix-remote/`.

Läuft die App unter einer anderen Adresse: Extension-Popup → „Erweitert“ → „Adresse der Handy-App“.

### 3. Koppeln

1. In Chrome auf das Extension-Symbol klicken – ein QR-Code erscheint.
2. QR-Code mit der Android-Kamera scannen, der Link öffnet die Fernbedienung.
3. Im Chrome-Menü auf dem Handy „Zum Startbildschirm hinzufügen“ – ab dann startet sie wie eine App.

„Neu koppeln“ im Popup erzeugt einen neuen Schlüssel; alle bisher gekoppelten Handys müssen dann neu scannen.

## So funktioniert es

```
Handy (PWA) ──WebRTC-Datenkanal──► Extension: Offscreen-Dokument ─► Service Worker ─► Content-Script ─► page.js (Netflix-Player-API)
        └────── Verbindungsaufbau über PeerJS-Vermittlungsserver ──────┘
```

- **Verbindung:** Handy und PC finden sich über den öffentlichen PeerJS-Server (kein Konto nötig) und
  sprechen dann direkt per WebRTC miteinander – im selben WLAN bleiben die Befehle im lokalen Netz.
  Ein eigener Server lässt sich im Popup unter „Erweitert“ eintragen (`npx peerjs --port 9000`, von
  der Handy-App aus per `wss://` erreichbar, weil die App über HTTPS läuft).
- **Sicherheit:** Der QR-Code enthält einen geheimen Schlüssel (im `#`-Teil der Adresse, er geht nie an
  einen Webserver). Ohne ihn nimmt die Extension keine Befehle an; erlaubt sind nur die festen Befehle aus
  `shared/protocol.ts`.
- **Netflix-Steuerung:** über die interne Player-API von Netflix, mit Rückfall auf das `<video>`-Element und
  die `data-uia`-Schaltflächen. Alle Netflix-Selektoren stehen in `extension/src/netflix/selectors.ts`.
- **Vollbild:** Echtes Vollbild braucht in Chrome einen Klick am PC; stattdessen schaltet die Extension das
  Browserfenster in den Vollbildmodus – Netflix füllt es komplett aus.
- **Handy-Lautstärketasten** kann eine Web-App nicht abfangen; die Lautstärke wird über die App geregelt.

## Projektstruktur

| Ordner | Inhalt |
|--------|--------|
| `shared/` | Nachrichtenprotokoll Handy ↔ PC, Kopplungs-Link |
| `extension/` | Chrome-Extension (Manifest V3, TypeScript, esbuild) |
| `remote/` | Handy-App (PWA, Preact, Vite) |
| `tests/unit/` | Unit-Tests (Vitest) |
| `tests/e2e/` | End-to-End-Test: echte Extension + Handy-App + lokaler PeerJS-Server + nachgebaute Netflix-Seite |

## Entwicklung

```bash
npm install
npm run typecheck
npm test              # Unit-Tests
npm run build         # extension/dist + remote/dist
npm run test:e2e      # braucht vorher npm run build
npm run dev:remote    # Handy-App lokal (im WLAN erreichbar)
```

Ursprünglich ein Fork von [butttons/netflix-remote](https://github.com/butttons/netflix-remote) (MIT).
