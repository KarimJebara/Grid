import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-probe-'));
const app = await electron.launch({
  args: ['./out/main/index.js', `--user-data-dir=${userData}`],
  env: { ...process.env, NODE_ENV: 'test' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
await win.locator('.xterm-helper-textarea').first().focus();
await win.waitForTimeout(1500);
await win.keyboard.type('echo HELLO_TG_PROBE');
await win.keyboard.press('Enter');
await win.waitForTimeout(1500);

const buf = await win.evaluate(() => globalThis.__tg?.bufferAt(0) ?? 'NO_TG');
const visibleText = await win.evaluate(() => {
  const rows = document.querySelectorAll('.xterm-rows > div');
  return Array.from(rows).map((r) => r.textContent || '').join(' | ');
});
console.log('BUFFER:', JSON.stringify(buf.slice(0, 400)));
console.log('VISIBLE_DOM:', JSON.stringify(visibleText.slice(0, 400)));
await win.screenshot({ path: '/tmp/probe.png' });
await app.close();
