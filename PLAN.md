# Plan: Netflix-Fernbedienung (Player + Film-Browser) vom Android-Handy

Ziel: Netflix läuft im Browser auf PC/Mac. Das Android-Handy (meist im selben WLAN)
steuert nicht nur den Player (Play/Pause, Spulen, Lautstärke, Untertitel …), sondern
auch den **Katalog**: Zeilen durchblättern, Titel ansehen, suchen, Profil wählen und
einen Film/eine Folge starten.

> **Stand (Version 2.2.10):** Phasen 0–3 sind umgesetzt und mit echtem Netflix getestet (Kopplung,
> Relay im Hotel-WLAN, Player, Film-Browser mit Bildern, Vorschau, Suche und Bereichen). Offen sind
> nur noch optionale Punkte, siehe [Abschnitt 5](#5-umsetzung-in-phasen). Wo die Umsetzung vom
> ursprünglichen Plan abweicht, ist es in den Abschnitten vermerkt.

---

## 1. Ausgangslage vor dem Neuaufbau

Das Repo ist ein Fork von `butttons/netflix-remote` (Stand 2019):

| Teil | Inhalt | Zustand |
|------|--------|---------|
| `ext/` | Chrome-Extension, **Manifest V2**, Content-Script baut per `simple-peer` eine WebRTC-Verbindung auf | MV2 läuft in aktuellem Chrome nicht mehr |
| `broker/` | Socket.io-Signaling-Server (lowdb), gehostet auf `netflix-signal.herokuapp.com` | Heroku-Free-Tier gibt es seit 2022 nicht mehr → Server tot |
| `ui/` | Handy-Web-App (Parcel 1, QR-Scanner via `jsqr`), deployt nach `docs/` (GitHub Pages) | Parcel 1 veraltet, UI nur 5 Buttons |
| Player-Steuerung | Klicks auf CSS-Klassen wie `.button-nfplayerPlay` | Klassen existieren im aktuellen Netflix-Player nicht mehr |
| QR-Code | `chart.googleapis.com` | Google Chart QR-API ist abgeschaltet |

Bekannte Schwächen laut README: Verbindung bricht bei jedem Reload ab, kein Wiederverbinden,
kein Browser-Support, nur ein Handvoll Player-Aktionen.

**Fazit:** Die Idee (Extension + Handy-Web-App + WebRTC) ist richtig, aber praktisch
jede Komponente muss neu geschrieben werden. Wir behalten die Grundarchitektur und
bauen sie modern neu auf.

---

## 2. Recherche: Wege, die es gibt

### 2.1 Wie kommt man an Netflix im Browser heran?

Nur über eine **Browser-Extension** (Content-Script im Netflix-Tab). Netflix hat keine
öffentliche API, und die Fernsteuerungs-Protokolle (DIAL/Cast, „Netflix MDX“) funktionieren
nur für TV-Geräte, nicht für netflix.com im Desktop-Browser.

Innerhalb der Seite gibt es zwei Ebenen:

1. **Interne Player-API** (wird von vielen Extensions genutzt, z. B. Untertitel-Tools):
   ```js
   const vp = netflix.appContext.state.playerApp.getAPI().videoPlayer;
   const player = vp.getVideoPlayerBySessionId(vp.getAllPlayerSessionIds()[0]);
   player.play(); player.pause(); player.seek(ms); player.setVolume(0.5);
   player.getCurrentTime(); player.getDuration(); player.isPaused();
   player.getAudioTrackList(); player.getTimedTextTrackList(); player.setTimedTextTrack(t);
   ```
   Wichtig: `video.currentTime` direkt zu setzen lässt den Netflix-Player abstürzen –
   Spulen muss über `player.seek()` laufen. Das `netflix`-Objekt lebt im Seitenkontext,
   deshalb braucht es ein Script in der **MAIN world** (MV3: `"world": "MAIN"`).
2. **DOM**: Netflix setzt stabile, sprachunabhängige `data-uia`-Attribute, z. B.
   `[data-uia="player-skip-intro"]`, `[data-uia="next-episode-seamless-button"]`.
   Die sind deutlich robuster als CSS-Klassen und werden von allen Auto-Skip-Extensions
   genutzt. Für den Katalog nutzen wir Links (`a[href*="/watch/"]`, `a[href*="/title/"]`),
   `aria-label` und Boxart-`<img>`.

### 2.2 Wie kommt das Handy an die Extension heran?

Eine Extension kann **keinen Port im LAN öffnen**. Daher gibt es drei Varianten:

| Variante | Wie | + | − |
|----------|-----|---|---|
| **A. WebRTC-Datenkanal** (wie heute) | Extension und Handy-Web-App tauschen per kleinem Signaling-Server Verbindungsdaten, danach direkt P2P | Nur Extension installieren; funktioniert im WLAN *und* unterwegs; Handy-App über HTTPS → als PWA installierbar | Braucht einen (winzigen) Signaling-Dienst im Internet |
| **B. Lokaler Hilfsserver + Native Messaging** (so macht es z. B. `Lmjfemc/netflix_remote_extension` mit einem Go-Binary) | Kleines Programm auf PC/Mac öffnet `http://<PC-IP>:8787`, spricht per Native Messaging mit der Extension | Kein Internet-Dienst nötig, rein lokal | Zusätzliche Installation pro Rechner (Mac + Windows Binaries, Registry/Manifest für Native Host), nur HTTP → keine vollwertige PWA, IP ändert sich |
| **C. Reines Cloud-Relay** | Beide verbinden sich per WebSocket mit einem Relay, alle Befehle laufen darüber | Am einfachsten | Jeder Tastendruck geht über den Server |

**Entscheidung: Variante A** mit dem **öffentlichen PeerJS-Server** als Vermittler – kein Konto,
kein eigener Server, keine Zusatzinstallation. Er vermittelt nur den Verbindungsaufbau; danach
laufen die Befehle direkt per WebRTC, im selben WLAN also rein lokal. Der Vermittler ist
konfigurierbar (eigener `peerjs`-Server oder später ein Cloudflare Worker). Variante B bleibt
optional für „komplett ohne Internet“; das Protokoll (Abschnitt 4) ist transportunabhängig.

### 2.3 Manifest V3 und WebRTC

- MV3-Service-Worker haben **kein** `RTCPeerConnection`.
- Lösung: **Offscreen Document** (`chrome.offscreen`, Grund `WEB_RTC`). Das ist eine
  unsichtbare Extension-Seite, die dauerhaft leben darf.
- Riesenvorteil gegenüber heute: Die Verbindung hängt **nicht mehr am Netflix-Tab**.
  Reload, Seitenwechsel, sogar Tab schließen/neu öffnen → Handy bleibt verbunden.
  Das behebt den Hauptmangel aus dem README.

### 2.4 Browser-Einschränkungen, die man kennen muss

- **Vollbild:** `requestFullscreen()` braucht eine echte Nutzergeste – vom Handy aus nicht
  möglich. Workaround: `chrome.windows.update(winId, { state: "fullscreen" })` aus der
  Extension. Netflix füllt das Fenster ohnehin aus → wirkt wie Vollbild.
- **Autoplay:** Nach Navigation zu `/watch/…` startet Netflix die Wiedergabe normalerweise
  selbst (hohe Media-Engagement-Wertung der Seite). Falls Chrome blockiert: Fallback
  `chrome.debugger` → `Input.dispatchKeyEvent` erzeugt „echte“ Tastendrücke (zeigt aber
  kurz eine gelbe „wird debuggt“-Leiste). Nur als Notlösung.
- **Browser:** Zuerst Chromium (Chrome, Edge, Brave, Arc – deckt Win + Mac ab).
  Firefox ist per MV3 später gut machbar (Offscreen gibt es dort nicht, aber Background-Pages
  haben WebRTC). Safari nur mit Xcode-Wrapper – vorerst nicht.

### 2.5 Bestehende Projekte (zur Orientierung)

- `butttons/netflix-remote` – Ursprung dieses Forks (nur Player).
- `Lmjfemc/netflix_remote_extension` – LAN-Remote mit Go-Hilfsserver + Native Messaging,
  inkl. Browse/Suche/Seek. Gute Referenz für Variante B.
- `FThompson/NetflixController` – Gamepad-Steuerung des Netflix-Browsers
  (Billboard, Zeilen/„Slider“, „Jawbone“-Detailansicht). Gute Referenz für die
  D-Pad-Navigation (Abschnitt 3.3, Modus 2). Stand 2020.
- `nikwhite/netflix-controller` – LAN-Remote von 2015, veraltet.

---

## 3. Zielbild

> **Umgesetzt** wurde es mit dem öffentlichen PeerJS-Vermittler statt eines Cloudflare Workers und mit
> einem verschlüsselten MQTT-Relay als Fallback (siehe 2.2):
>
> ![Aufbau](docs/img/architecture.svg)
>
> Ursprünglicher Entwurf:

```
 Android (Chrome, PWA)                 Cloudflare Worker            PC/Mac (Chrome)
 ┌──────────────────────┐   Signaling  ┌──────────────┐  Signaling  ┌─────────────────────────────┐
 │ Remote-App            │◄───────────►│ Pairing +    │◄───────────►│ Extension (MV3)              │
 │ - Katalog / Suche     │             │ SDP-Tausch   │             │  service worker: Tabs,       │
 │ - Player-Steuerung    │             │ (+ Relay)    │             │   Fenster, Offscreen starten │
 │ - D-Pad-Modus         │             └──────────────┘             │  offscreen.html: WebRTC      │
 └──────────▲────────────┘                                          │  content.js (isolated):      │
            │        WebRTC-Datenkanal (P2P, im WLAN direkt)        │   Katalog scrapen, Navigation│
            └──────────────────────────────────────────────────────►│  page.js (MAIN world):       │
                                                                    │   netflix Player-API         │
                                                                    └─────────────────────────────┘
```

### 3.1 Pairing (einmalig)

1. Extension-Popup zeigt QR-Code (lokal erzeugt, z. B. `qrcode`-Lib, kein Google-Dienst)
   mit `roomId` + geheimem `pairKey`.
2. Handy scannt (Kamera-QR via `BarcodeDetector`-API bzw. `jsQR`-Fallback), speichert beides.
3. Ab dann **automatisches Wiederverbinden**: Beide Seiten melden sich beim Start mit
   `roomId` beim Worker an; Nachrichten werden mit HMAC(`pairKey`) signiert, damit nur
   gekoppelte Geräte steuern können. Mehrere Rechner (PC *und* Mac) = mehrere gespeicherte
   Kopplungen, Auswahl in der App.

*Umgesetzt:* Der QR-Code enthält Peer-ID, Schlüssel, Rechnername und die Serveradressen im `#`-Teil
des Links (`buildPairingUrl`). Das Handy meldet sich mit `hello` und dem Schlüssel; ohne passenden
Schlüssel verwirft die Extension alles. Über den Relay ist jede Nachricht mit einem aus dem Schlüssel
abgeleiteten AES-GCM-Schlüssel verschlüsselt, auch die MQTT-Themen leiten sich daraus ab.

### 3.2 Player-Fernbedienung

Status wird vom PC ans Handy **gestreamt** (z. B. 1×/s und bei Änderungen):
Titel, Folge (S2:E5), Position/Dauer, Pause-Zustand, Lautstärke, Tonspuren, Untertitel,
ob „Intro überspringen“/„Nächste Folge“ gerade sichtbar ist.

Aktionen:
- Play/Pause, ±10 s, Seek-Slider (über `player.seek`)
- Lautstärke / Stumm
- Intro/Rückblick überspringen, nächste Folge (`data-uia`-Buttons)
- Tonspur & Untertitel wählen (Player-API)
- Folgenliste der Staffel anzeigen und direkt springen
- Vollbild an/aus (Fenster-Fullscreen), zurück zum Katalog
- Optional: Wiedergabegeschwindigkeit

### 3.3 Film-Browser – zwei Modi

**Modus 1 „Katalog auf dem Handy“ (Hauptmodus, beste Bedienung)**
Die Extension liest aus, was Netflix auf der Browse-Seite rendert, und schickt es als
strukturierte Daten ans Handy. Das Handy zeigt eine eigene, touch-optimierte Oberfläche:

- Zeilen („Weiterschauen“, „Meine Liste“, „Trends“ …) mit Boxart-Bildern
  (Bild-URLs vom Netflix-CDN lädt das Handy direkt)
- Lazy Loading: Netflix rendert Zeilen erst beim Scrollen → Extension scrollt im
  Hintergrund-Tab nach und liefert weitere Zeilen nach; Zeilen-Pfeile für mehr Titel
- Titel antippen → Detail (Beschreibung, Staffeln/Folgen aus der `/title/<id>`-Ansicht)
- „Abspielen“ → Extension navigiert den PC-Tab zu `/watch/<id>`
- Suche: Eingabe auf Handy-Tastatur → Extension lädt `/search?q=…` und liefert Ergebnisse
- Profilauswahl (`/browse` Profil-Gate) und Kategorien (Serien, Filme, Meine Liste)
- „Zu Meine Liste hinzufügen“ über den entsprechenden Button

Technisch: Adapter-Schicht `netflix-adapter` mit allen Selektoren an **einer** Stelle,
bevorzugt `data-uia`, Links und `aria-label`, nie Styling-Klassen. Wenn Netflix das DOM
ändert, muss nur diese Datei angepasst werden.

*Ausbaustufe (optional, später):* Netflix lädt Katalogdaten intern über seine
Falcor/„Shakti“-Pfad-API (`pathEvaluator`). Darüber ließen sich Zeilen ohne Scrollen
laden. Das ist schneller, aber undokumentiert und noch fragiler – erst angehen, wenn
Scraping an Grenzen stößt.

**Modus 2 „D-Pad“ (Fallback, funktioniert überall)**
Handy zeigt Steuerkreuz + OK + Zurück wie eine TV-Fernbedienung. Die Extension hält einen
eigenen „Fokus“ auf dem PC (hervorgehobener Rahmen), bewegt ihn über Zeilen/Kacheln und
klickt bei OK. Nützlich für alles, was Modus 1 (noch) nicht abdeckt, z. B. Dialoge,
neue Netflix-Layouts. Referenz: `FThompson/NetflixController`.

Optional zusätzlich: Touchpad-/Mausmodus (Handy als Trackpad → `chrome.debugger`
Mausevents) – nur falls wirklich benötigt.

### 3.4 Handy-App

- **PWA** auf GitHub Pages (`docs/` bleibt Deploy-Ziel) → „Zum Startbildschirm hinzufügen“,
  läuft im Vollbild, keine App-Store-Installation.
- Stack: Vite + TypeScript + ein leichtes UI-Framework (Preact oder Svelte), dunkles
  Netflix-ähnliches Design, große Touch-Ziele, Haptik (`navigator.vibrate`).
- Bildschirm-an halten während der Bedienung (`Wake Lock API`).
- **Später optional native Android-Hülle** (Capacitor/TWA) für Dinge, die eine PWA nicht
  kann: Lautstärke-Tasten des Handys als Fernbedienung, Media-Benachrichtigung auf dem
  Sperrbildschirm. Ist kein Muss für Version 1.

---

## 4. Nachrichtenprotokoll (transportunabhängig)

JSON über den Datenkanal (PeerJS mit `serialization: 'binary'`, weil `json` Nachrichten über
~16 KB still verwirft) bzw. verschlüsselt und bei Bedarf in Teile zerlegt über den Relay.
Maßgeblich sind die Typen in `shared/protocol.ts`; alles vom Handy läuft durch `parseCommand`
(Whitelist, unbekannte Felder werden entfernt, Zahlen begrenzt).

```jsonc
// Handy → PC
{ "v":1, "type":"hello", "key":"…", "device":"Pixel 8", "phoneId":"…" }
{ "v":1, "type":"request", "id":"r42", "cmd":{ "type":"player.seekBy", "ms": 10000 } }
{ "v":1, "type":"request", "id":"r43", "cmd":{ "type":"catalog.get", "offset": 0, "limit": 6 } }
{ "v":1, "type":"request", "id":"r44", "cmd":{ "type":"catalog.search", "q": "dark" } }
{ "v":1, "type":"request", "id":"r45", "cmd":{ "type":"catalog.play", "id": "80100172" } }
{ "v":1, "type":"ping" }   // Relay-Keepalive; "bye" beim Beenden

// PC → Handy
{ "v":1, "type":"welcome", "pcName":"Mac" }
{ "v":1, "type":"response", "re":"r43", "ok":true, "data":{ "page":"browse", "rows":[{ "title":"Weiterschauen", "items":[{ "id":"…", "name":"…", "img":"https://…", "progress":0.4 }] }], "totalRows": 12, "profiles":[], "detail":null } }
{ "v":1, "type":"state", "state":{ "page":"watch", "location":"/watch/80100172", "fullscreen":false, "player":{ "title":"…", "subtitle":"S1:E3 · …", "positionMs":512000, "durationMs":2940000, "paused":false, "volume":0.8, "muted":false, "skipLabel":"Intro überspringen", "canNext":false, … } } }
```

Befehle: `player.*` (play, pause, toggle, seekBy, seekTo, setVolume, setMuted, skip, nextEpisode,
setAudioTrack, setTextTrack, exit), `app.*` (fullscreen, openNetflix, browse) und `catalog.*`
(get, loadMore, play, open, episode, season, profile, search, nav, back, debug).

Jede Anfrage bekommt eine Antwort (`ok`/`error`), die App zeigt Fehler verständlich an
(„Netflix-Seite antwortet nicht – bitte neu laden“, „Netflix am PC öffnen“).

---

## 5. Umsetzung in Phasen

**Stand:**

| Phase | Status |
|-------|--------|
| 0 – Aufräumen | ✅ erledigt |
| 1 – Verbindung | ✅ erledigt (PeerJS statt Cloudflare Worker, siehe 2.2) |
| 2 – Player | ✅ erledigt |
| Relay für gesperrte WLANs | ✅ erledigt (verschlüsselter MQTT-Relay parallel zu WebRTC) |
| 3 – Katalog | ✅ erledigt und mit echtem Netflix getestet (Reihen mit Bildern und Fortschritt, Suche, Bereiche mit Markierung, Profile, Details mit Staffeln/Folgen) |
| 4 – D-Pad | ⏭ nur falls der Katalog etwas nicht abdeckt |
| 5 – Feinschliff | ✅ weitgehend: mehrere Rechner, Diagnose in der Handy-App, E2E-Test mit echter Extension und nachgebautem Netflix, automatische Releases |
| 6 – Optional | offen |

Zusätzlich umgesetzt: Bewertungen von IMDb, Rotten Tomatoes und Metacritic über OMDb, mit eigenem Schlüssel
pro Nutzer (Einstellungen in der Handy-App; kein gemeinsamer Schlüssel, kein eigener Server); Zuordnung
Netflix-ID → IMDb-ID über Wikidata. Außerdem: Wiedergabe-Tempo und Ton der Trailer-Vorschauen vom Handy.

**Offen / nächste Schritte:**
- Optional: D-Pad-Modus als Fallback (Phase 4).
- Chrome Web Store: Voraussetzungen erledigt (neutraler Name „Couch Remote“, eigene Farben, Datenschutzseite,
  Lizenzhinweise, Hinweis „nicht mit Netflix verbunden“). Offen: Entwicklerkonto, Store-Eintrag, Store-Upload
  im Release-Workflow. Opera-Nutzer können dann über „Install Chrome Extensions“ installieren.
- Beobachten: Selektoren für den Detaildialog (Staffelwahl) sind am wenigsten erprobt; bei Problemen
  „Diagnose anzeigen“ nutzen und `extension/src/netflix/selectors.ts` anpassen.

| Phase | Inhalt | Ergebnis |
|-------|--------|----------|
| **0 – Aufräumen** | Monorepo-Struktur (`extension/`, `remote-app/`, `signal/`, `shared/` für Protokoll-Typen), TypeScript, Vite, ESLint/Prettier; alten MV2-Code archivieren | Baubares Grundgerüst |
| **1 – Verbindung** | Cloudflare-Worker-Signaling, MV3-Extension mit Offscreen-WebRTC, Pairing per QR, Auto-Reconnect, Ping/Status | Handy zeigt „Verbunden mit Mac/PC“, übersteht Reloads |
| **2 – Player** | `page.js` (MAIN world) mit Player-API, Status-Stream, alle Player-Aktionen aus 3.2, Fenster-Vollbild | Vollwertige Player-Fernbedienung |
| **3 – Katalog** | `netflix-adapter`: Profile, Browse-Zeilen, Titel-Details/Folgen, Suche, Abspielen; Handy-UI mit Zeilen & Detailansicht | Film-Browser auf dem Handy |
| **4 – D-Pad** | Fokus-Navigation auf dem PC als Fallback | Alles erreichbar, auch Unbekanntes |
| **5 – Feinschliff** | PWA-Offline-Shell, Mehrere Rechner, Tests (Playwright gegen gespeicherte Netflix-HTML-Snapshots für den Adapter), Selector-Selbsttest in der Extension („Diagnose“) | Robust im Alltag |
| **6 – Optional** | Firefox-Build, lokaler Native-Messaging-Modus (Variante B), Android-Hülle mit Lautstärke-Tasten, Falcor-Katalog | Nach Bedarf |

Für den Eigengebrauch wird die Extension einfach „entpackt geladen“ (`chrome://extensions`
→ Entwicklermodus). Ein Chrome-Web-Store-Release ist optional; dann „Netflix“ nicht als
Markennamen im Extension-Namen verwenden (z. B. „Couch Remote for Netflix“ o. ä.).

---

## 6. Risiken & Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|--------|---------------|
| Netflix ändert DOM/interne API | Alle Selektoren in einem Adapter, `data-uia` bevorzugen, Fallback-Kette (API → `data-uia`-Button → Tastatur-Event), Diagnose-Seite, Snapshot-Tests |
| Autoplay/Vollbild ohne Nutzergeste blockiert | Fenster-Fullscreen via `chrome.windows`, notfalls `chrome.debugger`-Input |
| P2P-Verbindung scheitert (z. B. Hotel-WLAN mit Client-Isolation) | Automatischer Relay über öffentlichen MQTT-Server, Ende-zu-Ende verschlüsselt; Relay-Server im Popup austauschbar |
| Vermittlungsdienst weg (wie Heroku) | Vermittler im Popup konfigurierbar; `peerjs`-Server ist Open Source und selbst hostbar |
| Sicherheit: Fremde steuern Netflix | Geheimer Pairing-Key, signierte Nachrichten, Befehle nur aus fester Whitelist |
| Nutzungsbedingungen | Nur Steuerung der eigenen Sitzung, kein Umgehen von DRM, keine Video-Übertragung |

---

## 7. Entscheidungen (getroffen)

1. **Browser:** nur Chrome (Chromium-Familie).
2. **Verbindung:** WebRTC über öffentlichen PeerJS-Vermittler; lokal wäre schön, aber Netflix braucht
   ohnehin Internet – ein lokales Hilfsprogramm lohnt den Installationsaufwand nicht.
3. **Lautstärke:** Regler/Tasten in der App. Hardware-Lautstärketasten erfordern eine native
   Android-Hülle → optional in Phase 6.
4. **Technik:** Neuaufbau in TypeScript (esbuild für die Extension, Vite + Preact für die Handy-App).

---

## Quellen

- butttons/netflix-remote – https://github.com/butttons/netflix-remote
- Lmjfemc/netflix_remote_extension (LAN, Go + Native Messaging) – https://github.com/Lmjfemc/netflix_remote_extension
- FThompson/NetflixController (Gamepad-Navigation im Katalog) – https://github.com/FThompson/NetflixController
- nikwhite/netflix-controller – https://github.com/nikwhite/netflix-controller
- Netflix-Player-API (Gist) – https://gist.github.com/JacobRBlomquist/5bf6b046334ed84bac030260a93567ba
- Netflix Seek (Gist) – https://gist.github.com/dimapaloskin/e268e5356df160599244418d256e3f4e
- `data-uia`-Selektoren (Auto-Skip-Extensions) – https://github.com/jdmerinor/NetflixSkip, https://github.com/sajjad-ahmed/netflix-auto-skip
- Offscreen Documents in MV3 – https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3
- `chrome.offscreen` API – https://developer.chrome.com/docs/extensions/reference/api/offscreen
