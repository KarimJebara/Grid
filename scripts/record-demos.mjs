#!/usr/bin/env node
/* eslint-disable no-console */
// Drives the built app via Playwright Electron, captures a screenshot loop
// per demo, then assembles each into an optimized GIF + still PNG using ffmpeg.
//
// We use periodic screenshots instead of Playwright's recordVideo because xterm.js
// doesn't redraw into Chromium's offscreen video pipeline reliably on Electron.

import { _electron as electron } from 'playwright';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileP = promisify(execFile);

const ROOT = process.cwd();
const MEDIA_DIR = path.join(ROOT, 'docs', 'media');
const FRAMES_ROOT = path.join(ROOT, 'docs', 'media', '_frames');
const MAIN_JS = path.join(ROOT, 'out', 'main', 'index.js');

const SIZE = { width: 1280, height: 800 };
const FPS = 12;
const FRAME_INTERVAL_MS = Math.round(1000 / FPS);

function ensureDirs() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_ROOT, { recursive: true });
}

async function launchClean() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-demo-'));
  const app = await electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  win.on('dialog', (d) => d.accept().catch(() => undefined));
  // Pin a deterministic window size for consistent frames
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setBounds({ x: 60, y: 60, width: s.width, height: s.height });
    w.focus();
  }, SIZE);
  await win.waitForTimeout(300);
  return { app, win };
}

class FrameRecorder {
  constructor(win, dir) {
    this.win = win;
    this.dir = dir;
    this.frame = 0;
    this.running = false;
    this.task = null;
  }
  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.running = true;
    const tick = async () => {
      while (this.running) {
        const start = Date.now();
        const p = path.join(this.dir, `f${String(this.frame++).padStart(5, '0')}.png`);
        try {
          await this.win.screenshot({ path: p, clip: { x: 0, y: 0, ...SIZE } });
        } catch {
          /* window closed */
          this.running = false;
          break;
        }
        const elapsed = Date.now() - start;
        if (elapsed < FRAME_INTERVAL_MS) await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS - elapsed));
      }
    };
    this.task = tick();
  }
  async stop() {
    this.running = false;
    if (this.task) await this.task;
  }
}

async function convertFramesToGif(framesDir, name) {
  const palette = path.join(framesDir, 'palette.png');
  const gif = path.join(MEDIA_DIR, `${name}.gif`);
  const pattern = path.join(framesDir, 'f%05d.png');

  await execFileP('ffmpeg', [
    '-y',
    '-framerate',
    String(FPS),
    '-i',
    pattern,
    '-vf',
    `scale=1280:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff`,
    palette,
  ]);
  await execFileP('ffmpeg', [
    '-y',
    '-framerate',
    String(FPS),
    '-i',
    pattern,
    '-i',
    palette,
    '-filter_complex',
    `scale=1280:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5`,
    '-loop',
    '0',
    gif,
  ]);
  // Still PNG = last frame
  const files = fs.readdirSync(framesDir).filter((f) => f.startsWith('f') && f.endsWith('.png')).sort();
  const lastFrame = files[files.length - 1];
  if (lastFrame) {
    fs.copyFileSync(path.join(framesDir, lastFrame), path.join(MEDIA_DIR, `${name}.png`));
  }
  const sz = (fs.statSync(gif).size / 1024 / 1024).toFixed(2);
  console.log(`  → ${path.relative(ROOT, gif)}  (${sz} MB, ${files.length} frames)`);
}

async function runDemo(name, fn) {
  console.log(`\n▶ ${name}`);
  const { app, win } = await launchClean();
  const framesDir = path.join(FRAMES_ROOT, name);
  // Clean frames dir
  if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });
  const rec = new FrameRecorder(win, framesDir);
  rec.start();
  try {
    await fn(win, app);
    await win.waitForTimeout(700); // hold last frame
  } catch (e) {
    console.error(`  ✘ ${name} failed:`, e.message);
  }
  await rec.stop();
  await app.close();
  await convertFramesToGif(framesDir, name);
}

// ---- helpers -------------------------------------------------------------
const typeSlow = async (win, s, perChar = 35) => {
  for (const ch of s) {
    await win.keyboard.type(ch);
    await win.waitForTimeout(perChar);
  }
};

const enter = async (win) => {
  await win.waitForTimeout(120);
  await win.keyboard.press('Enter');
};

// ---- demos ---------------------------------------------------------------

async function demo_hello(win) {
  await win.waitForTimeout(600);
  await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.waitForTimeout(900);
  await typeSlow(win, 'echo "Hello from Terminal Grid 👋"');
  await enter(win);
  await win.waitForTimeout(400);
  await typeSlow(win, 'date');
  await enter(win);
  await win.waitForTimeout(700);
  await typeSlow(win, 'uname -a');
  await enter(win);
  await win.waitForTimeout(800);
}

async function demo_cd_ls(win) {
  await win.waitForTimeout(500);
  await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.waitForTimeout(900);
  await typeSlow(win, 'cd /tmp');
  await enter(win);
  await win.waitForTimeout(300);
  await typeSlow(win, 'ls -la | head -12');
  await enter(win);
  await win.waitForTimeout(800);
  await typeSlow(win, 'pwd');
  await enter(win);
  await win.waitForTimeout(800);
}

async function demo_split(win) {
  await win.waitForTimeout(500);
  await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.waitForTimeout(900);
  await typeSlow(win, 'echo "pane 1"');
  await enter(win);
  await win.waitForTimeout(400);
  await win.keyboard.press('Meta+t');
  await win.waitForTimeout(900);
  await win.locator('.pane').nth(1).locator('.xterm-helper-textarea').focus();
  await win.waitForTimeout(700);
  await typeSlow(win, 'top -l 1 -n 6 | head -12');
  await enter(win);
  await win.waitForTimeout(700);
  await win.keyboard.press('Meta+t');
  await win.waitForTimeout(900);
  await win.locator('.pane').nth(2).locator('.xterm-helper-textarea').focus();
  await win.waitForTimeout(700);
  await typeSlow(win, 'echo "three sessions side by side"');
  await enter(win);
  await win.waitForTimeout(700);
  await win.keyboard.press('Meta+t');
  await win.waitForTimeout(900);
  await win.locator('.pane').nth(3).locator('.xterm-helper-textarea').focus();
  await win.waitForTimeout(700);
  await typeSlow(win, 'cal');
  await enter(win);
  await win.waitForTimeout(1000);
}

async function demo_ctxmenu(win) {
  await win.waitForTimeout(500);
  await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.waitForTimeout(900);
  await typeSlow(win, 'echo "right-click me 👀"');
  await enter(win);
  await win.waitForTimeout(700);
  const pane = win.locator('.pane').first();
  const box = await pane.boundingBox();
  if (box) {
    await win.mouse.move(box.x + 200, box.y + 20);
    await win.waitForTimeout(300);
    await pane.click({ button: 'right', position: { x: 200, y: 20 } });
  }
  await win.waitForTimeout(900);
  await win.locator('.ctx-item', { hasText: 'Duplicate' }).hover();
  await win.waitForTimeout(500);
  await win.locator('.ctx-item', { hasText: 'Archive' }).hover();
  await win.waitForTimeout(600);
  await win.locator('.ctx-item', { hasText: 'Archive' }).click();
  await win.waitForTimeout(700);
  await win.locator('.sidebar-archived-header').click();
  await win.waitForTimeout(900);
}

async function demo_search(win) {
  await win.waitForTimeout(500);
  await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.waitForTimeout(900);
  await typeSlow(win, 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "row $i — needle=$((i*i))"; done');
  await enter(win);
  await win.waitForTimeout(800);
  await win.keyboard.press('Meta+f');
  await win.waitForTimeout(500);
  await typeSlow(win, 'needle=49', 60);
  await win.waitForTimeout(400);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1100);
}

async function demo_palette(win) {
  await win.waitForTimeout(500);
  await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.waitForTimeout(900);
  await win.keyboard.press('Meta+t');
  await win.waitForTimeout(700);
  await win.keyboard.press('Meta+t');
  await win.waitForTimeout(700);
  await win.keyboard.press('Meta+Shift+p');
  await win.waitForTimeout(500);
  await typeSlow(win, 'Layout: 1 col', 50);
  await win.waitForTimeout(500);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1100);
}

async function demo_theme(win) {
  await win.waitForTimeout(500);
  await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
  await win.locator('.xterm-helper-textarea').first().focus();
  await win.waitForTimeout(900);
  await typeSlow(win, 'echo "theme switch demo"');
  await enter(win);
  await win.waitForTimeout(500);
  await win.keyboard.press('Meta+Shift+p');
  await win.waitForTimeout(400);
  await typeSlow(win, 'Theme: Light', 50);
  await win.waitForTimeout(400);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1100);
  await win.keyboard.press('Meta+Shift+p');
  await win.waitForTimeout(400);
  await typeSlow(win, 'Theme: Dark', 50);
  await win.waitForTimeout(400);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(900);
}

// ---- hero still ---------------------------------------------------------

async function captureHero() {
  console.log('\n▶ hero (still)');
  const { app, win } = await launchClean();
  try {
    await win.getByRole('button', { name: /Open a new terminal|\+ New/i }).first().click();
    await win.locator('.xterm-helper-textarea').first().focus();
    await win.waitForTimeout(1000);
    await typeSlow(win, 'echo "Welcome to Terminal Grid"');
    await enter(win);
    await win.waitForTimeout(400);
    await win.keyboard.press('Meta+t');
    await win.waitForTimeout(800);
    await win.locator('.pane').nth(1).locator('.xterm-helper-textarea').focus();
    await win.waitForTimeout(400);
    await typeSlow(win, 'ls -la ~/Documents | head -7');
    await enter(win);
    await win.waitForTimeout(400);
    await win.keyboard.press('Meta+t');
    await win.waitForTimeout(800);
    await win.locator('.pane').nth(2).locator('.xterm-helper-textarea').focus();
    await win.waitForTimeout(400);
    await typeSlow(win, 'cal');
    await enter(win);
    await win.waitForTimeout(400);
    await win.keyboard.press('Meta+t');
    await win.waitForTimeout(800);
    await win.locator('.pane').nth(3).locator('.xterm-helper-textarea').focus();
    await win.waitForTimeout(400);
    await typeSlow(win, 'uname -a && node -v && echo "ready"');
    await enter(win);
    await win.waitForTimeout(1500);
    await win.screenshot({ path: path.join(MEDIA_DIR, 'hero.png'), clip: { x: 0, y: 0, ...SIZE } });
    console.log('  → docs/media/hero.png');
  } finally {
    await app.close();
  }
}

// ---- run -----------------------------------------------------------------

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    console.error('Build output missing. Run `npm run build` first.');
    process.exit(1);
  }
  ensureDirs();
  // Clean previous frames
  if (fs.existsSync(FRAMES_ROOT)) fs.rmSync(FRAMES_ROOT, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_ROOT, { recursive: true });

  await captureHero();

  const demos = [
    { name: 'demo-hello', fn: demo_hello },
    { name: 'demo-cd-ls', fn: demo_cd_ls },
    { name: 'demo-split-grid', fn: demo_split },
    { name: 'demo-context-menu', fn: demo_ctxmenu },
    { name: 'demo-search', fn: demo_search },
    { name: 'demo-palette-layout', fn: demo_palette },
    { name: 'demo-theme', fn: demo_theme },
  ];

  for (const d of demos) await runDemo(d.name, d.fn);

  console.log('\n✅ done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
