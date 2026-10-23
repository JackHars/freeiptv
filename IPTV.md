# Cinejoy IPTV

Run `npm start` in a terminal and enter a username and password when prompted. On later interactive starts, press Enter to keep either value or type a replacement. The server starts after you finish the login screen. Open **http://localhost:8091/iptv** on the host, or use its LAN address from another device, for the current account details and playlist link.

## Add the provider to an IPTV app

Select **Xtream Codes** (sometimes called Xtream API or username/password login):

- Server / portal: `http://192.168.1.100:8091` (replace with your host's LAN address)
- Username: the one you entered at startup (also shown on the IPTV setup page)
- Password: the one you entered at startup (also shown on the IPTV setup page)
- Stream format: **HLS / m3u8**
- Account name: any name, such as Cinejoy Home

Use the app's **Movies**, **Series**, and **Live TV** sections. Live TV contains sports events grouped by sport, with a programme guide. Refresh the Cinejoy playlist in UHF after updating the server to import the live categories and events. The computer running Cinejoy must stay on and the player must be able to reach it on your LAN.

## Catalog and playlists

The default catalog uses a 2,000-page discovery budget each for movies and series. The first 500 pages come from the popular list; the remaining 1,500 requests explore release-date ranges. Large date ranges split into smaller ranges when they exceed 500 pages, so no request asks TMDB for an invalid page number. Trending and top-rated lists are also imported, up to their available pages or 500 each. It deduplicates titles, retains previously cached titles, and excludes unreleased/adult titles from automatic discovery. See the setup page for current counts and progress.

This is a browsing catalog, not an inventory of confirmed playable files. Source availability is checked when playback is requested. Discovery uses TMDB's documented [movie date filters](https://developer.themoviedb.org/reference/discover-movie) and [series date filters](https://developer.themoviedb.org/reference/discover-tv) within the [500-page limit per query](https://developer.themoviedb.org/docs/errors).

The **Search all cached titles** section on the setup page searches a separate local index built from [TMDB's daily bulk exports](https://developer.themoviedb.org/docs/daily-id-exports). It caches original movie/series names, IDs, and popularity across the standard non-adult exports, including titles outside the detailed IPTV catalog. The first snapshot contains 1,262,717 movie titles and 234,803 series titles and occupies about 126 MiB. Search works from the local SQLite database without TMDB requests. Select **Add to IPTV** to fetch a result's full metadata and pin it; then refresh UHF. The export is not a list of confirmed playable sources and can include unreleased titles.

The title index checks for updates when the server starts or the setup page is opened after 24 hours, or when **Refresh catalog** is pressed. The previous index remains usable during an update or if a download fails.

To include a specific title, use **Add to IPTV** in the local title search or cinema's title dialog, or enter its TMDB ID on the IPTV setup page. Pinned titles survive catalog updates.

**Xtream Codes:** includes the sports event schedule and the whole imported movie and series catalog. Opening a series returns its seasons and episodes.

**M3U:** use the playlist URL shown on the setup page or download the playlist. It includes sports events, all catalog movies, and all episodes of pinned series. Pin a TV series to add its episodes to M3U. Refresh the playlist in your IPTV app after changing pins.

A series-only playlist is also available by appending `&series_id=1396`, for example, to the supplied playlist URL. `output=m3u8` is required; MPEG-TS remuxing and MP4 downloads are not implemented.

The detailed catalog refreshes on demand after 12 hours, or immediately using **Refresh catalog**. Change `iptv.catalogPages` (1–2,000; default 2,000) and `iptv.refreshHours` in `config.json` and restart the service to adjust discovery size and cache period. Values up to 500 apply directly to each list; larger values add partitioned discovery beyond those lists. A changed page budget triggers a background rebuild on startup.

Large imports take several minutes. Requests are paced at no more than ten per second, with at most four in flight and retries for temporary failures. The existing catalog stays available until the new snapshot is ready; failed list requests retain cached titles, and pinned titles survive refreshes. Refresh your playlist in UHF after the import completes.

## Live sports

The sports adapter is a Node port of `/workspace/sports/sports_api.py` from the `hermes-a6b133b6` Docker container, inspected on 2026-10-22 (source SHA-256 `068f25a4b4e75f68e14701dc400a1e080f088a772a5b828aefc31e1cfb820a40`). It runs inside the existing server on port 8091, independently of the container's API on 8092.

It imports NBA, NFL, NHL, MLB, college football, soccer, MMA, boxing, WWE, Formula 1, and CFL events when listed upstream. Each event is its own Live TV channel; these are scheduled broadcasts, not permanent 24/7 channels. Categories appear when they have events. Event IDs persist across refreshes and restarts. Schedules refresh every minute with at most four upstream requests in flight. Ended events disappear from imports, and cached listings survive temporary source errors for up to 24 hours, subject to their end times.

The **Live sports** panel on `/iptv` shows scheduled events and published player-link counts, plus a separate refresh button, an XMLTV guide URL, and a sports-only M3U URL (`content=live`). Refresh the playlist in UHF to import newly scheduled events. Programmes use the upstream start/end times; XMLTV includes explicit UTC offsets. There is no catch-up or recording support.

When Play is pressed, the adapter re-fetches the event metadata and decodes the same Base64/XOR player payload as the Docker API. It follows direct HLS URLs and simple embedded player pages that expose HLS, then proxies playlists, segments and keys through signed LAN URLs. Referer, Origin and User-Agent headers are retained, and the highest advertised quality is selected. Native HLS subtitles/audio remain available; movie subtitle lookup is not applied to live sports. Player pages requiring arbitrary JavaScript, YouTube-only players, and non-HLS formats are not converted.

**Current upstream limitation:** validation found 38 scheduled events in seven categories but no published player URLs. Some were within their scheduled live window, but the upstream payload field was empty. Those events return HTTP 503 with an explanatory error and Retry-After header; upcoming and ended events are distinguished. This integration does not manufacture a stream from a schedule. Published links are resolved again when playback is requested. Real sports playback remains unverified until the upstream publishes a supported feed.

## Supported endpoints

| Endpoint | Purpose |
| --- | --- |
| `/player_api.php?username=...&password=...` | Account and server information; GET or form/JSON POST |
| `action=get_live_categories` | Sports categories with scheduled events |
| `action=get_live_streams` | Event channels; optional `category_id` |
| `action=get_short_epg&stream_id=...` | Event programme information; also `get_simple_data_table` |
| `action=get_vod_categories` | Movie genre categories |
| `action=get_vod_streams` | Movie listing; optional `category_id` |
| `action=get_vod_info&vod_id=...` | Movie metadata and playback address |
| `action=get_series_categories` | TV genre categories |
| `action=get_series` | Series listing; optional `category_id` |
| `action=get_series_info&series_id=...` | Full season and episode listings |
| `/live/USER/PASSWORD/EVENT_ID.m3u8` | Re-resolve and play a supported live sports feed |
| `/movie/USER/PASSWORD/ID.m3u8` | Resolve and play a movie |
| `/series/USER/PASSWORD/EPISODE_ID.m3u8` | Resolve and play an indexed episode |
| `/get.php?username=...&password=...&type=m3u_plus&output=m3u8` | M3U playlist |
| `/xmltv.php?username=...&password=...` | XMLTV sports event guide |
| `/iptv/titles?q=Matrix&type=movie` | Search the local bulk title index (type: `movie`, `tv`, or `all`); LAN setup access |

Live event IDs are stable local IDs, with matching `sports-ID` EPG channel identifiers. Movie IDs are TMDB movie IDs. Episode IDs are TMDB episode IDs, mapped to the series/season/episode and persisted locally.

## How playback works

The adapter calls the embedded resolver when a player opens a movie or episode URL. It fetches the returned HLS playlist and rewrites all nested playlist, segment, key, and initialization URLs to signed local media addresses. Actual video bytes pass through this server. Those addresses remain valid for 24 hours.

The adapter exposes only the highest advertised video quality from the resolved source: it ranks variants by resolution (pixel count), then bandwidth, then frame rate. If resolution metadata is absent, bandwidth determines the choice. It retains the selected variant's audio and subtitle declarations, codecs, keys, and other master metadata. The same selection applies to nested IPTV master playlists. This prevents an IPTV app's automatic bitrate selection from choosing a lower rendition; it may buffer if the connection cannot sustain that quality. There is no 1080p cap: 4K/8K is selected when the resolved source advertises it. This chooses among that source's renditions; source-server fallback order is unchanged. When the source has no subtitle group, it queries Cinejoy's separate subtitle service (`subs.wing.st/subtitles`) using the movie TMDB ID or the series TMDB ID plus season and episode. Available SRT/WebVTT files become selectable HLS subtitle renditions, served through signed local URLs. English is listed first with up to three alternatives; other available languages get one track each. Subtitles start off, so choose a language in the player. Reopen an already playing title after updating the server to load its new track list. It forwards byte-range and HEAD requests, streams video without buffering the entire segment, and gives disguised upstream segments valid local media filename extensions for native-player compatibility. An initial upstream playback failure triggers one fresh resolve attempt.

The server converts selected subtitle files to UTF-8 WebVTT and splits them into 60-second HLS segments spanning the video's actual duration, including empty sections and cues that cross segment boundaries. It maps their timestamps to the source media clock. This follows [HLS WebVTT timing and rendition declarations](https://datatracker.ietf.org/doc/html/rfc8216#section-3.5), allowing players to fetch the right captions after seeking. Existing native subtitle groups are retained. Subtitle lookup failures leave video playback available. External subtitles can differ from the exact video release; English alternatives may provide a better timing match. Sidecar generation currently requires a complete VOD playlist without discontinuities.

No separate IPTV service or Docker container is needed; this adapter runs in the same Node process on port 8091.

## Local data

`data/iptv.json` stores the chosen account, signing secret, and pinned titles. `data/catalog.json` stores the detailed IPTV catalog. `data/titles.sqlite` stores the bulk title index and its update metadata. `data/episodes.json` stores episode mappings. `data/sports.json` stores sports event metadata, persistent IDs, refresh status, and errors. Event records older than seven days are pruned; allocated IDs are not reused. Keep these files to preserve account details, title caches, and cached episode links after restarts. They are excluded from Git; a new installation asks you to choose its account and builds fresh caches. No video files are stored by either catalog. Subtitle lists and selected subtitle cues are cached in memory for up to an hour, with bounded entries; they are fetched again after a restart. Subtitle files are fetched only when their track is selected. Reading the first 64 KiB of a video segment establishes subtitle timing; this is not a persistent video cache.

To change the login, restart with `npm start` in a terminal and enter the new username or password. Usernames must have 3–32 letters, numbers, underscores, or hyphens. Passwords must have 8–128 printable characters without spaces. Update the account in your player afterwards.

The existing cinema and REST API keep their original local access model. The IPTV username/password checks apply to the IPTV client endpoints. The setup page is available to people who can access the LAN UI.

## Verification and compatibility

Tested Xtream authentication (GET and POST), categories, movie and series metadata, all Breaking Bad seasons, M3U generation, pinned titles, byte-range media responses, HEAD, invalid credentials, and tampered media URLs. FFmpeg successfully decoded The Matrix and Breaking Bad S1E1 through the final LAN provider URLs. The setup UI was checked on desktop and mobile.

The target player is UHF on iPhone. A movie-import compatibility correction makes VOD `rating` a JSON number and `rating_5based` a whole-number score, matching the [Xtream reference server](https://github.com/gtaman92/XtreamCodesExtendAPI/blob/master/player_api.php). The prior response used a string rating and fractional five-star score. Series responses use a separate mapping.

After updating the server, refresh the Cinejoy playlist in UHF to import the corrected movie data. The API checks pass; device-specific confirmation happens in UHF.

With the server running, use `npm run test:iptv-catalog` to check every movie's field types, all movie category filters, GET/form-POST imports, movie details, and the series listing. Set `UI_BASE=http://192.168.1.100:8091` with your host's LAN address to run from another computer. This regression check failed against the previous movie responses and passes after the correction.

`npm run test:catalog-import` checks the 2,000-page budget, date partitioning, the 500-page per-query ceiling, deduplication, release/adult filtering, pinned titles, retry behavior, and retention of cached data. It also checks persistent offline title search, Unicode names, adult filtering, and preservation of the old index on a failed update, without making network requests.

The server logs import request actions, categories, response status/count, duration, client address, and user agent. It omits request URLs, bodies, and account credentials.

Protocol field shapes and URL conventions were checked against the [tellytv Xtream client implementation](https://github.com/tellytv/go.xtream-codes/blob/master/xtream-codes.go), its [response types](https://github.com/tellytv/go.xtream-codes/blob/master/structs.go), and the [tunlx Xtream API reference](https://tunlx.io/reference/xc-api/).

`npm run test:subtitles` checks SRT/WebVTT conversion, Unicode and formatting, cues spanning segment boundaries, seekable VOD playlists, language selection, preservation of native audio/subtitles, TS/fMP4 timestamp mapping, movie/episode lookup, cache coalescing, retries, and download limits. Live checks on The Matrix and Breaking Bad S1E1 also cover signed subtitle URLs, WebVTT responses, HEAD, invalid signatures and segment bounds.

Real Chrome/hls.js playback displayed English captions for both test titles and displayed captions again after seeking 30 minutes forward. The same tracks are supplied to UHF through standard HLS manifests; the iPhone app itself was not available for an automated test.

`npm run test:iptv-quality` checks highest-resolution selection, bitrate/frame-rate ties, missing resolution metadata, audio-only variants, native audio/subtitle preservation, media playlist passthrough, and subtitle timing against the selected quality, together with the subtitle regression suite. Reopen an already playing video after updating the server to load the restricted quality list.

Live quality verification: The Matrix and Breaking Bad S1E1 both offered 1080p and 720p upstream. The IPTV response exposed only 1920×1080 at 4,692,000 bits/s, and Chrome/hls.js decoded 1920×1080 video with English captions even with a deliberately low initial bandwidth estimate.

`npm run test:sports` verifies Docker-compatible payload decoding, event status and expiry, stable IDs, cache retention on failure, HLS discovery through embeds, Xtream GET/POST live imports, category filters, EPG/XMLTV, live M3U, authentication, and signed HLS proxying with required headers, quality selection, keys, byte ranges, and HEAD. The transport check uses a controlled HLS fixture, not an actual sports broadcast. Real-source listing/guide tests imported 38 events and parsed 38 XMLTV programmes; an unpublished broadcast correctly returned 503. Movie catalog regression checks still passed (31,341 movies and 32,228 series).
