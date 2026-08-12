import { chromium } from '@playwright/test';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`CONSOLE error:`, m.text());
  });

  console.log('goto...');
  await page.goto('http://127.0.0.1:5184/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForSelector('.psdl-select', { timeout: 5000 });
  await page.waitForSelector('psdl-editor .cm-editor', { timeout: 5000 });
  await page.waitForSelector('psdl-viewer svg', { timeout: 5000 });
  await page.waitForTimeout(800);

  // 1) Initial feeder
  await page.screenshot({ path: '/tmp/p2-feeder.png' });
  console.log('shot 1: feeder');

  // 2) Wide range (log scale)
  await page.selectOption('.psdl-select', 'wide-range');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/p2-wide.png' });
  console.log('shot 2: wide');

  // 3) Conflict
  await page.selectOption('.psdl-select', 'preferred-conflict');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/p2-conflict.png' });
  console.log('shot 3: conflict');

  // 4) Mandatory conflict
  await page.selectOption('.psdl-select', '01-mandatory-conflict');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/p2-mandatory.png' });
  console.log('shot 4: mandatory');

  // 5) Vertical
  await page.selectOption('.psdl-select', '02-vertical');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/p2-vertical.png' });
  console.log('shot 5: vertical');

  // 6) Caution
  await page.selectOption('.psdl-select', '03-caution');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/p2-caution.png' });
  console.log('shot 6: caution');

  // 7) Open the guide
  await page.click('button:has-text("Guide")');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/p2-guide-tutorial.png' });
  console.log('shot 7: guide tutorial');

  // 8) Switch to guide tab
  await page.click('.psdl-tab:has-text("Guide")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/p2-guide-guide.png' });
  console.log('shot 8: guide page');

  // 9) Switch to reference tab
  await page.click('.psdl-tab:has-text("Reference")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/p2-guide-reference.png' });
  console.log('shot 9: reference');

  await browser.close();
  console.log('done');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
