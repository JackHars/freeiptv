import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { promptForLogin } from '../api/login-tui.mjs';

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let screen = '';
  const output = new Writable({ write(chunk, encoding, callback) { screen += chunk.toString(); callback(); } });
  output.isTTY = true;
  async function enter(prompt, value) {
    for (let attempt = 0; !screen.includes(prompt); attempt++) {
      if (attempt > 1000) throw new Error(`Prompt did not appear: ${prompt}`);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    input.write(value + '\r');
  }
  return { input, output, enter, screen: () => screen };
}

test('first launch asks for a login and masks both password entries', async () => {
  const tty = terminal();
  const result = promptForLogin({ firstRun: true, current: null, input: tty.input, output: tty.output });
  await tty.enter('Username (', 'alice');
  await tty.enter('Password (', 'StrongPass123!');
  await tty.enter('Confirm password:', 'StrongPass123!');
  assert.deepEqual(await result, { username: 'alice', password: 'StrongPass123!' });
  assert.ok(!tty.screen().includes('StrongPass123!'));
  assert.equal(tty.input.isRaw, false);
});

test('later launches can retain the saved login', async () => {
  const tty = terminal();
  const result = promptForLogin({ firstRun: false, current: { username: 'alice', password: 'StrongPass123!' }, input: tty.input, output: tty.output });
  await tty.enter('Username [alice]:', '');
  await tty.enter('New password [Enter keeps current]:', '');
  assert.deepEqual(await result, { username: 'alice', password: 'StrongPass123!' });
  assert.equal(tty.input.isRaw, false);
});
