// Keep a master playlist (and its alternate audio/subtitles), but expose only
// its highest advertised video rendition to IPTV clients.
function attributes(line) {
  return Object.fromEntries([...line.slice(line.indexOf(':') + 1).matchAll(/(?:^|,)([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(match => [match[1], match[2] ?? match[3]]));
}

function quality(attrs) {
  const resolution = attrs.RESOLUTION?.match(/^(\d+)x(\d+)$/i);
  const pixels = resolution ? Number(resolution[1]) * Number(resolution[2]) : 0;
  const codecs = (attrs.CODECS || '').split(',').map(codec => codec.trim()).filter(Boolean);
  const audioOnly = !pixels && !attrs.VIDEO && codecs.length > 0 && codecs.every(codec => /^(?:mp4a|ac-3|ec-3|opus|flac|alac)(?:\.|$)/i.test(codec));
  return { audioOnly, score: [pixels, Number(attrs.BANDWIDTH) || Number(attrs['AVERAGE-BANDWIDTH']) || 0, Number(attrs['FRAME-RATE']) || 0] };
}

function better(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function highestQualityPlaylist(playlist) {
  const lines = playlist.split(/\r?\n/), variants = [];
  let pending;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) pending = { tag: index, attrs: attributes(line) };
    else if (pending && line && !line.startsWith('#')) {
      variants.push({ ...pending, uri: index, ...quality(pending.attrs) }); pending = null;
    }
  }
  if (variants.length < 2) return playlist;
  const video = variants.filter(variant => !variant.audioOnly);
  const candidates = video.length ? video : variants;
  const best = candidates.reduce((a, b) => better(b.score, a.score) ? b : a);
  const remove = new Set(variants.filter(variant => variant !== best).flatMap(variant => [variant.tag, variant.uri]));
  return lines.filter((_, index) => !remove.has(index)).join('\n');
}
