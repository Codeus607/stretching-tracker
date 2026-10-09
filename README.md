# Stretching timer

A small self-hosted stretching routine timer, installable on your phone as a web app (PWA). Pick the stretches you want from the list, press start, and it plays each one's video on a loop for one minute. It tracks the time you stretched per day and per month.

Live instance: https://stretching.simonsmind.com (private, password protected; the password is shared with the fitness tracker).

## How it works

- **The list is the video folder.** Every video in `~/Videos/Stretching-App` is a stretch, named after its file: `Active-Frog.mov` becomes "Active Frog". Add a video, run `./deploy.sh`, and it shows up.
- **Random 10 / 15 min:** picks that many different stretches in random order and ticks them in the list; change them if you like, then press start.
- Tap stretches to pick them; the number shows the order they'll be done in. The selection is remembered on the phone.
- Each stretch gets **5 s to get ready** (the video already shows it), then **a chime and 1 minute** with the video looping. A double chime ends the session. Pause, skip and end are always available. The screen stays on during a session (Wake Lock).
- **What's logged:** the seconds actually spent stretching (get-ready time and pauses don't count). Ending early logs the time done so far. The page reports progress every 15 s and on pause, and the server only ever increases the logged time.
- **Backup:** after every change the server writes `Stretching.md` with days, sessions and total time per month, plus a per-day list of time and stretches.

## Videos

`tools/build-videos.sh` (run by `deploy.sh`) re-encodes every source video into a small web-ready loop: H.264 MP4, at most 720 px, 30 fps, no sound, plus a thumbnail. It writes `public/stretches.json`. Output names contain a hash of the source, so replacing a video gives it a new URL, and only new or changed videos get encoded. Set `STRETCH_VIDEOS` to use another folder.

The videos and the generated list aren't in git. Run `./tools/build-videos.sh` (or just `./deploy.sh`) after cloning.

## Layout

| Path | What |
|---|---|
| `public/` | the app, deployed to the subdomain folder |
| `public/api.php` | JSON API (PHP + SQLite), writes `Stretching.md` |
| `public/stretches.json` | generated stretch list |
| `public/videos/` | generated video loops and thumbnails |
| `tools/build-videos.sh` | encodes the videos and writes the list |
| `tools/icon.svg` | app icon source |
| `sync/` | optional: pulls `Stretching.md` + database snapshots to your laptop |
| `deploy.sh` | builds the videos, then rsyncs `public/` to the server |

## Hosting

Same requirements and steps as the fitness tracker: PHP 8.1+ with pdo_sqlite, HTTPS, and a private data folder outside the web root. `deploy.sh` creates `config.php` next to `api.php` on the first deploy:

```php
<?php
define("DATA_DIR", "/home/you/stretching-data");
define("AUTH_FILE", "/home/you/fitness-data/auth.json"); // password file (shared with the fitness app)
define("TIMEZONE", "Europe/Brussels");
```

- **Password:** set it with the fitness app's `setpass.sh`. Changing it logs out all the apps.
- **Sync:** link the units from `sync/` into `~/.config/systemd/user/`, then run `systemctl --user enable --now stretching-sync.timer`. Point it at your notes folder with a drop-in that sets `STRETCHING_NOTES_DIR`.
