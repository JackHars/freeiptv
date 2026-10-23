import { emitKeypressEvents } from 'node:readline';

function readLine(input, output, label, { secret = false } = {}) {
  output.write(label);
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      input.off('keypress', onKeypress);
      input.off('end', onEnd);
      if (error) { output.write('\n'); reject(error); }
      else { output.write('\n'); resolve(value); }
    }
    function onEnd() { finish(new Error('Terminal input closed before login setup finished.')); }
    function onKeypress(character, key = {}) {
      if (key.ctrl && key.name === 'c') return finish(new Error('Login setup cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace' || key.name === 'delete') {
        if (value) { value = value.slice(0, -1); output.write('\b \b'); }
        return;
      }
      if (character && /^[\x20-\x7e]$/.test(character) && value.length < 128) {
        value += character;
        output.write(secret ? '*' : character);
      }
    }
    input.on('keypress', onKeypress);
    input.on('end', onEnd);
  });
}

export async function promptForLogin({ firstRun, current, input = process.stdin, output = process.stdout }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('IPTV login setup needs an interactive terminal. Run npm start in a terminal first.');
  }
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  output.write('\n╭──────────────────────────────╮\n│      IPTV login setup        │\n╰──────────────────────────────╯\n');
  output.write(firstRun ? 'Create the login for your IPTV apps.\n' : 'Enter new details, or press Enter to keep the current ones.\n');
  try {
    let username;
    for (;;) {
      const answer = await readLine(input, output, firstRun ? 'Username (3–32 letters/numbers/_/-): ' : `Username [${current.username}]: `);
      username = answer || (firstRun ? '' : current.username);
      if (/^[A-Za-z0-9_-]{3,32}$/.test(username)) break;
      output.write('Use 3–32 letters, numbers, underscores, or hyphens.\n');
    }
    let password;
    for (;;) {
      const answer = await readLine(input, output, firstRun ? 'Password (8–128 characters): ' : 'New password [Enter keeps current]: ', { secret: true });
      if (!answer && !firstRun) { password = current.password; break; }
      if (!/^[\x21-\x7e]{8,128}$/.test(answer)) {
        output.write('Use 8–128 printable characters without spaces.\n');
        continue;
      }
      const confirmation = await readLine(input, output, 'Confirm password: ', { secret: true });
      if (answer === confirmation) { password = answer; break; }
      output.write('Passwords did not match. Try again.\n');
    }
    return { username, password };
  } finally {
    input.setRawMode(Boolean(wasRaw));
    input.pause();
  }
}
