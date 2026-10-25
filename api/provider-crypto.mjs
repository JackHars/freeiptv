// Native Node crypto and a bounded parser for VidSrc's rotating WASM key tables.
// Protocol ported from Red Hermes' October 25, 2026 resolver snapshot.
import { createDecipheriv } from 'node:crypto';

export function decryptGCM(key, blob) {
  if (blob.length < 28) throw new Error('Encrypted response is too short');
  const cipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  cipher.setAuthTag(blob.subarray(-16));
  return Buffer.concat([cipher.update(blob.subarray(12, -16)), cipher.final()]);
}

function cursor(bytes) {
  let offset = 0;
  const byte = () => {
    if (offset >= bytes.length) throw new Error('Truncated WASM');
    return bytes[offset++];
  };
  const leb = (signed = false) => {
    let value = 0, shift = 0, b;
    do {
      if (shift >= 35) throw new Error('Invalid WASM integer');
      b = byte(); value += (b & 127) * 2 ** shift; shift += 7;
    } while (b & 128);
    if (signed && (b & 64)) value -= 2 ** shift;
    return value;
  };
  const take = count => {
    if (count < 0 || offset + count > bytes.length) throw new Error('Truncated WASM section');
    const data = bytes.subarray(offset, offset + count); offset += count; return data;
  };
  return { byte, leb, take, get remaining() { return bytes.length - offset; } };
}

export function vidsrcKey(wasm) {
  const input = cursor(wasm);
  if (!input.take(8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('Invalid WASM header');
  const sections = new Map();
  while (input.remaining) { const id = input.byte(); sections.set(id, input.take(input.leb())); }
  if (!sections.has(10) || !sections.has(11)) throw new Error('Missing WASM code/data');
  const data = cursor(sections.get(11)), segments = [];
  for (let n = data.leb(); n > 0; n--) {
    const mode = data.leb();
    if (mode === 1) { data.take(data.leb()); continue; }
    if (mode === 2 && data.leb() !== 0) throw new Error('Unsupported WASM memory');
    if (mode !== 0 && mode !== 2) throw new Error('Unsupported WASM segment');
    if (data.byte() !== 0x41) throw new Error('Unsupported WASM offset');
    const start = data.leb(true);
    if (start < 0 || data.byte() !== 0x0b) throw new Error('Invalid WASM offset');
    segments.push({ start, bytes: data.take(data.leb()) });
  }
  const code = cursor(sections.get(10)), bodies = [];
  for (let n = code.leb(); n > 0; n--) bodies.push(code.take(code.leb()));
  if (!bodies[2]) throw new Error('Missing VidSrc key function');
  const fn = cursor(bodies[2]);
  for (let n = fn.leb(); n > 0; n--) { fn.leb(); fn.byte(); }
  // Parse actual instructions, not byte-pattern matches inside immediates.
  const ops = [];
  while (fn.remaining && ops.length < 128) {
    const op = fn.byte(); let value;
    if (op === 0x41) value = fn.leb(true);
    else if ([0x20, 0x21, 0x22, 0x23, 0x24, 0x10, 0x0c, 0x0d].includes(op)) value = fn.leb();
    else if (op >= 0x28 && op <= 0x3e) { fn.leb(); value = fn.leb(); }
    else if (![0x0b, 0x0f, 0x1a, 0x1b].includes(op) && !(op >= 0x45 && op <= 0xc4)) {
      throw new Error('VidSrc key function layout changed');
    }
    ops.push({ op, value });
    const tail = ops.slice(-5);
    if (tail.map(x => x.op).join() !== [0x41, 0x28, 0x41, 0x28, 0x73].join()) continue;
    const readTable = address => {
      const segment = segments.find(s => address >= s.start && address + 32 <= s.start + s.bytes.length);
      if (!segment) throw new Error('Missing VidSrc key table');
      return segment.bytes.subarray(address - segment.start, address - segment.start + 32);
    };
    const a = readTable(tail[0].value + tail[1].value), b = readTable(tail[2].value + tail[3].value);
    return Buffer.from(a.map((v, i) => v ^ b[i]));
  }
  throw new Error('VidSrc key tables not found');
}

export function decryptVidSrc(blob, key) {
  if (blob.length <= 12) throw new Error('Invalid VidSrc payload');
  // All first 12 bytes form the nonce (the first byte varies); counter starts at zero.
  const cipher = createDecipheriv('chacha20', key, Buffer.concat([Buffer.alloc(4), blob.subarray(0, 12)]));
  return Buffer.concat([cipher.update(blob.subarray(12)), cipher.final()]);
}
