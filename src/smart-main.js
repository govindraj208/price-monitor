const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { cleanPrice, randomDelay, getTimestamp } = require('./utils');

// Simple title similarity (0 to 1)
function titleSimilarity(a = '', b = '') {
  a = a.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  b = b.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));
  if (wordsA.length === 0) return 0;
  let match = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) match++; });
  return match / wordsA.length;
}

function getConfidence(score) {
  if (score >= 0.65) return 'High';
  if (score >= 0.40) return 'Medium';
  return 'Low';
}

function extractAmazonASIN(url = '') {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  return match ? match[1] : null;
}

function extractNoonId(url = '') {
  const match = url.match(/\/([A-Z0-9]{10,})\/p\//i) || url.match(/\/([A-Z0-9]{10,})\?/i);
  return match ? match[1] : null;
}

function looksLikeAmazonLink(link = '') {
  return /amazon\.|amzn\./i.test(link);
}

function looksLikeNoonLink(link = '') {
  return /noon\.com/i.test(link);
}

function normalizeUrl(link = '') {
  link = link.trim();
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  return link;
}

async function scrapeDirectAmazon(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Detect bot-check / captcha page
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/enter the characters you see|api-services-support@amazon|automated access/i.test(bodyText)) {
      return { price: null, title: null, url: page.url(), asin: extractAmazonASIN(page.url()), status: 'direct_captcha' };
    }

    // amzn.eu short links land on a non-.ae marketplace; rebuild the URL for amazon.ae
    let finalUrl = page.url();
    const asin = extractAmazonASIN(finalUrl);
    if (asin && !finalUrl.includes('amazon.ae')) {
      finalUrl = `https://www.amazon.ae/dp/${asin}`;
      await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);
    }

    const priceText = await page.locator('#corePrice_feature_div .a-offscreen, #priceblock_ourprice, #priceblock_saleprice, .a-price .a-offscreen').first().textContent().catch(() => null);
    const title = await page.locator('#productTitle').first().textContent().catch(() => null);

    return {
      price: cleanPrice(priceText),
      title: title ? title.trim() : null,
      url: page.url(),
      asin: extractAmazonASIN(page.url()) || asin,
      status: priceText ? 'direct_success' : 'direct_no_price'
    };
  } catch (e) {
    return { price: null, title: null, url: null, asin: null, status: 'direct_error' };
  }
}

async function scrapeDirectNoon(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    const priceText = await page.locator('[data-qa="div-price-now"], .priceNow').first().textContent().catch(() => null);
    const title = await page.locator('[data-qa="pdp-product-name"], h1').first().textContent().catch(() => null);

    return {
      price: cleanPrice(priceText),
      title: title ? title.trim() : null,
      url: page.url(),
      id: extractNoonId(page.url()),
      status: priceText ? 'direct_success' : 'direct_no_price'
    };
  } catch (e) {
    return { price: null, title: null, url: null, id: null, status: 'direct_error' };
  }
}

async function searchAndPickAmazon(page, productTitle) {
  try {
    const searchUrl = `https://www.amazon.ae/s?k=${encodeURIComponent(productTitle)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const cards = page.locator('[data-component-type="s-search-result"]');
    const count = await cards.count();

    if (count === 0) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const blocked = /enter the characters you see|automated access/i.test(bodyText);
      return { price: null, title: null, url: null, asin: null, confidence: 'Low', status: blocked ? 'search_captcha' : 'search_not_found' };
    }

    let best = { score: 0, price: null, title: null, url: null, asin: null };

    for (let i = 0; i < Math.min(count, 8); i++) {
      const card = cards.nth(i);
      // innerText of the whole h2 is more reliable than the first inner span,
      // which is sometimes just the brand name
      const title = (await card.locator('h2').first().innerText().catch(() => '')) || '';
      const priceText = await card.locator('.a-price .a-offscreen').first().textContent().catch(() => null);
      const dataAsin = await card.getAttribute('data-asin').catch(() => null);
      let href = await card.locator('h2 a').first().getAttribute('href').catch(() => null);
      let fullUrl = href ? (href.startsWith('http') ? href : `https://www.amazon.ae${href}`) : null;
      const asin = dataAsin || extractAmazonASIN(fullUrl || '');
      if (asin) fullUrl = `https://www.amazon.ae/dp/${asin}`;
      const score = titleSimilarity(productTitle, title);

      if (score > best.score && priceText) {
        best = {
          score,
          price: cleanPrice(priceText),
          title: title.trim(),
          url: fullUrl,
          asin
        };
      }
    }

    return {
      price: best.price,
      title: best.title,
      url: best.url,
      asin: best.asin,
      confidence: getConfidence(best.score),
      status: best.price ? 'search_success' : 'search_not_found'
    };
  } catch (e) {
    return { price: null, title: null, url: null, asin: null, confidence: 'Low', status: 'search_error' };
  }
}

async function searchAndPickNoon(page, productTitle) {
  try {
    const searchUrl = `https://www.noon.com/uae-en/search?q=${encodeURIComponent(productTitle)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);

    const titles = page.locator('[data-qa="product-name"]');
    const count = await titles.count();
    let best = { score: 0, price: null, title: null, url: null, id: null };

    for (let i = 0; i < Math.min(count, 6); i++) {
      const titleEl = titles.nth(i);
      const title = await titleEl.textContent().catch(() => '');
      const parent = titleEl.locator('xpath=ancestor::a[1]');
      const href = await parent.getAttribute('href').catch(() => null);
      const fullUrl = href ? (href.startsWith('http') ? href : `https://www.noon.com${href}`) : null;

      // Price is usually near the card
      const priceText = await page.locator('[data-qa="div-price-now"]').nth(i).textContent().catch(() => null);
      const score = titleSimilarity(productTitle, title || '');

      if (score > best.score && priceText) {
        best = {
          score,
          price: cleanPrice(priceText),
          title: title ? title.trim() : null,
          url: fullUrl,
          id: extractNoonId(fullUrl || '')
        };
      }
    }

    return {
      price: best.price,
      title: best.title,
      url: best.url,
      id: best.id,
      confidence: getConfidence(best.score),
      status: best.price ? 'search_success' : 'search_not_found'
    };
  } catch (e) {
    return { price: null, title: null, url: null, id: null, confidence: 'Low', status: 'search_error' };
  }
}

async function run() {
  console.log('Starting SMART Price Monitor (Direct links preferred + smart search)...\n');

  const MAX_PRODUCTS = Number.parseInt(process.argv[2], 10) || 5;

  const INPUT_CSV = path.join(__dirname, '..', 'Copy of Price Comparison UAE - Sheet2.csv');
  if (!fs.existsSync(INPUT_CSV)) {
    throw new Error(`Input CSV not found: ${INPUT_CSV}`);
  }

  const products = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(INPUT_CSV)
      .pipe(csv())
      .on('data', row => products.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  const limit = Math.min(products.length, MAX_PRODUCTS);
  console.log(`Loaded ${products.length} products. Processing first ${limit}...\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 40 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();
  const results = [];

  for (let i = 0; i < limit; i++) {
    const p = products[i];
    const sku = p['SKU'] || '';
    const title = p['Product Title'] || '';
    const ourPrice = parseFloat((p['OurShopee Price'] || '0').toString().replace(/,/g, ''));
    const ourLink = p['OurShopee Link'] || '';
    const amazonLink = p['Amazon Link'] || '';
    const noonLink = p['Noon Link'] || '';

    console.log(`\n[${i + 1}/${limit}] ${sku}`);
    console.log(`Title: ${title.substring(0, 65)}...`);

    // ----- Amazon -----
    let amazonData;
    if (looksLikeAmazonLink(amazonLink)) {
      console.log('  → Amazon (direct link)');
      amazonData = await scrapeDirectAmazon(page, normalizeUrl(amazonLink));
      amazonData.confidence = amazonData.status === 'direct_success' ? 'High' : 'Low';
      if (amazonData.status !== 'direct_success') {
        console.log(`    direct failed (${amazonData.status}), falling back to search`);
        amazonData = await searchAndPickAmazon(page, title);
      }
    } else {
      console.log('  → Amazon (smart search)');
      amazonData = await searchAndPickAmazon(page, title);
    }
    await randomDelay(4000, 7000);

    // ----- Noon -----
    let noonData;
    if (looksLikeNoonLink(noonLink)) {
      console.log('  → Noon (direct link)');
      noonData = await scrapeDirectNoon(page, normalizeUrl(noonLink));
      noonData.confidence = noonData.status === 'direct_success' ? 'High' : 'Low';
      if (noonData.status !== 'direct_success') {
        console.log(`    direct failed (${noonData.status}), falling back to search`);
        noonData = await searchAndPickNoon(page, title);
      }
    } else {
      console.log('  → Noon (smart search)');
      noonData = await searchAndPickNoon(page, title);
    }
    await randomDelay(4000, 7000);

    const best = (amazonData.price && noonData.price)
      ? Math.min(amazonData.price, noonData.price)
      : (amazonData.price || noonData.price || null);

    const diff = (best !== null && ourPrice) ? (best - ourPrice).toFixed(2) : null;

    results.push({
      SKU: sku,
      Product_Title: title,
      OurShopee_Price: ourPrice,
      OurShopee_Link: ourLink,
      Amazon_Price: amazonData.price,
      Amazon_ASIN: amazonData.asin,
      Amazon_Matched_Title: amazonData.title,
      Amazon_URL: amazonData.url,
      Amazon_Confidence: amazonData.confidence,
      Noon_Price: noonData.price,
      Noon_Product_ID: noonData.id,
      Noon_Matched_Title: noonData.title,
      Noon_URL: noonData.url,
      Noon_Confidence: noonData.confidence,
      Best_Competitor_Price: best,
      Price_Difference: diff,
      Amazon_Status: amazonData.status,
      Noon_Status: noonData.status
    });

    console.log(`  Amazon: ${amazonData.price} (${amazonData.confidence}) | Noon: ${noonData.price} (${noonData.confidence})`);
  }

  const resultsDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const outputFile = path.join(resultsDir, `smart_price_report_${getTimestamp()}.csv`);
  const csvWriter = createCsvWriter({
    path: outputFile,
    header: [
      { id: 'SKU', title: 'SKU' },
      { id: 'Product_Title', title: 'Product Title' },
      { id: 'OurShopee_Price', title: 'OurShopee Price' },
      { id: 'OurShopee_Link', title: 'OurShopee Link' },
      { id: 'Amazon_Price', title: 'Amazon Price' },
      { id: 'Amazon_ASIN', title: 'Amazon ASIN' },
      { id: 'Amazon_Matched_Title', title: 'Amazon Matched Title' },
      { id: 'Amazon_URL', title: 'Amazon URL' },
      { id: 'Amazon_Confidence', title: 'Amazon Confidence' },
      { id: 'Noon_Price', title: 'Noon Price' },
      { id: 'Noon_Product_ID', title: 'Noon Product ID' },
      { id: 'Noon_Matched_Title', title: 'Noon Matched Title' },
      { id: 'Noon_URL', title: 'Noon URL' },
      { id: 'Noon_Confidence', title: 'Noon Confidence' },
      { id: 'Best_Competitor_Price', title: 'Best Competitor Price' },
      { id: 'Price_Difference', title: 'Price Difference' },
      { id: 'Amazon_Status', title: 'Amazon Status' },
      { id: 'Noon_Status', title: 'Noon Status' }
    ]
  });

  await csvWriter.writeRecords(results);
  console.log(`\nResults saved to: ${outputFile}`);
  await browser.close();
  console.log('Done!');
}

run().catch(console.error);
