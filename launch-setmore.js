const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

const chromePath = chromeCandidates.find((candidate) => candidate && fs.existsSync(candidate));

if (!chromePath) {
  console.error('未找到 Chrome，可安装 Chrome 后重试。');
  process.exit(1);
}

const userDataDir = path.join(process.env.LOCALAPPDATA || __dirname, 'SetmorePlaywrightProfile');
fs.mkdirSync(userDataDir, { recursive: true });

const state = {
  chromePath,
  userDataDir,
  debugUrl: 'http://127.0.0.1:9222',
  targetUrl: 'https://auth.setmore.com/o/login/',
  launchedAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(__dirname, 'browser-state.json'), JSON.stringify(state, null, 2));

async function main() {
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath,
    headless: false,
    args: [
      '--remote-debugging-port=9222',
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://auth.setmore.com/o/login/', { waitUntil: 'domcontentloaded' });

  console.log('已启动独立 Chrome 调试窗口。');
  console.log(`专用持久用户数据目录：${userDataDir}`);
  console.log('请在弹出的窗口中手动登录 Setmore，并进入 Services 页面。此目录会保留你本次登录，供后续自动化使用。');
  console.log('完成后在聊天中回复：已进入主界面');
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});