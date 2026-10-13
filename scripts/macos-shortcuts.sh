#!/usr/bin/env bash
# Install or remove a per-user macOS app bundle that launches Agent Orrery
# from Launchpad, Spotlight, or the Dock without a terminal window.
#
#   bash scripts/macos-shortcuts.sh install
#   bash scripts/macos-shortcuts.sh uninstall
#
# The bundle is a thin launcher in ~/Applications that execs the Electron binary
# already installed under node_modules with this repository as its argument.
# It does not copy the app, touch system directories, or register login items.
set -euo pipefail

ACTION="${1:-install}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Agent Orrery"
APP_DIR="${HOME}/Applications/${APP_NAME}.app"
ELECTRON="${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

case "$(uname -s)" in
  Darwin) ;;
  *) echo "This script only supports macOS. On Windows use scripts/windows-shortcuts.ps1." >&2; exit 1 ;;
esac

install_bundle() {
  if [[ ! -x "${ELECTRON}" ]]; then
    echo "Electron is missing at ${ELECTRON}. Run 'npm install' in ${REPO_ROOT} first." >&2
    exit 1
  fi
  if [[ -e "${APP_DIR}" && ! -f "${APP_DIR}/Contents/.agent-orrery" ]]; then
    echo "Refusing to replace ${APP_DIR}: it was not created by this script." >&2
    exit 1
  fi

  mkdir -p "${APP_DIR}/Contents/MacOS"
  cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>ai.digitalbyte.agent-orrery.launcher</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

  # The launcher records the absolute paths at install time so it keeps working
  # from Spotlight, where no shell profile or working directory is available.
  # Paths are shell-quoted so spaces, quotes, backticks, or $ never re-expand.
  local quoted_repo quoted_electron
  quoted_repo="$(printf '%q' "${REPO_ROOT}")"
  quoted_electron="$(printf '%q' "${ELECTRON}")"
  {
    printf '#!/bin/bash\n'
    printf 'cd %s || exit 1\n' "${quoted_repo}"
    printf 'exec %s %s\n' "${quoted_electron}" "${quoted_repo}"
  } > "${APP_DIR}/Contents/MacOS/launch"
  chmod 755 "${APP_DIR}/Contents/MacOS/launch"
  : > "${APP_DIR}/Contents/.agent-orrery"
  touch "${APP_DIR}"
  echo "Installed ${APP_DIR}"
  echo "Open it from ~/Applications, Launchpad, or Spotlight. Re-run after moving the repository."
}

uninstall_bundle() {
  if [[ ! -e "${APP_DIR}" ]]; then
    echo "Nothing to remove at ${APP_DIR}"
    exit 0
  fi
  if [[ ! -f "${APP_DIR}/Contents/.agent-orrery" ]]; then
    echo "Refusing to remove ${APP_DIR}: it was not created by this script." >&2
    exit 1
  fi
  rm -rf "${APP_DIR}"
  echo "Removed ${APP_DIR}"
}

case "${ACTION}" in
  install) install_bundle ;;
  uninstall) uninstall_bundle ;;
  *) echo "Usage: $0 [install|uninstall]" >&2; exit 2 ;;
esac
