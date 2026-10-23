# freeiptv

A locally hosted IPTV server with a terminal setup screen, Xtream-compatible
API, and M3U playlist. It runs in one Node.js process on port 8091.

## How it provides IPTV

This server acts as a local IPTV adapter for external web players:

1. **Build the listings.** It gets movie and series names, artwork, and
   episode details from TMDB. Separately, it reads sports event pages for
   schedules. It presents those listings to IPTV apps through an
   Xtream-compatible API, an M3U playlist, and a sports XMLTV guide. TMDB
   supplies metadata, not video.
2. **Resolve a movie or episode when you press Play.** The server sends the
   title's TMDB ID (plus season and episode numbers for TV) to Cinejoy's
   `api.wing.st` playback backend. It uses the bundled `api/crush.wasm` helper
   to encode the request in that site's `lumen-gate` format, then decrypts the
   reply. It tries the backend's video mirrors in order until one returns an
   HLS `.m3u8` playlist. A listed title can still have no playable source.
3. **Make media requests like the web player.** For those movie and episode
   streams, outgoing requests carry a browser-style User-Agent and the
   `Origin` and `Referer` of `cinejoy.pk`. This reproduces the request headers
   used by its web player; it does not grant access to a stream the source has
   not published.
4. **Relay playback locally.** The server fetches the HLS playlist, selects
   the highest advertised video quality, and replaces remote playlist,
   segment, and key URLs with signed local URLs. Your IPTV app requests those
   local URLs; the server forwards the requests upstream with the needed
   headers and streams the returned bytes back. It can also attach supported
   subtitle tracks. It does not store a video library.
5. **Handle sports separately.** The sports adapter reads event pages, follows
   published iframe or player links to an HLS feed, and forwards that feed
   with the source page's `Referer`, `Origin`, and browser-style User-Agent.
   A scheduled event without a published HLS link remains unplayable.

The terminal shows the local server address, configured login, and playlist
and guide links to enter in your IPTV app.

The repository contains no video library or permanent TV channels. A title in
the catalog does not guarantee a playable stream, and a scheduled sports event
needs its source to publish a supported broadcast link. Playback depends on the
upstream services and your internet connection. The host computer must stay
running while devices use the provider.

## Requirements

- Node.js 24 or newer, including npm and the built-in SQLite module
- Internet access for the upstream metadata and streams

This is a Node.js project with no npm runtime dependencies.
[`requirements.txt`](requirements.txt) records the runtime requirements and
contains no Python packages.

## Set up

```sh
git clone https://github.com/JackHars/freeiptv.git
cd freeiptv
npm ci
npm start
```

`npm start` opens a terminal login screen **before the server starts**. On a
fresh install, enter a username and password, then confirm the password. The
password is hidden as you type. On later interactive starts, press Enter at a
prompt to keep that value or type a replacement. If you change the login,
update the account in your IPTV apps. For a start without an interactive
terminal, set up the login once in a terminal first; later starts reuse the
saved credentials.

After startup, a fixed terminal panel shows the IPTV server address, username,
password, M3U playlist URLs, and XMLTV guide URL. Incoming requests and server
activity scroll beneath the panel. Request logs omit credentials and signed
media tokens. Keep that terminal open while using the service; press Ctrl+C
to stop it. There is no browser interface.

## Add it to an IPTV app

1. Start the server and read the connection details printed in its terminal.
2. In your IPTV app, add a provider using **Xtream Codes** (also called
   **Xtream API** or **username/password login**).
3. Enter these connection details:

   | Field | Value |
   | --- | --- |
   | Server / portal URL | The **IPTV server** address printed in the terminal, such as `http://192.168.1.100:8091` |
   | Username | The username printed in the terminal |
   | Password | The password printed in the terminal |
   | Stream format, if asked | HLS / m3u8 |

4. Save the provider and open **Movies**, **Series**, or **Live TV** in the app.

There are **no default credentials** for a fresh install. The server saves
your chosen login in `data/iptv.json`. They stay the same across restarts if
you keep `data/`.

If your app accepts **M3U** instead of Xtream Codes, copy the **M3U playlist**
URL printed in the terminal into its M3U URL field. If it has an EPG or TV
guide field, copy the **XMLTV guide** URL. Refresh the playlist in the app
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

Keep this server on a trusted LAN; it is not configured for public access.
