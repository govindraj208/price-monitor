// Noon UAE search scraper.
//
// Two things make Noon awkward:
//  1. A consent wall blocks the catalogue until dismissed.
//  2. It is a client-rendered SPA that paints "recommended" products first and
//     only then swaps in the actual search results. Scraping too early returns
//     plausible-looking but completely unrelated items.
//
// So we wait for the grid to hydrate and stop changing before reading it.
// Class names are hashed CSS modules (_title_i1yaq_19), hence substring matches.

const { goto, dismissCookieBanner, isBlocked } = require('../browser');

const TITLE_SELECTOR = 'h2[class*="_title_"], [data-qa="product-name"]';
const PRODUCT_HREF_RE = /\/([A-Za-z0-9]{10,})\/p\//i;

function searchUrl(query) {
  return `https://www.noon.com/uae-en/search/?q=${encodeURIComponent(query)}`;
}

function absolute(href) {
  if (!href) return null;
  return href.startsWith('http') ? href : `https://www.noon.com${href}`;
}

function extractNoonId(url = '') {
  const m = url.match(PRODUCT_HREF_RE);
  return m ? m[1].toUpperCase() : null;
}

async function countProductCards(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('a[href*="/p/"]')]
      .filter(a => /\/[A-Za-z0-9]{10,}\/p\//i.test(a.getAttribute('href') || '')).length
  );
}

// Scroll through the grid so lazy images resolve, then wait until the card
// count stops changing - that is the signal the real results have arrived.
async function waitForGrid(page, { maxAttempts = 8 } = {}) {
  await page.waitForSelector(TITLE_SELECTOR, { timeout: 20000 }).catch(() => {});

  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1100).catch(() => {});
    await page.waitForTimeout(1300);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(1200);

  let previous = -1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await countProductCards(page);
    if (current > 0 && current === previous) return current;
    previous = current;
    await page.waitForTimeout(1500);
  }
  return previous;
}

// Noon sets loading="lazy" on product photos, so cards that have never been
// scrolled into view have no usable src. Walk the grid so the images actually
// resolve - without this the photo signal silently drops out.
async function warmImages(page, { max = 24 } = {}) {
  for (let pass = 0; pass < 2; pass++) {
    await page.evaluate(async (limit) => {
      const images = [...document.querySelectorAll('a[href*="/p/"] img')].slice(0, limit);
      for (const img of images) {
        img.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 90));
      }
    }, max).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(600);
}

async function countLoadedImages(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('a[href*="/p/"] img')]
      .filter(i => /^https?:\/\//.test(i.getAttribute('src') || '')).length
  );
}

async function searchCandidates(page, query, limit = 10) {
  // First try Noon's fast catalog API via browser evaluate
  try {
    const apiResults = await page.evaluate(async ({ q, max }) => {
      try {
        const res = await fetch(`https://www.noon.com/_svc/catalog/api/v3/u/search?q=${encodeURIComponent(q)}&limit=${max}&locale=en-ae`, {
          headers: { 'Accept': 'application/json' },
        });
        if (res.ok) {
          const data = await res.json();
          const hits = data.hits || [];
          return hits.map(h => ({
            id: h.sku || h.product_code || h.id || '',
            title: h.name || h.title || '',
            priceRaw: h.price ? String(h.price) : null,
            image: h.image_key ? `https://f.nooncdn.com/p/${h.image_key}.jpg` : null,
            href: `/${h.sku || h.product_code}/p/`,
            rating: h.product_rating ? String(h.product_rating.avg_rating || '') : null,
          }));
        }
      } catch (e) {
        // fallback to DOM
      }
      return null;
    }, { q: query, max: limit });

    if (apiResults && apiResults.length > 0) {
      return apiResults.map(c => ({
        source: 'noon',
        title: c.title,
        priceRaw: c.priceRaw,
        url: absolute(c.href),
        id: c.id,
        image: c.image,
        rating: c.rating,
      }));
    }
  } catch (err) {
    // continue to DOM search
  }

  // DOM search fallback
  await goto(page, searchUrl(query), { settle: 3000, timeout: 20000 });
  await dismissCookieBanner(page);
  await waitForGrid(page, { maxAttempts: 4 });
  await warmImages(page, { max: 12 });

  if (await isBlocked(page)) {
    const error = new Error('Noon returned a bot challenge');
    error.code = 'BLOCKED';
    throw error;
  }

  const raw = await page.evaluate(({ max, titleSelector }) => {
    const seen = new Set();
    const out = [];

    // Find all product card anchor links first
    const anchors = [];
    document.querySelectorAll('a[href*="/p/"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (/\/([A-Za-z0-9]{10,})\/p\//i.test(href) && !anchors.includes(a)) {
        anchors.push(a);
      }
    });

    // Also look up via title selector in case anchor is parent/ancestor
    document.querySelectorAll(titleSelector).forEach(titleEl => {
      const a = titleEl.closest('a[href*="/p/"]') || titleEl.querySelector('a[href*="/p/"]');
      if (a && !anchors.includes(a)) anchors.push(a);
    });

    for (const anchor of anchors) {
      if (out.length >= max) break;

      const href = anchor.getAttribute('href') || '';
      const idMatch = href.match(/\/([A-Za-z0-9]{10,})\/p\//i);
      if (!idMatch || seen.has(href)) continue;

      // Extract title: from data-qa, title classes, h2/h3, or image alt
      let title = '';
      const tEl = anchor.querySelector(titleSelector)
        || anchor.querySelector('[data-qa="product-name"], h2, h3, [class*="_title_"], [class*="productTitle"], [class*="name"]');
      if (tEl && tEl.innerText) title = tEl.innerText.trim();

      const img = anchor.querySelector('img');
      if (!title && img && img.getAttribute('alt')) {
        title = img.getAttribute('alt').trim();
      }

      if (!title) {
        const text = (anchor.innerText || '').replace(/\s+/g, ' ').trim();
        // Take lines that look like product titles (not prices or badges)
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 8 && !/^(?:AED|SAR|\d|\+)/.test(l));
        if (lines.length) title = lines[0];
      }

      title = (title || '').replace(/\s+/g, ' ').trim();
      if (!title || title.length < 3) continue;

      // Prefer a real http(s) URL; fall back through the lazy-load attributes.
      const pickImage = () => {
        if (!img) return null;
        const src = img.getAttribute('src') || '';
        if (/^https?:\/\//.test(src)) return src;
        const srcset = img.getAttribute('srcset') || '';
        const first = srcset.split(',')[0]?.trim().split(' ')[0];
        if (first && /^https?:\/\//.test(first)) return first;
        const dataSrc = img.getAttribute('data-src') || '';
        return /^https?:\/\//.test(dataSrc) ? dataSrc : null;
      };
      const image = pickImage();

      let priceRaw = null;
      const amountEl = anchor.querySelector('[class*="_amount_"], [data-qa="product-price"], [class*="priceNow"], [class*="sellingPrice"]');
      if (amountEl) {
        const wrapper = amountEl.parentElement || amountEl;
        const text = (wrapper.innerText || amountEl.innerText || '').replace(/\s+/g, ' ').trim();
        const m = text.match(/\d[\d,]*(?:\.\d{1,2})?/);
        priceRaw = m ? m[0] : null;
      }
      if (!priceRaw) {
        for (const el of anchor.querySelectorAll('[class*="price"] span, [class*="price"] strong, [class*="amount"] span, strong')) {
          const t = (el.innerText || '').replace(/\s+/g, '').trim();
          if (/^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/.test(t)) { priceRaw = t; break; }
        }
      }
      if (!priceRaw) {
        const m = (anchor.innerText || '').match(/(?:AED|SAR)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
        if (m) priceRaw = m[1];
      }

      const ratingEl = anchor.querySelector('[class*="_textCtr_"], [data-qa*="rating"]');

      seen.add(href);
      out.push({
        id: idMatch[1].toUpperCase(),
        title,
        priceRaw,
        image,
        href,
        rating: ratingEl ? (ratingEl.innerText || '').trim().slice(0, 5) : null,
      });
    }

    return out;
  }, { max: limit, titleSelector: TITLE_SELECTOR });

  return raw.map(c => ({
    source: 'noon',
    title: c.title,
    priceRaw: c.priceRaw,
    url: absolute(c.href),
    id: c.id,
    image: c.image,
    rating: c.rating,
  }));
}

module.exports = { searchCandidates, searchUrl, absolute, extractNoonId, waitForGrid };
