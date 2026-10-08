#!/usr/bin/env bash
# Pull the stretching backups from the server:
#   server Stretching.md         ->  notes Stretching.md   (read-only backup)
#   server stretching.sqlite     ->  local snapshot        (full restorable backup)
# Settings (environment, e.g. via a systemd drop-in, see README):
#   STRETCHING_NOTES_DIR   folder for Stretching.md      (default ~/Documents/Stretching)
#   STRETCHING_BACKUP_DIR  where database snapshots go   (default ~/.local/share/stretching-tracker)
#   STRETCHING_HOST        SSH host alias of the server  (default simonsmind)
set -euo pipefail
NOTES="${STRETCHING_NOTES_DIR:-$HOME/Documents/Stretching}"
BACKUP="${STRETCHING_BACKUP_DIR:-$HOME/.local/share/stretching-tracker}"
HOST="${STRETCHING_HOST:-simonsmind}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)

"${SSH[@]}" "$HOST" test -f stretching-data/stretching.sqlite || exit 0   # nothing logged yet

if "${SSH[@]}" "$HOST" test -f stretching-data/Stretching.md; then
  mkdir -p "$NOTES"
  rsync -t --checksum -e "${SSH[*]}" "$HOST:stretching-data/Stretching.md" "$NOTES/Stretching.md"
fi

# VACUUM INTO makes a consistent copy even if a session is being saved right now
"${SSH[@]}" "$HOST" 'cd stretching-data && rm -f snapshot.sqlite &&
  php -r "(new PDO(\"sqlite:stretching.sqlite\"))->exec(\"VACUUM INTO \x27snapshot.sqlite\x27\");"'
mkdir -p "$BACKUP"
rsync -t -e "${SSH[*]}" "$HOST:stretching-data/snapshot.sqlite" "$BACKUP/stretching.sqlite"
cp -n "$BACKUP/stretching.sqlite" "$BACKUP/stretching-$(date +%F).sqlite"
find "$BACKUP" -name 'stretching-*.sqlite' -mtime +30 -delete
