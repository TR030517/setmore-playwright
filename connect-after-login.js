const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages().find((candidate) => candidate.url().includes('setmore.com')) || context.pages()[0];

  if (!page) {
    throw new Error('没有找到可接管的 Setmore 页面。');
  }

  await page.bringToFront();
  console.log(`已连接页面：${page.url()}`);
  console.log('等待你提供价目表数据后，将继续执行录入逻辑。');

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});