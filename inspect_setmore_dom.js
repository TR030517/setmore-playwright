const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const userDataDir = path.join(process.env.LOCALAPPDATA || __dirname, 'SetmorePlaywrightProfile');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath,
    headless: false,
    viewport: { width: 1920, height: 1080 },
    args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://go.setmore.com/settings/services', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(__dirname, 'dom-inspect.png'), fullPage: true });
  const data = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    bodyText: document.body.innerText.slice(0, 5000),
    htmlLength: document.documentElement.outerHTML.length,
    inputs: [...document.querySelectorAll('input, textarea')].slice(0, 100).map((element) => ({
      tag: element.tagName,
      type: element.getAttribute('type'),
      placeholder: element.getAttribute('placeholder'),
      aria: element.getAttribute('aria-label'),
      value: element.value,
      visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
    })),
    buttons: [...document.querySelectorAll('button, [role="button"], a')].slice(0, 100).map((element) => ({
      tag: element.tagName,
      role: element.getAttribute('role'),
      aria: element.getAttribute('aria-label'),
      text: element.innerText,
      visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
    })),
    frames: [...document.querySelectorAll('iframe')].map((frame) => ({ src: frame.src, title: frame.title })),
  }));
  data.playwrightFrames = page.frames().map((frame) => ({ name: frame.name(), url: frame.url() }));
  fs.writeFileSync(path.join(__dirname, 'dom-inspect.json'), JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});