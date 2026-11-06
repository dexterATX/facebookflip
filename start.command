#!/bin/bash
# Double-click on a Mac (or run ./start.command on Linux) to start FlipRadar.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Download the \"LTS\" version from https://nodejs.org, install it, then run this again."
  echo
  (open "https://nodejs.org/" || xdg-open "https://nodejs.org/") >/dev/null 2>&1
  read -r -p "Press Enter to close."
  exit 1
fi

# Install on the first run, and again after an update changes the app's libraries.
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "Installing (first run or after an update), this takes a minute..."
  npm install --no-fund --no-audit || { echo "Installing failed. Check your internet connection."; read -r -p "Press Enter to close."; exit 1; }
fi

# Reading past the first 24 results needs a browser: use an installed one, or get Chromium once.
node tools/ensure-browser.js

OPEN=1 node src/server.js
