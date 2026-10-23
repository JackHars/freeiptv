# IPTV connection and API

Run `npm start` in a terminal. On the first launch, choose a username and
password in the terminal setup screen. On later interactive launches, enter
new values or press Enter to keep the saved ones. The server starts after
setup and prints the Xtream server address, login, M3U playlist URL, and
XMLTV guide URL in the terminal. There is no browser interface.

## Connect an IPTV player

Choose **Xtream Codes** (sometimes **Xtream API** or **username/password
login**) in your IPTV app and enter:

- **Server:** the `IPTV server` address printed in the terminal, for example
  `http://192.168.1.100:8091`.
- **Username and password:** the values printed in the terminal.
- **Stream format:** HLS / m3u8, if the app asks.

For an M3U app, copy the `M3U playlist` URL printed in the terminal. If the
app accepts a guide, copy the `XMLTV guide` URL too. Refresh the provider in
the app after catalog changes. The computer running this server must stay on
and the IPTV player must be able to reach it over the LAN.

## What the player receives

Xtream clients get movie and series categories, movie details, complete
season and episode listings, and scheduled sports events as Live TV channels.
The M3U playlist includes sports events, catalog movies, and episodes of
pinned series. It accepts only `output=m3u8`; MPEG-TS remuxing and MP4
downloads are not implemented. A sports-only playlist appends `&content=live`
to the printed M3U URL. A series-only playlist appends `&series_id=1396`,
replacing `1396` with the series TMDB ID.

The movie and series catalog comes from TMDB metadata. It is a browsing
catalog, not a list of confirmed video files. When playback begins, the
server uses the title's TMDB ID to ask Cinejoy's playback backend for an HLS
source. It sends browser-style headers when fetching that source. The IPTV
server rewrites HLS playlists to local signed links and relays playlists,
video segments, keys, and supported subtitles to the player. The highest
advertised video quality is selected. Media links expire after 24 hours;
reopen the title to get fresh links.

Sports events are read from external event pages. An event appears in the
guide when scheduled; playback works only if its source has published an HLS
feed. The server follows supported player or iframe links and forwards the
source page's `Referer`, `Origin`, and User-Agent headers. It does not create
a broadcast from a schedule. The guide has no catch-up or recording support.

## IPTV endpoints

| Endpoint | Purpose |
| --- | --- |
| `/player_api.php?username=...&password=...` | Xtream login, categories, listings, and details; GET or POST |
| `/get.php?username=...&password=...&type=m3u_plus&output=m3u8` | M3U playlist |
| `/xmltv.php?username=...&password=...` | Sports XMLTV guide |
| `/movie/USER/PASSWORD/ID.m3u8` | Movie playback |
| `/series/USER/PASSWORD/EPISODE_ID.m3u8` | Episode playback |
| `/live/USER/PASSWORD/EVENT_ID.m3u8` | Live sports playback |

The server also exposes JSON endpoints for catalog maintenance:

- `GET /iptv/titles?q=Matrix&type=movie` searches the local TMDB title index.
- `POST /iptv/library` with JSON `{"type":"movie","tmdb":603}` pins a movie;
  use `"type":"tv"` to pin a series for M3U episode inclusion.
- `POST /iptv/refresh` starts a catalog and title-index refresh.
- `POST /iptv/sports/refresh` starts a sports schedule refresh.

These maintenance endpoints are intended for use on a trusted LAN. The
normal catalog refreshes on demand after 12 hours; sports schedules refresh
every minute. Large catalog imports can take several minutes. The previous
catalog stays available during a refresh.

## Local data and configuration

`data/iptv.json` stores the chosen login, signing secret, and pinned titles.
`data/catalog.json`, `data/titles.sqlite`, `data/episodes.json`, and
`data/sports.json` store the catalog and event caches. Keep `data/` if you
want to preserve the account and catalog across restarts. It is excluded
from Git. No video library is stored.

To change the login, restart with `npm start` in a terminal and enter the new
values. Usernames must have 3–32 letters, numbers, underscores, or hyphens.
Passwords must have 8–128 printable characters without spaces. Update the
account in your IPTV app afterwards.

`config.json` can set `iptv.catalogPages` (1–2,000; default 2,000) and
`iptv.refreshHours` (default 12). Restart after changing the file. The
server defaults to `0.0.0.0:8091`; `HOST` and `PORT` override that listener.

## Checks

Run `npm run check`, `npm run test:login`, `npm run test:catalog-import`,
`npm run test:iptv-quality`, and `npm run test:sports` for offline checks.
With a populated catalog and running server, `npm run test:iptv-catalog`
checks Xtream movie and series responses. It reads the local saved login;
for a remote server, set `IPTV_BASE`, `IPTV_USERNAME`, and `IPTV_PASSWORD`.
