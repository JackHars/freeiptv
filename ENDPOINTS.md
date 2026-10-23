# Cinejoy Platform API — Endpoint Reference

A self-hosted, anonymous REST API + web platform for browsing and streaming
video content. One single-file Node.js server (no third-party packages),
serving both the web app and the API on the same port.

**Run:** `node platform.mjs [port]` (Node ≥ 18, default port `8090`)
**Base URL:** `http://localhost:8090`

- **No authentication.** All routes are open.
- **CORS:** enabled on all API responses.
- **Content types:** JSON unless noted; HLS playlists use
  `application/vnd.apple.mpegurl`; segments stream as `video/mp4`.
- **Titles are addressed by their TMDB integer id** (`tmdb`). Playback
  accepts only TMDB ids.

---

## Endpoint Overview

| Method | Route | Description |
|---|---|---|
| GET | `/` | Web app (SPA) |
| GET | `/api` | API index |
| GET | `/docs` | Human-readable API documentation (HTML) |
| GET | `/health` | Liveness + engine status |
| GET | `/servers` | Live upstream source servers |
| GET | `/search` | Search movies + TV by title |
| GET | `/browse` | Catalog boards |
| GET | `/title` | Title metadata (+ seasons, cast for TV) |
| GET | `/episodes` | Episode list for a TV season |
| GET | `/images` | Backdrops + posters for a title |
| GET / POST | `/resolve` | Resolve a playable stream (core playback route) |
| GET | `/master` | Synthesized master playlist (ABR-ready, all variants proxied) |
| GET | `/watch` | Single proxied variant playlist (direct playback) |
| GET | `/proxy` | Generic HLS proxy (playlist rewriting + segment streaming) |

---

## Catalog & Metadata

### `GET /health`
Liveness probe and engine status.

```json
{ "ok": true, "wasm": true, "uptime_s": 344, "cached_resolves": "yes" }
```

`wasm: true` indicates the request signer is loaded and ready.

### `GET /servers`
Live upstream source servers used for playback (with failover order).

```json
{ "servers": [
  { "name": "Nebula",  "status": "ok", "4k": false },
  { "name": "Lisbon",  "status": "ok", "4k": true  },
  { "name": "Solara",  "status": "ok", "4k": false },
  { "name": "Athens",  "status": "ok", "4k": false }
]}
```

Cached 60 s.

### `GET /search?q=&page=`
Search movies and TV series by title.

| Param | Type | Notes |
|---|---|---|
| `q` | string | **required** — search query |
| `page` | int | page number (default 1) |

```bash
curl 'http://localhost:8090/search?q=breaking+bad'
```

```json
{
  "items": [
    {
      "id": 1396,
      "kind": "tv",
      "title": "Breaking Bad",
      "year": "2008",
      "poster": "/hzY05XZf8VXHMOF8v2i1ohvwb4j.jpg",
      "backdrop": "/gWuB8Qh6L3F7BP0DveJmcim1Ri.jpg",
      "vote": 8.9,
      "overview": "A high school chemistry teacher..."
    }
  ],
  "page": 1, "pages": 1, "total": 15
}
```

`poster`/`backdrop` are path strings for `https://image.tmdb.org/t/p/`.

### `GET /browse?board=&type=&page=`
Browse catalog boards.

| Param | Type | Values |
|---|---|---|
| `board` | string | `trending` (default) · `popular` · `top_rated` · `on_the_air` (TV only) · `now_playing` (movie only) |
| `type` | string | `tv` (default) · `movie` |
| `page` | int | page number |

Response shape is identical to `/search` (`items[]`, `page`, `pages`, `total`).

```bash
curl 'http://localhost:8090/browse?board=trending&type=tv'
curl 'http://localhost:8090/browse?board=now_playing&type=movie&page=2'
```

### `GET /title?tmdb=&type=`
Full metadata for one title.

| Param | Type | Notes |
|---|---|---|
| `tmdb` | int | **required** — TMDB id |
| `type` | string | `movie` (default) · `tv` |

Movie:
```json
{
  "tmdb": 550, "kind": "movie", "title": "The Dark Knight",
  "year": "2008", "overview": "...", "vote": 8.5, "adult": false,
  "poster": "/qJ2tW6WMUDux911r6m7haRef0WH.jpg",
  "cast": [{ "name": "Christian Bale", "character": "Bruce Wayne" }]
}
```

TV (adds `status` and `seasons`):
```json
{
  "tmdb": 1396, "kind": "tv", "title": "Breaking Bad",
  "year": "2008", "overview": "...", "vote": 8.9, "status": "Ended",
  "poster": "...", "cast": [ ... ],
  "seasons": [ { "season": 1, "name": "Season 1", "episodes": 7 } ]
}
```

### `GET /episodes?tmdb=&season=`
Episode list for a TV season.

| Param | Type | Notes |
|---|---|---|
| `tmdb` | int | **required** |
| `season` | int | default 1 (alias: `s`) |

```json
{
  "tmdb": 1396, "season": 1,
  "episodes": [
    { "season": 1, "episode": 1, "name": "Pilot",
      "air_date": "2008-01-20", "vote": 8.2, "overview": "..." }
  ]
}
```

### `GET /images?tmdb=&type=`
TMDB backdrops and poster URLs for a title.

```json
{
  "backdrops": [ "https://image.tmdb.org/t/p/original/...", "..." ],
  "backdrop": "https://image.tmdb.org/t/p/w1280/...",
  "poster": "https://image.tmdb.org/t/p/original/..."
}
```

---

## Playback

### `GET /resolve`  (and `POST /resolve`)
Core playback route. Resolves a title to a live, playable HLS master
playlist with automatic upstream failover.

**Query params (GET):**

| Param | Type | Notes |
|---|---|---|
| `tmdb` | int | **required** — TMDB id |
| `kind` | string | `movie` (default) · `series`/`tv` |
| `s` | int | season (required for series; alias: `season`) |
| `e` | int | episode (required for series; alias: `episode`) |
| `server` | string | pin to one upstream: `Nebula` · `Lisbon` · `Solara` · `Athens` |
| `fresh` | `1` | bypass the 5-minute resolve cache |

**POST body** (JSON): `{ "tmdb": 550, "kind": "movie" }` or
`{ "tmdb": 1396, "kind": "series", "s": 1, "e": 1 }`.

**Response:**
```json
{
  "tmdb": 550, "kind": "movie",
  "season": null, "episode": null,
  "server": "Nebula",
  "tried": ["Nebula"],
  "server_errors": {},
  "master": "https://<upstream-cdn>/.../master.m3u8",
  "master_proxied": "/proxy?u=https%3A%2F%2F...",
  "streams": [ { "playlist": "", "quality": "..." } ],
  "variants": [
    { "resolution": "1920x1080", "width": 1920,
      "bandwidth": 6000000, "media": "https://<cdn>/.../1080.m3u8" }
  ],
  "cached": false
}
```

- `master` — upstream master playlist (direct).
- `master_proxied` — same playlist through this server's proxy
  (recommended: keeps CDN URLs opaque and lets playlists expire freely).
- `variants[]` — parsed quality levels from the master, sorted best-first.
- `tried[]` — upstreams actually attempted, in order.
- `server_errors{}` — per-upstream error details when failover occurred.

```bash
# movie
curl 'http://localhost:8090/resolve?tmdb=550&kind=movie'
# TV episode
curl 'http://localhost:8090/resolve?tmdb=1396&kind=series&s=1&e=1'
# bypass cache after an error
curl 'http://localhost:8090/resolve?tmdb=550&kind=movie&fresh=1'
```

### `GET /master?tmdb=&kind=&s=&e=`
Synthesized master playlist with **every variant URI rewritten through the
proxy** — feed this URL directly to hls.js and you get adaptive bitrate
switching plus manual quality selection with zero extra work.

Response: `application/vnd.apple.mpegurl`
```
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,NAME="1080p"
/proxy?u=https%3A%2F%2F...%2F1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,NAME="720p"
/proxy?u=https%3A%2F%2F...%2F720.m3u8
```

### `GET /watch?tmdb=&kind=&s=&e=&v=`
Single variant media playlist, proxied and rewritten. The simplest URL for
external players (mpv, VLC, ffmpeg).

| Param | Values |
|---|---|
| `v` | `best` (default) · `1080p` · `720p` · `480p` · `360p` |

```bash
mpv 'http://localhost:8090/watch?tmdb=550&kind=movie'
mpv 'http://localhost:8090/watch?tmdb=1396&kind=series&s=1&e=1&v=720p'
```

### `GET /proxy?u=`
Generic HLS proxy. `u` is a URL-encoded upstream URL.

- If the upstream returns a playlist, it is returned with every URI
  rewritten to route through this proxy (recursively safe).
- If the upstream returns media (a `.ts`/`.m4s` segment), the raw bytes are
  streamed back as `video/mp4`.

This is the route that makes `/master`, `/watch`, and `master_proxied`
self-contained: all CDN traffic flows through the local server.

---

## Errors

All errors are JSON: `{ "error": "<message>" }`.

| Status | Meaning |
|---|---|
| `200` | OK (or playlist bytes) |
| `400` | Bad parameters (missing `q`, non-numeric `tmdb`, missing `s`/`e` for series, unknown board, malformed `u`) |
| `404` | Title not carried by any upstream right now. Message includes per-upstream detail, e.g. `title 1400940 not carried (Solara did not confirm): Nebula: ...; Lisbon: ...` |
| `500` | Internal error (details logged server-side) |
| `502` | Transient: all upstreams failed or timed out — retry with `fresh=1` |

**404 vs 502 semantics:** if any upstream explicitly reports the title is
not available (`not carried`, `empty mirror`, `no playable stream`,
`not found`), the API returns **404**. If failures are timeouts or opaque
errors with no explicit "unavailable" signal, it returns **502**.

---

## Caching

| Cache | TTL | Bypass |
|---|---|---|
| Resolved streams | 5 minutes | `fresh=1` (GET) / `"fresh": true` (POST) |
| Upstream server list | 60 seconds | — |
| TMDB catalog/metadata | 2 minutes | — |

Playlists and CDN URLs can expire upstream at any time; the web app handles
this by re-resolving automatically. For external clients, re-issue
`/resolve?fresh=1` and rebuild the playlist URL on playback failure.

---

## Upstream Failover

Playback tries upstream sources in order: **Nebula → Lisbon → Solara →
Athens** (Lisbon additionally offers 4K paths). The first upstream that
returns a stream wins; `tried[]` and `server_errors{}` in the resolve
response show exactly what happened. Use `server=<name>` to pin.

Availability is per-title and churns over time — a title may resolve on one
upstream and not another, and this can change within hours.

---

## Client Examples

**hls.js (browser) — ABR + quality switching:**
```js
import Hls from 'hls.js';
const hls = new Hls();
hls.loadSource('http://localhost:8090/master?tmdb=550&kind=movie');
hls.attachMedia(document.querySelector('video'));
// manual quality: hls.currentLevel = <levelIndex>  (-1 = auto)
```

**mpv / VLC / ffmpeg (any player):**
```bash
mpv 'http://localhost:8090/watch?tmdb=550&kind=movie'
```

**Minimal resolve → play in any language:**
```python
import json, urllib.request
r = json.load(urllib.request.urlopen(
    'http://localhost:8090/resolve?tmdb=1396&kind=series&s=1&e=1'))
print(r['master_proxied'])   # → http://localhost:8090/proxy?u=...
# point any HLS player at base + r['master_proxied']
```

**JavaScript (no dependencies):**
```js
const r = await fetch('http://localhost:8090/resolve?tmdb=550&kind=movie')
           .then(x => x.json());
new Hls().loadSource(new URL(r.master_proxied, location.origin).href);
```

---

## Protocol Notes (implementation)

The playback engine speaks a proprietary upstream protocol ("lumen-gate"):

1. `GET <upstream>/servers` — available source servers.
2. `GET <upstream>/crush.wasm` — request signer (WASM, auto-downloaded and
   cached locally on first start if missing).
3. `seal_request(path, payload, nonce[44])` →
   `[responseKey(32B)][keyId(1B)][ephemeralPublic(65B)][sealedBody]`
   where `path` is shaped `/<Server>/<kind>?tmdb=<id>[&season=&episode=]`.
4. `POST <upstream>/g` with the sealed body.
5. Response is `[iv(12B)][AES-256-GCM ciphertext + 16B tag]`; decrypt with
   key = `responseKey`, AAD = `b"lumen-gate-v2" + [0, 2, keyId] + ephemeralPublic`.
6. Plaintext JSON: `{ "status": 200, "data": { "stream": [{ "playlist": ".../master.m3u8", "quality": "..." }] } }`.

Catalog, search, metadata, and images come from the standard TMDB public
API (v3). Playback resolution is TMDB-id only.

---

## Verified Working (live checks, 2026-10-22)

| Title | TMDB | Result |
|---|---|---|
| The Dark Knight | 550 | movie playback, 1080p variant, 5.8 MB segment |
| Breaking Bad | 1396 | S1E1 playback, 6.2 MB segment |
| Game of Thrones | 1399 | S1E1 playback, 5.3 MB segment |
| The Matrix | 603 | resolve + playback |
| Inception | 27205 | resolve + playback |
| Clayface | 1400940 | clean 404 (not carried, per-upstream detail) |

Test suites: 24/24 endpoint checks on the platform server; 4/4 standalone
package checks (fresh extract, WASM auto-download path included).
