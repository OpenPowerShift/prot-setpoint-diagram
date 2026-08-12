import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

async function main() {
  const server = spawn('npx', ['vite', '--port', '5182', '--host', '127.0.0.1'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  await new Promise((r) => setTimeout(r, 3000));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => console.log('console', m.type(), m.text()));

  await page.goto('http://127.0.0.1:5182/', { waitUntil: 'networkidle' });
  await page.waitForSelector('psdl-viewer svg');
  await page.screenshot({ path: '/tmp/psdl-1-feeder.png', fullPage: true });

  // pick a different example
  await page.selectOption('.psdl-select', 'wide-range');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/psdl-2-wide.png', fullPage: true });

  await page.selectOption('.psdl-select', 'preferred-conflict');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/psdl-3-conflict.png', fullPage: true });

  await page.selectOption('.psdl-select', '01-mandatory-conflict');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/psdl-4-mandatory.png', fullPage: true });

  await page.selectOption('.psdl-select', '05-words');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/psdl-5-words.png', fullPage: true });

  await browser.close();
  server.kill();
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
