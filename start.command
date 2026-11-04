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

if [ ! -d node_modules ]; then
  echo "Installing for the first time, this takes a minute..."
  npm install --no-fund --no-audit || { echo "Installing failed. Check your internet connection."; read -r -p "Press Enter to close."; exit 1; }
fi

OPEN=1 node src/server.js
