#!/bin/bash
# Couch Remote: updates this folder to the latest release on GitHub.
# Linux: run it (bash update.sh, or double-click if the file manager offers "Ausführen").
# Mac: double-click update.command, which runs this script.
# Chrome notices the new files on its own and reloads the extension.
# Wrapped in { … exit; } so bash reads the whole script before running it: the update replaces this file.
{
set -euo pipefail
cd "$(dirname "$0")"

REPO="MacBuchi/netflix-remote"
fail() { echo; echo "Update fehlgeschlagen: $1"; echo; read -r -p "Enter zum Schließen … " _ || true; exit 1; }

for tool in curl unzip; do
    command -v "$tool" >/dev/null || fail "$tool fehlt – bitte installieren (z. B. sudo apt install $tool)."
done
grep -q '"name": "Couch Remote"' manifest.json 2>/dev/null || fail "Dieses Skript gehört in den Ordner der Extension (neben manifest.json)."
installed=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)

echo "Couch Remote – installiert: $installed"
echo "Suche die neueste Version auf GitHub …"
# github.com/…/releases/latest redirects to …/tag/v<version>; unlike the API it has no hourly limit.
page=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || fail "GitHub nicht erreichbar."
latest=$(printf '%s' "$page" | sed -n 's|.*/releases/tag/v\{0,1\}\([0-9][0-9.]*\)$|\1|p')
[ -n "$latest" ] || fail "Keine Version zum Herunterladen gefunden."
zip="https://github.com/$REPO/releases/download/v$latest/couch-remote-v$latest.zip"

if [ "$latest" = "$installed" ]; then
    echo "Schon aktuell."
else
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    echo "Lade Version $latest …"
    curl -fsSL "$zip" -o "$tmp/update.zip" || fail "Download fehlgeschlagen."
    unzip -q "$tmp/update.zip" -d "$tmp/new" || fail "ZIP ließ sich nicht entpacken."
    grep -q '"name": "Couch Remote"' "$tmp/new/manifest.json" 2>/dev/null || fail "Das ZIP enthält keine Couch-Remote-Extension."
    # Everything else first, the manifest last: its new version is what makes Chrome reload.
    (cd "$tmp/new" && find . -type f ! -name manifest.json) | while read -r f; do
        mkdir -p "$(dirname "$f")" && cp "$tmp/new/$f" "$f"
    done
    cp "$tmp/new/manifest.json" manifest.json
    chmod +x update.sh update.command 2>/dev/null || true
    echo "Fertig: Version $latest. Chrome lädt Couch Remote innerhalb einer Minute neu (sofort beim Öffnen des Popups)."
fi
echo
read -r -t 10 -p "Das Fenster schließt sich gleich … " _ || true
echo
exit 0
}
