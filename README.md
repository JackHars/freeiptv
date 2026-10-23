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
same trusted LAN, use `http://<host-LAN-IP>:8091`. Open `/iptv` at the same
address to see the generated Xtream username, password, and playlist URL. In
your IPTV player, choose HLS / m3u8. See [IPTV.md](IPTV.md) for supported
clients and endpoints.

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
