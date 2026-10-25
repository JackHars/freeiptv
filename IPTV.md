# IPTV connection and API

Run `npm start` in a terminal. On the first launch, choose a username and
password in the terminal setup screen. Catalog metadata comes from upstream
providers; no TMDB credential is required. On later interactive launches, enter
new values or press Enter to keep the saved ones. The server starts after
setup and shows the Xtream server address, login, M3U playlist URLs, and
XMLTV guide URL in a fixed terminal panel. Incoming requests scroll below it.
Open the printed web address to browse and manage the server with the same login.
The initial account is the owner administrator. Add more accounts in
**Settings → Users**, and copy each account’s details from **IPTV connections**.

## Connect an IPTV player

Choose **Xtream Codes** (sometimes **Xtream API** or **username/password
login**) in your IPTV app and enter:

- **Server:** the `IPTV server` address printed in the terminal, for example
  `http://192.168.1.100:8091`.
- **Username and password:** the selected user’s values in **Settings → IPTV
  connections**, or the owner’s values printed in the terminal.
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

The movie and series catalog comes from the 7Movies / Vidrift and Atlantic endpoints,
with optional TMDB fallback. It is a browsing
catalog, not a list of confirmed video files. When playback begins, the
server tries Cinejoy, Atlantic, Tvids, Zstream, Vidrift, and VidSrc in that
order by default for a playable HLS source. Settings → Providers controls the
enabled sources, fallback order, time limits, and resolution cache. VidSrc needs
an IMDb ID from the metadata layer. Upstream movie details supply it, and Atlantic
also supplies series mappings. If no mapping is available, VidSrc fails for that
title and playback can use another enabled provider.
Each source is checked through its highest-quality variant and a video segment
before selection. Its browser-style headers are retained throughout playback. The IPTV
server rewrites HLS playlists to local signed links and relays playlists,
video segments, keys, and supported subtitles to the player. The highest
advertised video quality is selected by default; adaptive mode lets the player
choose among available variants. Media links expire after 24 hours and are
revoked when their user is changed, disabled, deleted, or expires;
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

- `GET /iptv/titles?q=Matrix&type=movie` searches the upstream catalog, using the configured metadata fallback if needed.
- `POST /iptv/library` with JSON `{"type":"movie","tmdb":603}` pins a movie;
  use `"type":"tv"` to pin a series for M3U episode inclusion.
- `POST /iptv/refresh` starts a catalog refresh.
- `POST /iptv/sports/refresh` starts a sports schedule refresh.

Maintenance endpoints require a signed-in browser session. Mutations require an
administrator and same-origin requests. The
normal catalog refreshes on demand after 12 hours; sports schedules refresh
every minute. A fresh installation publishes a small starter catalog, then
expands it in the background. Imports are paced at one request per second and
respect rate-limit retry delays; the default large import can take over an hour.
The previous catalog stays available during a refresh, and list failures do not
disable unrelated search or episode endpoints.

## Playback provider diagnostics

`GET /providers` lists the six installed provider adapters. The current enabled
order is shown in **Settings → Providers**. IPTV movie
and episode URLs select a provider automatically; existing player settings work
without changes. Live sports continue to use the separate sports adapter.

Legacy diagnostic endpoints (`/resolve`, `/master`, `/watch`, `/proxy`, and
metadata helpers) require an administrator browser session. They do not provide
an anonymous alternative to account-based playback. `/health`, `/api`, and the
installed adapter list at `/providers` remain public.

For a targeted check in your signed-in browser, use `GET /resolve?tmdb=550&kind=movie&provider=atlantic`.
For series, use `kind=series&s=1&e=1`. The same fields work with JSON `POST /resolve`.
Omit `provider` for automatic fallback. The response includes `provider`,
`server`, `headers`, `provider_order`, `provider_errors`, and `master_proxied`.
The proxied master preserves the selected provider's headers on nested requests.
`/master` and `/watch` also accept `provider`.

Use `fresh=1` on GET `/resolve` (or `fresh: true` in JSON) to bypass the five-minute
resolution cache. Failures are not cached. The legacy `server` parameter pins a
Cinejoy mirror and cannot be combined with another provider.

Resolution defaults to 30 seconds per provider and 180 seconds overall. Both
limits are configurable and also apply to requests pinned to a provider. Failed HLS and
placeholder segments trigger fallback. MP4-only sources are skipped. If the
selected master fails before playback starts, the IPTV route makes one further
attempt excluding that provider. It cannot switch sources seamlessly in the middle
of a playing segment; reopen the title if an upstream stream later fails.

## Metadata sources and optional TMDB fallback

Metadata requests try these sources in order:

1. **7Movies / Vidrift** (`7movies.ac`).
2. **Atlantic** (`db.hls.lol`), a separate provider endpoint with lists, search,
   movie/series details, credits, artwork, seasons, and IMDb mappings.
3. **7Movies mirror** (`7movies.ws`), another domain in the first provider family.
4. **Your TMDB account**, only when the optional fallback is enabled.

These provider endpoints still serve TMDB-derived information. They give us
separate upstream routes without a personal key, not independent underlying
movie databases. Each provider has its own failure backoff; a failed primary
is retried later without disabling the other providers.

The adapter uses the sites' public list/detail, search, discovery,
and season endpoints. Search returns the provider's result set; it is not an
exhaustive offline index of every TMDB title. Imports use popular/highly rated
lists and release-year discovery. Existing cached titles and pins are retained.

Open **Settings → Metadata** to configure the optional fallback:

1. Save your own [TMDB API key or API Read Access Token](https://www.themoviedb.org/settings/api).
2. Enable **Use TMDB as a fallback** and save the setting.
3. Disable the switch at any time, or remove the credential to disable it too.

The default is upstream-only. Existing installations retain any saved credential
but start with fallback disabled. Missing credentials never block startup, web
browsing, IPTV login, playback through other providers, or live sports. A specific
metadata request can still fail if its sources and cache have no usable answer.

Direct TMDB requests are made only to verify a credential when saving it, or when
the fallback is enabled and upstream sources cannot supply the requested data.
The credential is never sent to an upstream streaming provider. Both TMDB
authentication methods are supported. Rejected replacements and network errors
leave the previous credential intact. Saved credentials are omitted from settings
responses, request logs, and browser storage, and kept in the Git-ignored
`data/iptv.json` file. Changes apply to new requests immediately.

Metadata is cached locally: lists/search for 15 minutes, details/seasons for six
hours, and TMDB fallback responses for five minutes. If fresh requests fail,
cached information can be reused for up to seven days. The disk cache is bounded
and contains metadata, not API credentials or video. Failed responses are not
cached. Removing or disabling TMDB also prevents reuse of its fallback cache.

Upstream metadata still uses TMDB title IDs and image URLs. Our server no longer
downloads TMDB's daily title exports. Legacy `data/titles.sqlite` files are left
untouched but are no longer used.

## Local data and configuration

`data/iptv.json` stores users, the owner account, saved server/provider/catalog
settings, the signing secret, and pinned titles. Existing single-user files are
migrated automatically with a one-time backup in `data/iptv.pre-users.json`.
`data/catalog.json`, `data/metadata-cache.json`, `data/episodes.json`, and
`data/sports.json` store the catalog and event caches. Keep `data/` if you
want to preserve the account and catalog across restarts. It is excluded
from Git. No video library is stored.

Change your login in **Settings → My account**. Administrators manage other
accounts in **Settings → Users**. The terminal setup still edits the owner login. Usernames must have 3–32 letters, numbers, underscores, or hyphens.
Passwords must have 8–128 printable characters without spaces. Update the
account in your IPTV app afterwards.

Use **Settings → Library** for catalog pages (1–2,000; default 2,000) and refresh
interval (default 12 hours). Legacy `config.json` values seed these settings on
first migration; saved web settings then take precedence. The server defaults to
`0.0.0.0:8091`; **Settings → General** changes the saved listener, and `HOST` and
`PORT` override it. Listen changes require a restart; other settings apply to new
requests. `FREEIPTV_DATA_DIR` can select a separate data directory for testing.

Web sessions last up to 12 hours and are cleared on restart. Account changes
invalidate older sessions and signed media links. Viewer accounts cannot change
server settings or view another account’s connection details. The owner cannot
be disabled, expired, demoted, or deleted.

## Checks

Run `npm run check`, `npm run test:login`, `npm run test:catalog-import`,
`npm run test:iptv-quality`, `npm run test:providers`, `npm run test:web`, `npm run test:metadata`, and `npm run test:sports` for offline checks.
With a populated catalog and running server, `npm run test:iptv-catalog`
checks Xtream movie and series responses. It reads the local saved login;
for a remote server, set `IPTV_BASE`, `IPTV_USERNAME`, and `IPTV_PASSWORD`.
