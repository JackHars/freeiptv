# freeiptv

A locally hosted IPTV server with a browser interface, Xtream-compatible API,
and M3U playlist. The UI and API run in one Node.js process on port 8091.

## How it provides IPTV

This server turns online catalogs and streams into a provider that IPTV apps can
use on your local network:

1. It gets movie and series listings, artwork, and episode details from TMDB.
   It also imports scheduled sports events from its sports sources. These
   listings become the Movies, Series, and Live TV sections in an IPTV app.
2. It exposes those listings through an Xtream-compatible API, an M3U playlist,
   and an XMLTV guide for sports. The `/iptv` page shows the server address,
   generated login, and playlist and guide links to enter in your app.
3. When you play something, the server resolves an available HLS stream from
   the upstream source. It rewrites the playlist so video segments, keys, and
   supported subtitles pass through the local server to your IPTV player.

The repository contains no video library or permanent TV channels. A title in
the catalog does not guarantee a playable stream, and a scheduled sports event
needs its source to publish a supported broadcast link. Playback depends on the
upstream services and your internet connection. The host computer must stay
running while devices use the provider.

## Requirements

- Node.js 24 or newer, including npm and the built-in SQLite module
- Internet access for the upstream metadata and streams

This is a Node.js project. [`package-lock.json`](package-lock.json) pins the
installable dependency; [`requirements.txt`](requirements.txt) records the
runtime requirements and contains no Python packages.

## Set up

```sh
git clone https://github.com/JackHars/freeiptv.git
cd freeiptv
npm ci
npm start
```

Open `http://localhost:8091` on the host computer. For another device on the
same trusted LAN, use `http://<host-LAN-IP>:8091`.

## Add it to an IPTV app

1. While the server is running, open `http://<host-LAN-IP>:8091/iptv` in a
   browser. Use `http://localhost:8091/iptv` when browsing on the host itself.
2. In your IPTV app, add a provider using **Xtream Codes** (also called
   **Xtream API** or **username/password login**).
3. Enter these connection details:

   | Field | Value |
   | --- | --- |
   | Server / portal URL | `http://<host-LAN-IP>:8091` (no `/iptv` suffix) |
   | Username | `cinejoy` on a fresh install |
   | Password | The password shown at `/iptv` |
   | Stream format, if asked | HLS / m3u8 |

4. Save the provider and open **Movies**, **Series**, or **Live TV** in the app.

There is **no shared default password**. The server creates a random one on
first start and keeps it in `data/iptv.json`; the `/iptv` page shows the current
username and password. They stay the same across restarts if you keep `data/`.
If you changed the username, use the value shown on that page instead of
`cinejoy`.

If your app accepts **M3U** instead of Xtream Codes, copy the **Playlist URL**
from `/iptv` into its M3U URL field. If it has an EPG or TV guide field, copy
the **XMLTV guide URL** from the same page. Refresh the playlist in the app
after changing the catalog. See [IPTV.md](IPTV.md) for more detail.

`HOST` and `PORT` override the default listener (`0.0.0.0:8091`). For access
only from the host computer, start with `HOST=127.0.0.1 npm start`. If you use
a firewall, allow port 8091 only on your trusted local network.

The server creates `data/` on first start. It contains the IPTV login,
signing secret, catalog, and SQLite index. Keep it private and back it up if
you want to preserve the account and saved catalog. `data/`, `config.json`,
and environment files are excluded from Git.

## Verify

```sh
npm run check
curl http://localhost:8091/health
```

The local setup page reveals the IPTV credentials to anyone who can reach it.
Keep this server on a trusted LAN; it is not configured for public access.
