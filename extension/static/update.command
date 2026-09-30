#!/bin/bash
# Couch Remote update for Mac: double-click. The first time macOS blocks it (not signed by Apple):
# System Settings → Privacy & Security → "Open Anyway". Or run update.sh from the Terminal instead.
exec bash "$(dirname "$0")/update.sh"
