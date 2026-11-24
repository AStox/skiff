#!/usr/bin/env bash
# Dev helper: push this repo to the Mac enrolled in bb and pull screenshots back.
#   mac.sh push [since]              copy HEAD to ~/skiff on the Mac (keeps node_modules), or only files changed since a commit
#   mac.sh run '<sh script>'         run a script on the Mac in ~/skiff
#   mac.sh put <local> <remote>      copy one small file
#   mac.sh fetch <remote> <local>    pull an image back as a JPEG, longest side 1400
#   mac.sh shot <remote.png> <pid>   capture only the window of that Skiff process on the Mac
#   mac.sh logs [lines] [grep]       last lines (default 2000) of ~/Library/Logs/Skiff/skiff.log; grep is a case-insensitive extended regex
#   mac.sh logs-fetch <local-dir>    pull the current skiff.log (last 1.2 MB gzipped at most) to <local-dir>/skiff.log
set -euo pipefail
MACHINE=${SKIFF_MAC:-Work Macbook}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mac() { bb terminal run --machine "$MACHINE" --title "skiff dev" --timeout "${T:-60}" --max-output-bytes 2000000 -- sh -c "$@"; }

# bb caps a command at 10,000 characters, so files travel as base64 in chunks.
put() {
  local tmp; tmp=$(mktemp -d)
  base64 -w0 "$1" | split -b 8000 - "$tmp/part."
  mac 'rm -f "$1.b64"' _ "$2" >/dev/null
  # The bb tunnel drops a request now and then; a chunk that failed was not appended, so it is safe to resend.
  for part in "$tmp"/part.*; do
    for try in 1 2 3 4 5; do mac 'printf %s "$2" >> "$1.b64"' _ "$2" "$(cat "$part")" >/dev/null && break; [ "$try" = 5 ] && exit 1; sleep 2; done
  done
  mac 'base64 -D -i "$1.b64" -o "$1" && rm -f "$1.b64" && shasum -a 256 "$1" | cut -c1-64' _ "$2"
  sha256sum "$1" | cut -c1-64
  rm -rf "$tmp"
}

case ${1:-} in
  push)
    tgz=$(mktemp /tmp/skiff-src-XXXX.tgz)
    # mac.sh push <since-commit> sends only files changed since then; deleted files still need removing by hand.
    if [ -n "${2:-}" ]; then git -C "$ROOT" archive --format=tar.gz -o "$tgz" HEAD $(git -C "$ROOT" diff --name-only --diff-filter=AMR "$2" HEAD)
    else git -C "$ROOT" archive --format=tar.gz -o "$tgz" HEAD; fi
    put "$tgz" /tmp/skiff-src.tgz
    rm -f "$tgz"
    mac 'mkdir -p ~/skiff && tar -xzf /tmp/skiff-src.tgz -C ~/skiff && rm /tmp/skiff-src.tgz && cd ~/skiff && npm install --no-fund --no-audit 2>&1 | tail -1'
    ;;
  run) mac "cd ~/skiff && $2" ;;
  put) put "$2" "$3" ;;
  fetch)
    out=$(mac 'sips -Z 1400 -s format jpeg -s formatOptions 70 "$1" --out /tmp/skiff-fetch.jpg >/dev/null 2>&1 && echo BEGIN64 && base64 -b 120 -i /tmp/skiff-fetch.jpg && echo END64; rm -f /tmp/skiff-fetch.jpg' _ "$2")
    printf '%s\n' "$out" | sed -n '/^BEGIN64/,/^END64/p' | sed '1d;$d' | tr -d '\r\n ' | base64 -d > "$3"
    ls -la "$3"
    ;;
  shot)
    mac 'cat > /tmp/skiff-wid.swift <<"EOF"
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
let pid = Int(CommandLine.arguments[1])!
for w in list where (w["kCGWindowOwnerPID"] as? Int) == pid && (w["kCGWindowLayer"] as? Int) == 0 { print(w["kCGWindowNumber"] as! Int) }
EOF
wid=$(swift /tmp/skiff-wid.swift "$2" 2>/dev/null | head -1); rm -f /tmp/skiff-wid.swift; screencapture -x -o -l"$wid" "$1" && ls -la "$1"' _ "$2" "$3"
    ;;
  logs)
    # The grep pattern travels as a positional argument, never inside the script text.
    n=${2:-2000}; case $n in ''|*[!0-9]*) echo "lines must be a number" >&2; exit 2 ;; esac
    mac 'n=$1; g=$2; d=~/Library/Logs/Skiff; f=$d/skiff.log
[ -f "$f" ] || { echo "no Skiff log at $f (the installed Skiff predates logging, or never ran)"; exit 0; }
need=$n; set --
for x in "$f" "$d/skiff.1.log" "$d/skiff.2.log" "$d/skiff.3.log" "$d/skiff.4.log"; do
  [ -f "$x" ] || continue
  set -- "$x" "$@"; need=$((need - $(wc -l < "$x"))); [ "$need" -le 0 ] && break
done
if [ -n "$g" ]; then cat "$@" | tail -n "$n" | grep -iE -- "$g" | tail -c 1900000
else cat "$@" | tail -n "$n" | tail -c 1900000; fi' _ "$n" "${3:-}"
    ;;
  logs-fetch)
    [ -n "${2:-}" ] || { sed -n '2,9p' "$0"; exit 2; }
    out=$(mac 'f=~/Library/Logs/Skiff/skiff.log
[ -f "$f" ] || { echo "no Skiff log at $f (the installed Skiff predates logging, or never ran)"; exit 0; }
t=$(mktemp /tmp/skiff-logs.XXXXXX); total=$(wc -l < "$f"); n=$total
while :; do
  tail -n "$n" "$f" | gzip -c > "$t"
  [ "$(wc -c < "$t")" -le 1200000 ] && break
  [ "$n" -le 1 ] && break
  n=$((n / 2))
done
[ "$n" -lt "$total" ] && echo "TRUNCATED $n $total"
echo BEGIN64; base64 -b 120 -i "$t"; echo END64; rm -f "$t"')
    [[ $out == *BEGIN64* ]] || { printf '%s\n' "$out"; exit 0; }
    mkdir -p "$2"
    printf '%s\n' "$out" | sed -n '/^BEGIN64/,/^END64/p' | sed '1d;$d' | tr -d '\r\n ' | base64 -d | gunzip > "$2/skiff.log"
    t=$(printf '%s\n' "$out" | tr -d '\r' | sed -n 's/^TRUNCATED \([0-9]*\) \([0-9]*\)$/\1 of \2/p')
    [ -z "$t" ] || echo "skiff.log was too big for one transfer: kept the last $t lines" >&2
    ls -la "$2/skiff.log"
    ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
