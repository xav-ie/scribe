#!/usr/bin/env bash
# Run the scribe server on a Mac in the background, started at login and restarted if it stops (a launchd user agent).
#
#   server/launchd.sh install [--cleanup [MODEL]]
#                                           write the agent to ~/Library/LaunchAgents and start it; --cleanup also
#                                           runs the cleanup model (models/cleanup/serve_mlx.py; MODEL is a Hugging
#                                           Face name or a folder, xav-ie/scribe-cleanup-mlx-4bit by default) as a
#                                           second agent and turns on cleanup in the server
#   server/launchd.sh uninstall             stop the agents and remove them
#   server/launchd.sh status                whether they're running, and the end of their logs
#
# The agents run from this checkout. launchd starts programs with a bare PATH, so install records where uv is, along
# with any SCRIBE_* and HF_* settings in your environment at that moment (e.g. SCRIBE_PORT, HF_HOME). The logs are
# ~/Library/Logs/scribe.log and scribe-cleanup.log.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
target=gui/$(id -u)
cleanup_port=8080

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
plist() { echo "$HOME/Library/LaunchAgents/$1.plist"; }
log() { echo "$HOME/Library/Logs/$1.log"; }

# agent LABEL LOGNAME ENV_XML PROGRAM [ARGS...]
agent() {
  local label=$1 logfile p args=""
  logfile=$(log "$2")
  p=$(plist "$label")
  local env_xml=$3
  shift 3
  for a in "$@"; do args+="<string>$(xml "$a")</string>"; done
  mkdir -p "$(dirname "$p")" "$(dirname "$logfile")"
  cat >"$p" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>EnvironmentVariables</key><dict>$env_xml</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$logfile")</string>
  <key>StandardErrorPath</key><string>$(xml "$logfile")</string>
</dict></plist>
EOF
  plutil -lint -s "$p"
  launchctl bootout "$target/$label" 2>/dev/null || true
  launchctl bootstrap "$target" "$p"
}

remove() {
  launchctl bootout "$target/$1" 2>/dev/null || true
  rm -f "$(plist "$1")"
}

case "${1:-}" in
install)
  uv=$(command -v uv) || { echo "uv not found: install it first (brew install uv)" >&2; exit 1; }
  env_xml="<key>PATH</key><string>$(xml "$(dirname "$uv"):/usr/bin:/bin:/usr/sbin:/sbin")</string>"
  while IFS='=' read -r k v; do
    env_xml+="<key>$k</key><string>$(xml "$v")</string>"
  done < <(env | grep -E '^(SCRIBE|HF)_[A-Z0-9_]*=' || true)
  if [ "${2:-}" = --cleanup ]; then
    agent dev.scribe.cleanup scribe-cleanup "$env_xml" "$here/../models/cleanup/serve_mlx.py" \
      --model "${3:-xav-ie/scribe-cleanup-mlx-4bit}" --port "$cleanup_port"
    [ -n "${SCRIBE_CLEANUP_URL:-}" ] || env_xml+="<key>SCRIBE_CLEANUP_URL</key><string>http://127.0.0.1:$cleanup_port/v1</string>"
    echo "installed: the cleanup model starts at login; log in $(log scribe-cleanup)"
  else
    remove dev.scribe.cleanup
  fi
  agent dev.scribe.server scribe "$env_xml" "$here/run.sh"
  echo "installed: scribe starts at login; log in $(log scribe)" ;;
uninstall)
  remove dev.scribe.server
  remove dev.scribe.cleanup
  echo "removed" ;;
status)
  for label in dev.scribe.server dev.scribe.cleanup; do
    if launchctl print "$target/$label" >/dev/null 2>&1; then
      echo "$label:"
      launchctl print "$target/$label" | grep -m3 -E '^\s+(state|pid|last exit code) ='
    else
      echo "$label: not installed"
    fi
  done
  for f in "$(log scribe)" "$(log scribe-cleanup)"; do
    [ -f "$f" ] && { echo "--- $f"; tail -n 5 "$f"; }
  done
  true ;;
*)
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1 ;;
esac
