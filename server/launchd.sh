#!/usr/bin/env bash
# Run the scribe server on a Mac in the background, started at login and restarted if it stops (a launchd user agent).
#
#   server/launchd.sh install     write ~/Library/LaunchAgents/dev.scribe.server.plist and start it
#   server/launchd.sh uninstall   stop it and remove the agent
#   server/launchd.sh status      whether it's running, and the end of its log
#
# The agent runs server/run.sh from this checkout. launchd starts programs with a bare PATH, so install records where
# uv is, along with any SCRIBE_* and HF_* settings in your environment at that moment (e.g. SCRIBE_PORT, HF_HOME).
# The log is ~/Library/Logs/scribe.log.
set -euo pipefail
label=dev.scribe.server
plist=$HOME/Library/LaunchAgents/$label.plist
log=$HOME/Library/Logs/scribe.log
here=$(cd "$(dirname "$0")" && pwd)
target=gui/$(id -u)

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

case "${1:-}" in
install)
  uv=$(command -v uv) || { echo "uv not found: install it first (brew install uv)" >&2; exit 1; }
  env_xml="<key>PATH</key><string>$(xml "$(dirname "$uv"):/usr/bin:/bin:/usr/sbin:/sbin")</string>"
  while IFS='=' read -r k v; do
    env_xml+="<key>$k</key><string>$(xml "$v")</string>"
  done < <(env | grep -E '^(SCRIBE|HF)_[A-Z0-9_]*=' || true)
  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$(xml "$here/run.sh")</string></array>
  <key>EnvironmentVariables</key><dict>$env_xml</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log")</string>
</dict></plist>
EOF
  plutil -lint -s "$plist"
  launchctl bootout "$target/$label" 2>/dev/null || true
  launchctl bootstrap "$target" "$plist"
  echo "installed: scribe starts at login; log in $log" ;;
uninstall)
  launchctl bootout "$target/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "removed" ;;
status)
  if launchctl print "$target/$label" >/dev/null 2>&1; then
    launchctl print "$target/$label" | grep -m3 -E '^\s+(state|pid|last exit code) ='
  else
    echo "not installed"
  fi
  [ -f "$log" ] && tail -n 5 "$log" ;;
*)
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1 ;;
esac
