#!/usr/bin/env bash
# Deploy the app to stretching.simonsmind.com. Needs the `simonsmind` SSH alias.
# Re-encodes new/changed videos from ~/Videos/Stretching-App first (see tools/build-videos.sh).
# The login password is shared with the fitness app (AUTH_FILE in config.php).
set -euo pipefail
cd "$(dirname "$0")"
HOST=simonsmind
WEB=domains/simonsmind.com/public_html/stretching
DATA=stretching-data
AUTH=fitness-data/auth.json

./tools/build-videos.sh
ssh "$HOST" "mkdir -p $WEB $DATA && chmod 700 $DATA && \
  [ -f $WEB/config.php ] || echo '<?php define(\"DATA_DIR\", \"'\$HOME/$DATA'\"); define(\"AUTH_FILE\", \"'\$HOME/$AUTH'\"); define(\"TIMEZONE\", \"$(timedatectl show -p Timezone --value)\");' > $WEB/config.php"
# bump the service-worker cache so phones pick up the new version
sed -i "s/const CACHE = 'stretching-[^']*'/const CACHE = 'stretching-$(date +%s)'/" public/sw.js
rsync -a --delete --exclude config.php public/ "$HOST:$WEB/"
echo "Deployed to https://stretching.simonsmind.com"
