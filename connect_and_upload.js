const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const SETMORE_URL_PATTERN = /(^|\.)setmore\.com$/i;
const TEAM_NAME = 'I Foot Spa';
const AUTO_START = process.env.AUTO_START === '1';
const USE_PERSISTENT_CONTEXT = process.env.USE_PERSISTENT_CONTEXT === '1';
const USER_DATA_DIR = path.join(process.env.LOCALAPPDATA || __dirname, 'SetmorePlaywrightProfile');
const PAGE_READY_TIMEOUT = 90000;
const LIMIT_SERVICES = Number.parseInt(process.env.LIMIT_SERVICES || '0', 10);
const DELETE_EXTRA_SERVICES = process.env.DELETE_EXTRA_SERVICES === '1';
const RUN_LOG = path.join(__dirname, 'run.log');
const ACTION_LOG = path.join(__dirname, 'actions.jsonl');

function logStep(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  fs.appendFileSync(RUN_LOG, `${line}\n`);
}

function recordAction(action, detail = {}) {
  fs.appendFileSync(ACTION_LOG, `${JSON.stringify({ time: new Date().toISOString(), action, ...detail })}\n`);
}

async function saveFailureScreenshot(page, name) {
  const safeName = name.replace(/[^a-z0-9_-]+/gi, '-');
  await page.screenshot({ path: path.join(__dirname, `${safeName}.png`), fullPage: true }).catch(() => {});
}

function xpathLiteral(value) {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `concat(${value.split('"').map((part) => `"${part}"`).join(', "\\\"", ')})`;
}

async function waitForSetmoreIdle(page, label = '页面') {
  logStep(`等待 ${label} 加载完成`);
  await page.waitForFunction(
    () => {
      const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body.innerText);
      const hasCategoryList = bodyText.includes('Services & classes');
      if (hasCategoryList) return true;
      if (bodyText.includes('Edit service') || bodyText.includes('New service')) return true;

      const hasStableContent = [
        'Services & classes',
        'New service category',
        'New service',
        'Edit service',
        'You have no services in this category.',
        'You are not assigned to any services.',
        'No services to display',
      ].some((text) => bodyText.includes(text));

      const visibleElements = [...document.querySelectorAll('*')].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      const hasBlockingLoader = visibleElements.some((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalize(element.textContent || '');
        const className = String(element.className || '').toLowerCase();
        const aria = String(element.getAttribute('aria-label') || '').toLowerCase();
        const role = String(element.getAttribute('role') || '').toLowerCase();
        const nearCenter = Math.abs((rect.x + rect.width / 2) - window.innerWidth / 2) < 180
          && Math.abs((rect.y + rect.height / 2) - window.innerHeight / 2) < 180;
        const looksLikeSpinner = /spinner|loader|loading|progress|animate-spin/.test(`${className} ${aria}`)
          || role === 'progressbar'
          || (rect.y <= 8 && rect.height <= 8 && rect.width > 50)
          || (nearCenter && rect.width >= 20 && rect.width <= 80 && rect.height >= 20 && rect.height <= 80 && text.length <= 2);
        return looksLikeSpinner;
      });

      return hasStableContent && !hasBlockingLoader;
    },
    null,
    { timeout: PAGE_READY_TIMEOUT },
  );
  await page.waitForTimeout(800);
}

async function waitForTeamOptionsReady(page, label = 'Team 区域') {
  logStep(`等待 ${label} 加载完成`);
  await waitForSetmoreIdle(page, label);
  await page.waitForFunction(
    (teamName) => {
      const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body.innerText);
      if (!bodyText.includes('Team') || !bodyText.includes(teamName) || !bodyText.includes('team')) return false;

      const visibleExact = (text) => [...document.querySelectorAll('*')].some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && normalize(element.textContent) === text;
      });

      return visibleExact(teamName) && visibleExact('team');
    },
    TEAM_NAME,
    { timeout: PAGE_READY_TIMEOUT },
  );
  await page.waitForTimeout(500);
}

async function waitForEditServiceReady(page, title) {
  logStep(`等待服务详情加载完成：${title}`);
  await page.waitForFunction(
    () => {
      const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body.innerText);
      const hasEditForm = bodyText.includes('Edit service')
        && bodyText.includes('Service details')
        && bodyText.includes('Team')
        && bodyText.includes('Duration')
        && bodyText.includes('Cost')
        && [...document.querySelectorAll('input, textarea')].some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

      const hasBlockingLoader = [...document.querySelectorAll('*')].some((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const className = String(element.className || '').toLowerCase();
        const aria = String(element.getAttribute('aria-label') || '').toLowerCase();
        const nearCenter = Math.abs((rect.x + rect.width / 2) - window.innerWidth / 2) < 220
          && Math.abs((rect.y + rect.height / 2) - window.innerHeight / 2) < 220;
        return /spinner|loader|loading|progress|animate-spin/.test(`${className} ${aria}`)
          || (nearCenter && rect.width >= 20 && rect.width <= 90 && rect.height >= 20 && rect.height <= 90 && normalize(element.textContent).length <= 2);
      });

      return hasEditForm || (bodyText.includes('Edit service') && !hasBlockingLoader);
    },
    null,
    { timeout: PAGE_READY_TIMEOUT },
  );
  await waitForTeamOptionsReady(page, `服务详情 Team 区域：${title}`);
}

const SERVICES_PRICE_LIST = {
  'BODY WORK': [
    { title: '30 Mins Swedish', duration: '30', cost: '40', oldTitles: ['Swedish 30 Mins'] },
    { title: '60 Mins Swedish', duration: '60', cost: '60', oldTitles: ['Swedish 60 Mins'] },
    { title: '90 Mins Swedish', duration: '90', cost: '90', oldTitles: ['Swedish 90 Mins'] },
    { title: '30 Mins Deep Tissue', duration: '30', cost: '45', oldTitles: ['Deep Tissue 30 Mins'] },
    { title: '60 Mins Deep Tissue', duration: '60', cost: '65', oldTitles: ['Deep Tissue 60 Mins'] },
    { title: '90 Mins Deep Tissue (with Free Hot Stone)', duration: '90', cost: '95', oldTitles: ['Deep Tissue 90 Mins (with Free Hot Stone)'] },
    { title: '120 Mins Body Work', duration: '120', cost: '110', oldTitles: ['Body Work 2 Hours'] },
  ],
  'FOOT REFLEXOLOGY': [
    { title: '30 Mins Sea Salt', duration: '30', cost: '35', oldTitles: ['Sea Salt 30 Mins'] },
    { title: '60 Mins Sea Salt', duration: '60', cost: '48', oldTitles: ['Sea Salt 1 Hour'] },
    { title: '30 Mins Ginger Powder', duration: '30', cost: '36', oldTitles: ['Ginger Powder 30 Mins'] },
    { title: '60 Mins Ginger Powder', duration: '60', cost: '50', oldTitles: ['Ginger Powder 1 Hour'] },
    { title: '30 Mins Traditional Chinese Medicine', duration: '30', cost: '36', oldTitles: ['Traditional Chinese Medicine 30 Mins'] },
    { title: '60 Mins Traditional Chinese Medicine', duration: '60', cost: '50', oldTitles: ['Traditional Chinese Medicine 1 Hour'] },
  ],
  'CHAIR RELAXING': [
    { title: '10 Mins Chair Massage', duration: '10', cost: '15', oldTitles: ['Chair Massage 10 Mins'] },
    { title: '15 Mins Chair Massage', duration: '15', cost: '20', oldTitles: ['Chair Massage 15 Mins'] },
    { title: '20 Mins Chair Massage', duration: '20', cost: '25', oldTitles: ['Chair Massage 20 Mins'] },
    { title: '30 Mins Chair Massage', duration: '30', cost: '35', oldTitles: ['Chair Massage 30 Mins'] },
  ],
  'SKIN CARE': [
    { title: '30 Mins Wash Face', duration: '30', cost: '45', oldTitles: ['Wash Face'] },
    { title: '30 Mins Mini Facial', duration: '30', cost: '55', oldTitles: ['Mini Facial'] },
    { title: '45 Mins H2 Facial', duration: '45', cost: '65', oldTitles: ['H2 Facial'] },
    { title: '30 Mins Ear Candle', duration: '30', cost: '35', oldTitles: ['Ear Candle'] },
    { title: '60 Mins Deep Cleaning Facial', duration: '60', cost: '70', oldTitles: ['Deep Cleaning Facial'] },
    { title: '60 Mins Hydro & Soothing Treatment', duration: '60', cost: '85', oldTitles: ['Hydro & Soothing Treatment'] },
  ],
  'HEAD TREATMENT': [
    { title: '60 Mins Head Treatment', duration: '60', cost: '98', oldTitles: ['Head Treatment 60 Mins'] },
    { title: '80 Mins Head Treatment', duration: '80', cost: '120', oldTitles: ['Head Treatment 80 Mins'] },
  ],
  'BODY PACKAGE': [
    { title: '60 Mins Body Package - Buy 5 Times (Free 1 Time)', duration: '60', cost: '300', oldTitles: ['Body Package - Buy 5 Times (Free 1 Time)'] },
    { title: '60 Mins Body Package - Buy 10 Times (Free 3 Times)', duration: '60', cost: '600', oldTitles: ['Body Package - Buy 10 Times (Free 3 Times)'] },
  ],
  'FOOT PACKAGE': [
    { title: '60 Mins Foot Package - Buy 5 Times (Free 1 Time)', duration: '60', cost: '240', oldTitles: ['Foot Package - Buy 5 Times (Free 1 Time)'] },
    { title: '60 Mins Foot Package - Buy 10 Times (Free 3 Times)', duration: '60', cost: '480', oldTitles: ['Foot Package - Buy 10 Times (Free 3 Times)'] },
  ],
  'BODY COMBO': [
    { title: '30 Mins Body + 30 Mins Feet (Swedish)', duration: '60', cost: '65' },
    { title: '30 Mins Body + 30 Mins Feet (Deep Tissue)', duration: '60', cost: '70' },
    { title: '60 Mins Body + 30 Mins Feet (Swedish)', duration: '90', cost: '85' },
    { title: '60 Mins Body + 30 Mins Feet (Deep Tissue)', duration: '90', cost: '90' },
    { title: '60 Mins Body + 60 Mins Feet (Swedish)', duration: '120', cost: '95' },
    { title: '60 Mins Body + 60 Mins Feet (Deep Tissue)', duration: '120', cost: '100' },
  ],
  'FOOT CHAIR COMBO': [
    { title: '15 Mins Feet + 15 Mins Chair', duration: '30', cost: '40' },
    { title: '30 Mins Feet + 10 Mins Chair', duration: '40', cost: '45' },
    { title: '30 Mins Feet + 20 Mins Chair', duration: '50', cost: '55' },
    { title: '30 Mins Feet + 30 Mins Chair', duration: '60', cost: '65' },
    { title: '60 Mins Feet + 10 Mins Chair', duration: '70', cost: '58' },
    { title: '60 Mins Feet + 20 Mins Chair', duration: '80', cost: '68' },
    { title: '60 Mins Feet + 30 Mins Chair', duration: '90', cost: '80' },
  ],
  'HAND CARE': [
    { title: '10 Mins Hand Care', duration: '10', cost: '15', oldTitles: ['Hand Care 10 Mins'] },
    { title: '15 Mins Hand Care', duration: '15', cost: '20', oldTitles: ['Hand Care 15 Mins'] },
    { title: '20 Mins Hand Care', duration: '20', cost: '25', oldTitles: ['Hand Care 20 Mins'] },
    { title: '30 Mins Hand Care', duration: '30', cost: '40', oldTitles: ['Hand Care 30 Mins'] },
  ],
  WAXING: [
    { title: '15 Mins Eyebrow Waxing', duration: '15', cost: '10', oldTitles: ['Eyebrow Waxing'] },
    { title: '10 Mins Lip Waxing', duration: '10', cost: '8', oldTitles: ['Lip Waxing'] },
    { title: '10 Mins Chin Waxing', duration: '10', cost: '16', oldTitles: ['Chin Waxing'] },
    { title: '30 Mins Face Waxing', duration: '30', cost: '40', oldTitles: ['Face Waxing'] },
    { title: '30 Mins Half Arm Waxing', duration: '30', cost: '30', oldTitles: ['Half Arm Waxing'] },
    { title: '45 Mins Full Arm Waxing', duration: '45', cost: '45', oldTitles: ['Full Arm Waxing'] },
    { title: '30 Mins Half Leg Waxing', duration: '30', cost: '45', oldTitles: ['Half Leg Waxing'] },
    { title: '60 Mins Full Leg Waxing', duration: '60', cost: '65', oldTitles: ['Full Leg Waxing'] },
    { title: '30 Mins Bikini Waxing', duration: '30', cost: '45', oldTitles: ['Bikini Waxing'] },
    { title: '45 Mins Brazilian Waxing', duration: '45', cost: '65', oldTitles: ['Brazilian Waxing'] },
  ],
};

function serviceCount() {
  return Object.values(SERVICES_PRICE_LIST).reduce((total, services) => total + services.length, 0);
}

function validateServicesPriceList(priceList) {
  for (const [category, services] of Object.entries(priceList)) {
    if (!category || !Array.isArray(services) || services.length === 0) {
      throw new Error(`分类数据格式不正确：${category}`);
    }

    for (const service of services) {
      if (!service.title || !service.duration || !service.cost) {
        throw new Error(`服务数据格式不正确：${JSON.stringify(service)}`);
      }
    }
  }
}

function hostnameOf(page) {
  try {
    return new URL(page.url()).hostname;
  } catch {
    return '';
  }
}

async function pickSetmorePage(browser) {
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => !page.isClosed());

  const setmorePage = pages.find((page) => SETMORE_URL_PATTERN.test(hostnameOf(page)));
  return setmorePage || pages[0];
}

async function clickByText(page, text, options = {}) {
  const locator = page.getByText(text, { exact: options.exact !== false }).first();
  if (await locator.isVisible({ timeout: 2000 }).catch(() => false)) {
    await locator.click();
    return;
  }

  await clickDomText(page, text, { exact: options.exact !== false, timeout: options.timeout || 15000 });
}

async function clickDomText(page, text, options = {}) {
  const timeout = options.timeout || 15000;
  const exact = options.exact !== false;
  await page.waitForFunction(
    ({ targetText, exactMatch }) => {
      const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('*')].some((element) => {
        const rect = element.getBoundingClientRect();
        const currentText = normalize(element.innerText || element.textContent || '');
        return rect.width > 0 && rect.height > 0 && (exactMatch ? currentText === targetText : currentText.includes(targetText));
      });
    },
    { targetText: text, exactMatch: exact },
    { timeout },
  );

  await page.evaluate(
    ({ targetText, exactMatch }) => {
      const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('*')]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const currentText = normalize(element.innerText || element.textContent || '');
          return rect.width > 0 && rect.height > 0 && (exactMatch ? currentText === targetText : currentText.includes(targetText));
        })
        .sort((first, second) => {
          const firstArea = first.getBoundingClientRect().width * first.getBoundingClientRect().height;
          const secondArea = second.getBoundingClientRect().width * second.getBoundingClientRect().height;
          return firstArea - secondArea;
        });

      const element = candidates[0];
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
    },
    { targetText: text, exactMatch: exact },
  );
}

async function clickNewServiceCategory(page) {
  await page.waitForFunction(() => document.body.innerText.includes('Services & classes'), null, { timeout: PAGE_READY_TIMEOUT });
  await page.waitForFunction(() => document.body.innerText.includes('New service category'), null, { timeout: PAGE_READY_TIMEOUT });

  const candidates = [
    page.getByText(/New service category/i).first(),
    page.getByRole('button', { name: /New service category/i }).first(),
    page.locator('text=/New service category/i').first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return;
    }
  }

  await clickDomText(page, 'New service category', { exact: false });
}

async function fillInput(page, label, value) {
  const exactLabelInput = page.locator(`xpath=//*[normalize-space()="${label}" or normalize-space()="${label} *"]/following::input[1]`).first();
  if (await exactLabelInput.isVisible().catch(() => false)) {
    await exactLabelInput.fill(value);
    return;
  }

  const byLabel = page.getByLabel(label, { exact: false }).first();
  if (await byLabel.isVisible().catch(() => false)) {
    await byLabel.fill(value);
    return;
  }

  const byPlaceholder = page.getByPlaceholder(new RegExp(label, 'i')).first();
  if (await byPlaceholder.isVisible().catch(() => false)) {
    await byPlaceholder.fill(value);
    return;
  }

  const inputNearLabel = page.locator(`xpath=//*[contains(normalize-space(), "${label}")]/following::input[1]`).first();
  await inputNearLabel.waitFor({ state: 'visible', timeout: 15000 });
  await inputNearLabel.fill(value);
}

async function visibleBodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function isServicesListPage(page) {
  const text = await visibleBodyText(page).catch(() => '');
  return text.includes('Services & classes') && text.includes('New service category') && !text.includes('Edit service') && !text.includes('New service\nService details');
}

async function goBackToServicesList(page, label = '返回 Services 列表') {
  if (await isServicesListPage(page)) {
    return;
  }

  logStep(label);
  const url = page.url();
  if (!url.includes('/settings/services')) {
    await page.goto('https://go.setmore.com/settings/services', { waitUntil: 'domcontentloaded', timeout: PAGE_READY_TIMEOUT });
  } else {
    const backButton = page.locator('button').filter({ hasText: /^$/ }).first();
    const clickedBack = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: (element.textContent || '').trim(), aria: element.getAttribute('aria-label') || '' }))
        .filter(({ rect, text, aria }) => rect.width > 0 && rect.height > 0
          && rect.x >= 620 && rect.x <= 700 && rect.y >= 45 && rect.y <= 100
          && !/save|delete|share|open/i.test(`${text} ${aria}`));
      const button = buttons[0];
      if (!button) return false;
      button.element.click();
      return true;
    });

    if (!clickedBack && await backButton.isVisible().catch(() => false)) {
      await backButton.click();
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(
    () => document.body.innerText.includes('Services & classes') && document.body.innerText.includes('New service category'),
    null,
    { timeout: PAGE_READY_TIMEOUT },
  );
  await waitForSetmoreIdle(page, label);
}

async function categoryExists(page, category) {
  const text = await visibleBodyText(page);
  return text.includes(category);
}

async function serviceExistsInCurrentCategory(page, serviceTitle) {
  const text = await visibleBodyText(page);
  return text.includes(serviceTitle);
}

async function getCurrentCategoryServiceNames(page, expectedServices) {
  const expectedTitles = expectedServices.flatMap((service) => [service.title, ...(service.oldTitles || [])]);
  const bodyText = await visibleBodyText(page);
  return expectedTitles.filter((title) => bodyText.includes(title));
}

async function deleteServiceByTitle(page, title) {
  logStep(`准备删除多余/旧命名服务：${title}`);

  if (!DELETE_EXTRA_SERVICES) {
    logStep(`DELETE_EXTRA_SERVICES 未开启，仅记录不删除：${title}`);
    return;
  }

  try {
    await clickByText(page, title, { timeout: 10000 });
    await waitForEditServiceReady(page, title);
    await page.screenshot({ path: path.join(__dirname, `delete-${title.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true });

    const clickedDelete = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')]
        .map((button) => ({ button, rect: button.getBoundingClientRect(), text: (button.textContent || '').trim(), aria: button.getAttribute('aria-label') || '' }))
        .filter(({ rect, text, aria }) => {
          const label = `${text} ${aria}`;
          const iconLike = rect.width > 0 && rect.height > 0 && rect.width <= 42 && rect.height <= 42;
          return iconLike && rect.y >= 45 && rect.y <= 95 && rect.x >= 1500 && rect.x <= 1660 && !/calendar|minimize|share|open/i.test(label);
        })
        .sort((first, second) => Math.abs(first.rect.x - 1605) - Math.abs(second.rect.x - 1605));
      const trash = buttons[0];
      if (!trash) return false;
      trash.button.click();
      return true;
    });

    if (!clickedDelete) {
      throw new Error('未找到服务详情页顶部垃圾桶按钮。');
    }

    await page.waitForFunction(
      () => document.body.innerText.includes('Yes, delete') || document.body.innerText.includes('Delete'),
      null,
      { timeout: 15000 },
    );

    const clickedConfirm = await page.evaluate(() => {
      const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .map((button) => ({ button, rect: button.getBoundingClientRect(), text: normalize(button.textContent || button.innerText || '') }))
        .filter(({ rect, text }) => rect.width > 0 && rect.height > 0 && /^(Yes, delete|Delete)$/i.test(text))
        .sort((first, second) => {
          const firstArea = first.rect.width * first.rect.height;
          const secondArea = second.rect.width * second.rect.height;
          return first.text.toLowerCase() === 'yes, delete' ? -1 : second.text.toLowerCase() === 'yes, delete' ? 1 : firstArea - secondArea;
        });

      const button = buttons[0];
      if (!button) return false;
      button.button.click();
      return true;
    });

    if (!clickedConfirm) {
      throw new Error('未找到删除确认弹窗按钮 Yes, delete。');
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await waitForSetmoreIdle(page, `删除 ${title} 后`);
    logStep(`已删除：${title}`);
  } catch (error) {
    await page.screenshot({ path: path.join(__dirname, `delete-failed-${title.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }).catch(() => {});
    logStep(`删除失败：${title} / ${error.message || error}`);
    throw error;
  }
}

async function updateOpenServiceForm(page, service, category) {
  logStep(`更新服务表单为：${service.title}`);
  recordAction('update-service-start', { category, title: service.title });
  await fillInput(page, 'Title', service.title);
  await fillInput(page, 'Duration', service.duration);
  await fillInput(page, 'Buffer time', '0');
  await fillInput(page, 'Cost', service.cost);

  if (!(await serviceExistsInCurrentCategory(page, category))) {
    await selectCategoryInForm(page, category);
  }

  await ensureOnlyTargetTeamSelected(page);

  const saveButton = page.getByRole('button', { name: /^Save$/ }).first();
  await saveButton.waitFor({ state: 'visible', timeout: 15000 });
  await saveButton.click();
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  recordAction('update-service-done', { category, title: service.title });
  await goBackToServicesList(page, `保存 ${service.title} 后返回 Services 列表`);
}

async function updateServiceByTitle(page, oldTitle, service, category) {
  logStep(`旧命名服务改名/更新：${oldTitle} -> ${service.title}`);
  await clickByText(page, oldTitle, { timeout: 10000 });
  await page.getByText('Edit service', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  await updateOpenServiceForm(page, service, category);
  logStep(`已更新旧命名服务：${oldTitle} -> ${service.title}`);
}

async function reconcileCurrentCategory(page, category, services) {
  const visibleKnownTitles = await getCurrentCategoryServiceNames(page, services);
  const targetTitles = new Set(services.map((service) => service.title));
  const oldTitles = new Set(services.flatMap((service) => service.oldTitles || []));

  for (const service of services) {
    if (await serviceExistsInCurrentCategory(page, service.title)) {
      logStep(`目标服务已存在：${category} / ${service.title}`);
      for (const oldTitle of service.oldTitles || []) {
        if (await serviceExistsInCurrentCategory(page, oldTitle)) {
          await deleteServiceByTitle(page, oldTitle);
          await createCategory(page, category);
        }
      }
      continue;
    }

    let updatedOldService = false;
    for (const oldTitle of service.oldTitles || []) {
      if (await serviceExistsInCurrentCategory(page, oldTitle)) {
        await updateServiceByTitle(page, oldTitle, service, category);
        await createCategory(page, category);
        updatedOldService = true;
        break;
      }
    }

    if (updatedOldService) {
      continue;
    }

    logStep(`目标服务缺失，准备新增：${category} / ${service.title}`);
    await createService(page, category, service);
  }

  for (const title of visibleKnownTitles) {
    if (oldTitles.has(title) && !targetTitles.has(title) && await serviceExistsInCurrentCategory(page, title)) {
      await deleteServiceByTitle(page, title);
      await createCategory(page, category);
    }
  }
}

async function createCategory(page, category) {
  await goBackToServicesList(page, `选择分类 ${category} 前确保在 Services 列表`);
  await waitForSetmoreIdle(page, `分类 ${category} 前`);
  logStep(`检查分类是否存在：${category}`);
  if (await categoryExists(page, category)) {
    logStep(`分类已存在，进入分类：${category}`);
    await clickByText(page, category);
    await waitForSetmoreIdle(page, `进入分类 ${category}`);
    await ensureTeamListingFilter(page);
    return;
  }

  logStep(`创建分类：${category}`);
  recordAction('create-category-start', { category });
  await clickNewServiceCategory(page);
  await fillInput(page, 'Title', category);
  const createButton = page.getByRole('button', { name: /^Create$/ }).last();
  await createButton.waitFor({ state: 'visible', timeout: 15000 });
  await createButton.click();
  await page.getByText(category, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
  await clickByText(page, category);
  await waitForSetmoreIdle(page, `创建并进入分类 ${category}`);
  await ensureTeamListingFilter(page);
  recordAction('create-category-done', { category });
}

async function ensureTeamListingFilter(page) {
  logStep('切换服务列表筛选为 Team');
  const selected = await page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const filterButton = [...document.querySelectorAll('button')]
      .map((button) => ({ button, rect: button.getBoundingClientRect(), text: normalize(button.textContent) }))
      .filter(({ rect, text }) => rect.width > 0 && rect.height > 0 && rect.x > 650 && rect.x < 900 && rect.y > 90 && rect.y < 180 && /team/i.test(text))
      .sort((first, second) => first.rect.x - second.rect.x)[0];

    if (!filterButton) {
      return 'not-found';
    }

    if (filterButton.text === 'Team') {
      return 'selected';
    }

    filterButton.button.click();
    return 'opened';
  });

  if (selected === 'not-found') {
    logStep('未找到 Team 筛选按钮，继续执行当前分类检查');
    return;
  }

  if (selected === 'opened') {
    await page.waitForTimeout(500);
    const clickedTeam = await page.evaluate(() => {
      const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const teamOption = [...document.querySelectorAll('*')]
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: normalize(element.textContent) }))
        .filter(({ rect, text }) => rect.width > 0 && rect.height > 0 && rect.x > 730 && rect.x < 950 && rect.y > 130 && rect.y < 230 && text === 'Team')
        .sort((first, second) => {
          const firstArea = first.rect.width * first.rect.height;
          const secondArea = second.rect.width * second.rect.height;
          return firstArea - secondArea;
        })[0];

      if (!teamOption) {
        return false;
      }

      teamOption.element.click();
      return true;
    });

    if (!clickedTeam) {
      logStep('未能在筛选菜单中选择 Team，继续执行当前分类检查');
      return;
    }
  }

  await page.waitForTimeout(1000);

  const isTeamSelected = await page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('button')].some((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.x > 650 && rect.x < 900 && rect.y > 90 && rect.y < 180 && normalize(button.textContent) === 'Team';
    });
  });

  if (!isTeamSelected) {
    logStep('服务列表筛选未验证为 Team，继续执行当前分类检查');
  }
}

async function openNewServiceForm(page) {
  await goBackToServicesList(page, '打开新服务前确保在 Services 列表');
  await waitForSetmoreIdle(page, '打开服务表单前');
  if (await page.getByText('New service', { exact: true }).isVisible().catch(() => false)) {
    return;
  }

  if (await page.getByText('New category', { exact: true }).isVisible().catch(() => false)) {
    logStep('检测到误开的 New category 弹窗，关闭后重试');
    await page.keyboard.press('Escape');
    await page.getByText('New category', { exact: true }).waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  logStep('打开右上角新增菜单');
  const clickedMenu = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button, [role="button"]')]
      .map((element) => ({
        element,
        rect: element.getBoundingClientRect(),
        aria: element.getAttribute('aria-label') || '',
        title: element.getAttribute('title') || '',
      }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .filter(({ rect, aria, title }) => {
        const topRight = rect.x > window.innerWidth - 130 && rect.y >= 45 && rect.y <= 100;
        const iconSized = rect.width >= 28 && rect.width <= 56 && rect.height >= 28 && rect.height <= 56;
        const label = `${aria} ${title}`;
        return topRight && iconSized && !/upload|more|menu|copy|share/i.test(label);
      })
      .sort((first, second) => {
        const firstDistance = Math.abs((first.rect.x + first.rect.width / 2) - (window.innerWidth - 82));
        const secondDistance = Math.abs((second.rect.x + second.rect.width / 2) - (window.innerWidth - 82));
        return firstDistance - secondDistance;
      });
    const button = candidates[0];
    if (!button) return false;
    button.element.scrollIntoView({ block: 'center', inline: 'center' });
    button.element.click();
    return true;
  });

  if (!clickedMenu) {
    const viewport = page.viewportSize() || { width: 1920, height: 1080 };
    const plusX = viewport.width - 82;
    const plusY = 72;
    logStep(`未识别新增菜单按钮，坐标兜底点击：${plusX},${plusY}`);
    await page.mouse.click(plusX, plusY);
  }

  await page.waitForTimeout(1000);

  if (await page.getByText('New category', { exact: true }).isVisible().catch(() => false)) {
    await saveFailureScreenshot(page, 'opened-new-category-instead-of-service-menu');
    await page.keyboard.press('Escape');
    throw new Error('误打开 New category 弹窗，已关闭。');
  }

  if (!(await page.getByText('Service', { exact: true }).first().isVisible().catch(() => false))) {
    await saveFailureScreenshot(page, 'open-service-form-failed');
    throw new Error('点击右上角 + 后未出现 Service 选项。');
  }

  await clickByText(page, 'Service', { timeout: 10000 });
  await waitForSetmoreIdle(page, 'New service 表单');
}

async function ensureOnlyTargetTeamSelected(page) {
  logStep(`选择 Team：${TEAM_NAME}`);
  await page.getByText('Who will provide this service?', { exact: true }).waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  async function checkboxByTeamName(name) {
    const text = xpathLiteral(name);
    const checkbox = page.locator(`xpath=(//*[normalize-space()=${text}])[last()]/preceding::input[@type="checkbox"][1]`).last();
    if (await checkbox.isVisible({ timeout: 2000 }).catch(() => false)) return checkbox;

    const roleCheckbox = page.locator(`xpath=(//*[normalize-space()=${text}])[last()]/preceding::*[@role="checkbox"][1]`).last();
    if (await roleCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) return roleCheckbox;

    const label = page.locator('label', { hasText: name }).last();
    if (await label.isVisible({ timeout: 2000 }).catch(() => false)) return label.locator('input[type="checkbox"], [role="checkbox"]').first();

    return null;
  }

  async function checked(locator) {
    if (!locator) return false;
    if (await locator.evaluate((element) => element instanceof HTMLInputElement).catch(() => false)) {
      return locator.isChecked().catch(() => false);
    }
    return locator.getAttribute('aria-checked').then((value) => value === 'true').catch(() => false);
  }

  async function setChecked(locator, value, label) {
    if (!locator) return false;
    if (await checked(locator) === value) return true;

    if (await locator.evaluate((element) => element instanceof HTMLInputElement).catch(() => false)) {
      await locator.setChecked(value, { timeout: 10000, force: true });
    } else {
      await locator.click({ timeout: 10000 });
    }

    await page.waitForTimeout(300);
    const ok = await checked(locator) === value;
    if (!ok) recordAction('team-select-warning', { team: label, expected: value });
    return ok;
  }

  const defaultCheckbox = await checkboxByTeamName('team');
  await setChecked(defaultCheckbox, false, 'team');

  const targetCheckbox = await checkboxByTeamName(TEAM_NAME);
  if (!targetCheckbox) {
    recordAction('team-select-warning', { team: TEAM_NAME, result: 'target-not-found' });
    await saveFailureScreenshot(page, 'team-selection-warning');
    return;
  }

  await setChecked(targetCheckbox, true, TEAM_NAME);
}

async function selectCategoryInForm(page, category) {
  const categoryField = page.locator('xpath=//*[normalize-space()="Category"]/following::*[@role="button" or self::button or self::div][1]').first();
  await categoryField.waitFor({ state: 'visible', timeout: 15000 });
  await categoryField.click();
  await clickByText(page, category);
}

async function createService(page, category, service) {
  if (await serviceExistsInCurrentCategory(page, service.title)) {
    logStep(`服务已存在，跳过：${category} / ${service.title}`);
    recordAction('service-exists', { category, title: service.title });
    return;
  }

  logStep('打开 New service 表单');
  recordAction('create-service-start', { category, title: service.title, duration: service.duration, cost: service.cost });
  await openNewServiceForm(page);
  await page.screenshot({ path: path.join(__dirname, 'step-after-open-service.png'), fullPage: true });
  await page.getByText('New service', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  logStep('填写服务标题');
  await fillInput(page, 'Title', service.title);
  logStep('填写时长');
  await fillInput(page, 'Duration', service.duration);
  logStep('填写 Buffer time = 0');
  await fillInput(page, 'Buffer time', '0');
  logStep('填写价格');
  await fillInput(page, 'Cost', service.cost);
  logStep('选择分类');
  await selectCategoryInForm(page, category);
  await ensureOnlyTargetTeamSelected(page);

  logStep('点击 Create 提交服务');
  const createButton = page.getByRole('button', { name: /^Create$/ }).first();
  await createButton.waitFor({ state: 'visible', timeout: 15000 });
  await createButton.click();
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(
    () => document.body.innerText.includes('Services & classes') || !document.body.innerText.includes('New service'),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  recordAction('create-service-done', { category, title: service.title });
  await goBackToServicesList(page, `创建 ${service.title} 后返回 Services 列表`);
}

async function uploadServices(page) {
  let processed = 0;

  for (const [category, services] of Object.entries(SERVICES_PRICE_LIST)) {
    logStep(`创建/选择分类：${category}`);
    await createCategory(page, category);

    if (LIMIT_SERVICES === 0) {
      await reconcileCurrentCategory(page, category, services);
      continue;
    }

    for (const service of services) {
      if (LIMIT_SERVICES > 0 && processed >= LIMIT_SERVICES) {
        logStep(`已达到 LIMIT_SERVICES=${LIMIT_SERVICES}，停止本次运行。`);
        return;
      }

      logStep(`录入服务：${category} / ${service.title}`);
      await createService(page, category, service);
      processed += 1;
    }
  }
}

async function waitForServicesPage(page) {
  logStep('已连接到现有 Chrome 调试端口。');
  logStep(`当前接管标签页：${page.url() || '(空白页)'}`);

  if (!AUTO_START) {
    const rl = readline.createInterface({ input, output });
    console.log('请在该浏览器中手动进入目标店铺的 Setmore Services 页面。');
    await rl.question('进入 Services 页面后，请在此控制台按回车开始批量录入...');
    rl.close();
  }

  await page.bringToFront();
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await waitForSetmoreIdle(page, 'Setmore 初始页面');
  await page.waitForFunction(
    () => document.body.innerText.includes('Services & classes') || document.body.innerText.includes('New service'),
    null,
    { timeout: PAGE_READY_TIMEOUT },
  );
  await waitForSetmoreIdle(page, 'Services 页面');

  const hostname = hostnameOf(page);
  if (!SETMORE_URL_PATTERN.test(hostname)) {
    throw new Error(`当前页面不是 Setmore 域名：${page.url()}`);
  }

  logStep(`已准备接管 Setmore 页面：${page.url()}`);
  logStep(`已加载 ${Object.keys(SERVICES_PRICE_LIST).length} 个分类、${serviceCount()} 个服务。`);
  await uploadServices(page);
  logStep('全部服务录入流程已执行完成。');
}

async function main() {
  validateServicesPriceList(SERVICES_PRICE_LIST);
  fs.writeFileSync(RUN_LOG, '');
  fs.writeFileSync(ACTION_LOG, '');
  let page;
  let contextToClose;
  let browserToClose;

  if (USE_PERSISTENT_CONTEXT) {
    const chromeCandidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    const chromePath = chromeCandidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (!chromePath) {
      throw new Error('未找到 Chrome。');
    }

    console.log(`正在启动独立持久浏览器：${USER_DATA_DIR}`);
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      executablePath: chromePath,
      headless: false,
      viewport: { width: 1920, height: 1080 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', '--start-maximized', '--window-size=1920,1080'],
    });
    contextToClose = context;
    page = context.pages()[0] || await context.newPage();
    await page.goto('https://go.setmore.com/settings/services', { waitUntil: 'domcontentloaded', timeout: PAGE_READY_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await waitForSetmoreIdle(page, '导航后 Services 页面');
  } else {
    console.log(`正在连接现有 CDP 端口：${CDP_ENDPOINT}`);
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    browserToClose = browser;
    page = await pickSetmorePage(browser);
  }

  if (!page) {
    throw new Error('已连接浏览器，但没有找到可用标签页。');
  }

  try {
    await waitForServicesPage(page);
  } finally {
    await contextToClose?.close().catch(() => {});
    await browserToClose?.close().catch(() => {});
  }
}

main().catch((error) => {
  try {
    logStep(`脚本失败：${error.message || error}`);
    recordAction('script-failed', { error: error.message || String(error) });
  } catch {}
  console.error(error.message || error);
  process.exit(1);
});