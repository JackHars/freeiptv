import { format } from 'node:util';

function wrap(value, width) {
  const chars = Array.from(String(value));
  const lines = [];
  while (chars.length) lines.push(chars.splice(0, width).join(''));
  return lines.length ? lines : [''];
}

export function renderDashboard(details, history, columns = 100, rows = 24) {
  const width = Math.max(10, Math.min(columns, 160));
  const inside = width - 4;
  const fields = [
    'freeiptv  |  running  |  Ctrl+C to stop',
    '',
    `Web interface: ${details.server}`,
    `Xtream server: ${details.xtreamServer || details.server}`,
    `Username:      ${details.username}`,
    `Password:      ${details.password}`,
    'Stream format: HLS / m3u8',
    '',
    `M3U playlist:  ${details.playlist}`,
    `XMLTV guide:   ${details.epg}`,
    `Sports M3U:   ${details.sportsPlaylist}`,
  ];
  const body = fields.flatMap(field => wrap(field, inside));
  const box = ['┌' + '─'.repeat(width - 2) + '┐',
    ...body.map(line => `│ ${line.padEnd(inside)} │`),
    '└' + '─'.repeat(width - 2) + '┘'];
  const header = 'Incoming requests and server activity';
  const available = Math.max(0, rows - box.length - 2);
  const logLines = available ? history.flatMap(line => wrap(line, Math.max(1, columns))).slice(-available) : [];
  return [...box, header, '─'.repeat(width), ...logLines].join('\n');
}

export function createDashboard({ output = process.stdout, password = '' } = {}) {
  const history = [];
  const write = output.write.bind(output);
  const previousConsole = {};
  let active = false, details;
  const redraw = () => {
    if (!active) return;
    write('\x1b[H\x1b[2J' + renderDashboard(details, history, output.columns || 100, output.rows || 24));
  };
  const log = (message, level = '') => {
    const clean = String(message).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replaceAll(password || '\0', '[redacted]')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    const stamp = new Date().toLocaleTimeString('en-CA', { hour12: false });
    for (const line of clean.split(/\r?\n/)) {
      if (line) history.push(`${stamp} ${level ? level + ' ' : ''}${line}`);
    }
    if (history.length > 500) history.splice(0, history.length - 500);
    if (active) redraw();
    else console.log(clean);
  };
  const logRequest = event => {
    const client = String(event.client || '-').replace(/^::ffff:/, '');
    log(`${event.method} ${event.target}  ${event.status}  ${event.durationMs}ms  ${client}`);
  };
  const start = connection => {
    details = connection;
    if (!output.isTTY) return false;
    active = true;
    write('\x1b[?1049h\x1b[?25l');
    output.on('resize', redraw);
    for (const method of ['log', 'info', 'warn', 'error']) {
      previousConsole[method] = console[method];
      console[method] = (...args) => log(format(...args), method === 'log' ? '' : method.toUpperCase());
    }
    redraw();
    return true;
  };
  const stop = () => {
    if (!active) return;
    active = false;
    output.off('resize', redraw);
    for (const [method, original] of Object.entries(previousConsole)) console[method] = original;
    write('\x1b[?25h\x1b[?1049l');
  };
  const update = connection => { details = connection; password = connection.password; redraw(); };
  return { start, stop, log, logRequest, update };
}
