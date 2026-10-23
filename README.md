<div align="center">

# FreeIPTV

**A local IPTV server, populated with media by manipulating existing illegal streaming services**

Movies, series, and live sports through an Xtream-compatible API and M3U playlists.

![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
![Interface: Terminal](https://img.shields.io/badge/Interface-Terminal-2563eb)
![Streaming: HLS](https://img.shields.io/badge/Streaming-HLS-7c3aed)
![Runtime dependencies: 0](https://img.shields.io/badge/Runtime_dependencies-0-475569)

[Quick start](#quick-start) · [Connect your player](#connect-your-player) · [How it works](#how-it-works) · [API reference](IPTV.md)

</div>

---

## Overview

FreeIPTV runs on your computer and exposes external web-player streams to IPTV
apps on your local network. One Node.js process handles the catalog, playback
resolution, and HLS relay. A terminal dashboard keeps connection details visible
above a live request log.

| Feature | What you get |
| --- | --- |
| **Player compatibility** | Xtream-compatible login and M3U playlists |
| **Movies and series** | TMDB listings, artwork, seasons, and episode details |
| **Live sports** | Scheduled events, a sports-only playlist, and an XMLTV guide |
| **HLS playback** | Local stream relay, highest advertised video quality, and supported subtitles |
| **Terminal dashboard** | Fixed connection panel with incoming requests and server activity below |
| **Local accounts** | Choose your login at startup and keep it across restarts |

> **Availability:** Catalog entries and scheduled events do not guarantee a
> playable stream. Playback depends on external sources and your internet
> connection. Keep the host computer running while you use the service.

## Quick start

### Requirements

- **Node.js 24 or newer**, with npm and the built-in SQLite module
- Internet access for metadata and streams
- An IPTV player that supports Xtream Codes or M3U

There are no npm runtime dependencies. [`requirements.txt`](requirements.txt)
records the runtime requirements; it contains no Python packages.

### Install and run

Clone the repository using a GitHub account with access:

```sh
git clone https://github.com/JackHars/freeiptv.git
cd freeiptv
npm ci
npm start
```

On first launch, choose a **username** and **password**, then confirm the
password. Password entry is hidden. There are **no default credentials**.

On later interactive launches, press **Enter** to keep a saved value or enter a
replacement. If you change your login, update it in your IPTV apps too. To run
without an interactive terminal, complete the first setup in a terminal; later
starts reuse the saved credentials.

### Terminal dashboard

Once the server starts, the fixed connection panel displays:

- Xtream server address, username, and password
- Full M3U playlist and sports-only playlist URLs
- XMLTV guide URL and stream format

Incoming requests and server activity appear below the panel. Request logs omit
credentials and signed media tokens. Keep the terminal open while using the
server, and press **Ctrl+C** to stop it. The terminal is the only user interface.

## Connect your player

### Xtream Codes

1. Start FreeIPTV and open your IPTV app.
2. Add a provider using **Xtream Codes**, **Xtream API**, or **username/password login**.
3. Copy the connection details from the terminal:

| Player field | Value |
| --- | --- |
| **Server / portal URL** | The **IPTV server** address, for example `http://192.168.1.100:8091` |
| **Username** | Your username shown in the terminal |
| **Password** | Your password shown in the terminal |
| **Stream format** | **HLS / m3u8**, if requested |

4. Save the provider and open **Movies**, **Series**, or **Live TV**.

### M3U and TV guide

Copy the terminal's **M3U playlist** URL into your player's M3U URL field. For an
EPG or TV guide, use the **XMLTV guide** URL. Use the **sports-only playlist** URL
if you only want live events.

Refresh the provider or playlist after changing the catalog. See the
[IPTV connection and API reference](IPTV.md) for endpoints, playlist options,
and catalog management.

## How it works

```text
IPTV player on your LAN
        |
        | Xtream API / M3U / XMLTV
        v
FreeIPTV on your computer
        |
        +-- TMDB ------------------> Movie and series metadata
        +-- Cinejoy playback API --> Movie and episode HLS sources
        +-- Sports event pages ----> Schedules and published HLS sources
        |
        +-- Local HLS relay -------> Playlists, segments, keys, and subtitles
```

### 1. Build the catalog

FreeIPTV retrieves movie and series names, artwork, and episode details from
**TMDB**. A separate sports adapter reads event pages for schedules. These
listings become Xtream-compatible responses, M3U playlists, and a sports XMLTV
guide. **TMDB supplies metadata, not video.**

### 2. Resolve playback on demand

When you play a movie or episode, the server sends its TMDB ID, plus season and
episode numbers when applicable, to Cinejoy's **`api.wing.st`** playback backend.
The bundled **`api/crush.wasm`** helper encodes the request in the site's
**`lumen-gate`** format, and the server decrypts the reply. It tries the backend's
video mirrors in order until one returns an HLS `.m3u8` playlist.

### 3. Reproduce the web player's requests

Movie and episode media requests carry a browser-style **User-Agent** and the
**`Origin`** and **`Referer`** of **`cinejoy.pk`**. This reproduces the headers used
by that web player when fetching its streams. It does not grant access to a
stream the source has not published.

### 4. Relay the stream to your player

FreeIPTV fetches the HLS playlist, selects the highest advertised video quality,
and rewrites remote playlist, segment, and key URLs as **signed local URLs**.
Your IPTV app requests those local URLs; FreeIPTV forwards the requests with the
required headers and streams the returned bytes back. Supported subtitle tracks
can also be attached. Videos are not saved as a local library.

### 5. Resolve sports feeds separately

The sports adapter follows published iframe or player links from event pages to
find an HLS feed. It relays that feed using the source page's `Referer`, `Origin`,
and browser-style User-Agent. A scheduled event remains unplayable until its
source publishes a supported HLS link. The repository contains no permanent TV
channels or video library.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Network interface to listen on |
| `PORT` | `8091` | HTTP server port |

For access only from the host computer:

```sh
HOST=127.0.0.1 npm start
```

To use another port:

```sh
PORT=8092 npm start
```

FreeIPTV is intended for a **trusted local network** and is not configured for
public access. If a firewall is enabled, allow the configured port on your
trusted LAN. Other devices must be able to reach the host computer.

### Saved data

The server creates `data/` on first launch. It holds your login, signing secret,
catalog, and SQLite index. The chosen credentials are saved in `data/iptv.json`.
Keep this directory private and back it up to preserve your account and catalog.

`data/`, `config.json`, and environment files are excluded from Git. Additional
catalog settings and cache details are documented in [IPTV.md](IPTV.md#local-data-and-configuration).

## Verification

Check the source syntax:

```sh
npm run check
```

With the server running, check its health:

```sh
curl http://localhost:8091/health
```

For the available test commands and API checks, see [IPTV.md](IPTV.md#checks).
