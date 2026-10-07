const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { cleanPrice, randomDelay, getTimestamp } = require('./utils');

async function searchAmazon(page, productTitle) {
  try {
    const searchUrl = `https://www.amazon.ae/s?k=${encodeURIComponent(productTitle)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Multiple possible price selectors
    let priceText = null;
    const priceSelectors = [
      '.a-price .a-offscreen',
      '.a-price-whole',
      'span.a-price > span.a-offscreen'
    ];

    for (const sel of priceSelectors) {
      priceText = await page.locator(sel).first().textContent().catch(() => null);
      if (priceText) break;
    }

    const title = await page.locator('h2 a span').first().textContent().catch(() => null);

    return {
      amazon_price: cleanPrice(priceText),
      amazon_title: title ? title.trim().substring(0, 100) : null,
      amazon_status: priceText ? 'success' : 'not_found'
    };
  } catch (error) {
    return { amazon_price: null, amazon_title: null, amazon_status: 'error' };
  }
}

async function searchNoon(page, productTitle) {
  try {
    const searchUrl = `https://www.noon.com/uae-en/search?q=${encodeURIComponent(productTitle)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Try several common Noon selectors
    let priceText = null;
    const priceSelectors = [
      '[data-qa="div-price-now"]',
      '.priceNow',
      'strong.amount',
      '[class*="price"]'
    ];

    for (const sel of priceSelectors) {
      priceText = await page.locator(sel).first().textContent().catch(() => null);
      if (priceText && priceText.match(/\d/)) break;
    }

    const title = await page.locator('[data-qa="product-name"]').first().textContent().catch(() => null);

    return {
      noon_price: cleanPrice(priceText),
      noon_title: title ? title.trim().substring(0, 100) : null,
      noon_status: priceText ? 'success' : 'not_found'
    };
  } catch (error) {
    return { noon_price: null, noon_title: null, noon_status: 'error' };
  }
}

async function run() {
  console.log('Starting FULLY AUTOMATED Price Monitor (Improved)...\n');

  const MAX_PRODUCTS = 5; // Keep low for testing

  const products = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream('Price Comparison UAE - Price Comparison.csv')
      .pipe(csv())
      .on('data', (row) => products.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  console.log(`Loaded ${products.length} products`);
  console.log(`Processing first ${MAX_PRODUCTS} products...\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();
  const results = [];

  for (let i = 0; i < Math.min(products.length, MAX_PRODUCTS); i++) {
    const product = products[i];
    const title = product['Product Title'] || '';
    const sku = product['SKU'] || '';
    const ourPrice = parseFloat((product['OurShopee Price'] || '0').toString().replace(/,/g, ''));

    console.log(`[${i + 1}/${MAX_PRODUCTS}] ${sku}`);
    console.log(`Title: ${title.substring(0, 60)}...`);

    console.log('  → Amazon...');
    const amazonData = await searchAmazon(page, title);
    await randomDelay(5000, 8000);

    console.log('  → Noon...');
    const noonData = await searchNoon(page, title);
    await randomDelay(5000, 8000);

    const amazonPrice = amazonData.amazon_price;
    const noonPrice = noonData.noon_price;

    let best = null;
    if (amazonPrice && noonPrice) best = Math.min(amazonPrice, noonPrice);
    else best = amazonPrice || noonPrice;

    let diff = null;
    if (best && ourPrice) diff = (best - ourPrice).toFixed(2);

    results.push({
      SKU: sku,
      Product_Title: title,
      OurShopee_Price: ourPrice,
      Amazon_Price: amazonPrice,
      Noon_Price: noonPrice,
      Best_Competitor_Price: best,
      Price_Difference: diff,
      Amazon_Matched_Title: amazonData.amazon_title,
      Noon_Matched_Title: noonData.noon_title,
      Amazon_Status: amazonData.amazon_status,
      Noon_Status: noonData.noon_status
    });

    console.log(`  Result → Amazon: ${amazonPrice} | Noon: ${noonPrice}\n`);
  }

  const outputFile = path.join('results', `auto_price_report_${getTimestamp()}.csv`);
  const csvWriter = createCsvWriter({
    path: outputFile,
    header: [
      { id: 'SKU', title: 'SKU' },
      { id: 'Product_Title', title: 'Product Title' },
      { id: 'OurShopee_Price', title: 'OurShopee Price' },
      { id: 'Amazon_Price', title: 'Amazon Price' },
      { id: 'Noon_Price', title: 'Noon Price' },
      { id: 'Best_Competitor_Price', title: 'Best Competitor Price' },
      { id: 'Price_Difference', title: 'Price Difference' },
      { id: 'Amazon_Matched_Title', title: 'Amazon Matched Title' },
      { id: 'Noon_Matched_Title', title: 'Noon Matched Title' },
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
