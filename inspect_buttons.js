const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const userDataDir = path.join(process.env.LOCALAPPDATA || __dirname, 'SetmorePlaywrightProfile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    viewport: { width: 1920, height: 1080 },
    args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://go.setmore.com/settings/services', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const data = await page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('button, [role="button"], a, input, textarea')].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        type: element.getAttribute('type'),
        role: element.getAttribute('role'),
        aria: element.getAttribute('aria-label'),
        text: normalize(element.innerText || element.textContent || element.value || ''),
        placeholder: element.getAttribute('placeholder'),
        disabled: element.disabled || element.getAttribute('aria-disabled'),
        visible: rect.width > 0 && rect.height > 0,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        className: element.className,
      };
    }).filter((item) => item.visible);
  });

  fs.writeFileSync(path.join(__dirname, 'buttons-inspect.json'), JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});