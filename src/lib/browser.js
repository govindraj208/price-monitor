// Browser lifecycle, bot-detection avoidance and shared helpers.

const { chromium } = require('playwright');
const { HEADERS, TIMEOUTS } = require('../config');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function randomDelay([min, max]) {
  return sleep(min + Math.random() * (max - min));
}

async function launch({ headless = false } = {}) {
  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 30,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-http2',
    ],
  });

  const context = await browser.newContext({
    userAgent: HEADERS['User-Agent'],
    locale: 'en-US',
    timezoneId: 'Asia/Dubai',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': HEADERS['Accept-Language'] },
  });

  // Playwright sets navigator.webdriver, which is the easiest bot tell to check.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUTS.navigation);

  return { browser, context, page };
}

// Retail sites front their catalogue with a consent wall; results do not render
// until it is cleared.
async function dismissCookieBanner(page) {
  const selectors = [
    'button:has-text("ACCEPT ALL")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    '[data-qa="accept-button"]',
    '#onetrust-accept-btn-handler',
    'button:has-text("I agree")',
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.count().catch(() => 0)) {
      await button.click({ timeout: 4000 }).catch(() => {});
      await sleep(1200);
      return true;
    }
  }
  return false;
}

const CAPTCHA_PATTERNS = [
  /enter the characters you see/i,
  /automated access/i,
  /api-services-support@amazon/i,
  /to discuss automated access/i,
  /unusual traffic/i,
  /are you a robot/i,
  /please verify you are a human/i,
  /captcha/i,
];

async function isBlocked(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return CAPTCHA_PATTERNS.some(re => re.test(text));
}

async function goto(page, url, { settle = TIMEOUTS.settle, timeout = 25000 } = {}) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    // If domcontentloaded timed out but the page is already rendering, continue
    if (!/net::ERR_|DNS_/i.test(err.message)) {
      // page is partially loaded, continue
    } else {
      throw err;
    }
  }
  await sleep(settle);
}

// Re-run an operation a few times with backoff. Retries matter most in headless
// mode, where bot challenges are far more frequent.
async function withRetry(label, fn, { attempts = 3, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn(attempt);
      if (result) return result;
      lastError = new Error(`${label}: empty result`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      if (onRetry) await onRetry(attempt, lastError);
      await sleep(TIMEOUTS.retryDelay * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

module.exports = {
  launch,
  sleep,
  randomDelay,
  dismissCookieBanner,
  isBlocked,
  goto,
  withRetry,
};
