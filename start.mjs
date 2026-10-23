import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createServer } from './server.mjs';
import { initializeEngine } from './api/platform.mjs';
import { initializeIPTV, setIPTVCredentials, warmIPTV } from './api/iptv.mjs';
import { promptForLogin } from './api/login-tui.mjs';

let config = {};
try { config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

let existingLogin = null;
try { existingLogin = JSON.parse(await readFile(new URL('./data/iptv.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

let newLogin = null;
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
if (interactive) {
  try { newLogin = await promptForLogin({ firstRun: !existingLogin, current: existingLogin }); }
  catch (error) { console.error(error.message); process.exit(1); }
} else if (!existingLogin) {
  console.error('IPTV login setup needs an interactive terminal. Run npm start in a terminal first.');
  process.exit(1);
}

await initializeIPTV(config.iptv);
if (newLogin) {
  await setIPTVCredentials(newLogin.username, newLogin.password);
  console.log('IPTV login saved.');
}
await initializeEngine();
const port = Number(process.env.PORT || config.port || 8091);
const host = process.env.HOST || config.host || '0.0.0.0';
const server = createServer();
server.on('error', error => { console.error(error.message); process.exit(1); });
server.listen(port, host, () => {
  const actualPort = server.address().port;
  const lanAddresses = Object.values(networkInterfaces()).flatMap(addresses => addresses || [])
    .filter(address => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'));
  const address = ['127.0.0.1', 'localhost'].includes(host) ? '127.0.0.1'
    : host !== '0.0.0.0' ? host : lanAddresses[0]?.address || '127.0.0.1';
  const base = `http://${address}:${actualPort}`;
  console.log(`IPTV server: ${base}`);
  if (interactive) {
    const login = newLogin || existingLogin;
    const query = new URLSearchParams({ username: login.username, password: login.password });
    console.log(`Username: ${login.username}`);
    console.log(`Password: ${login.password}`);
    console.log(`M3U playlist: ${base}/get.php?${query}&type=m3u_plus&output=m3u8`);
    console.log(`XMLTV guide: ${base}/xmltv.php?${query}`);
  }
  warmIPTV();
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
