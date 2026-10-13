#!/bin/bash
# Double-click in Finder to set up Agent Orrery: installs what it needs, adds
# ~/Applications/Agent Orrery.app, and opens the app. Run it again after moving this folder.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Agent Orrery needs Node.js 22.12 or newer. Install it from https://nodejs.org, then run this again."
  read -r -p "Press Return to close. "
  exit 1
fi
if ! node scripts/setup.mjs "$@"; then
  echo
  read -r -p "Setup did not finish. The messages above say why. Press Return to close. "
  exit 1
fi
