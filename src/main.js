const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { scrapeAmazon } = require('./amazon');
const { scrapeNoon } = require('./noon');
const { randomDelay, getTimestamp } = require('./utils');

async function run() {
  console.log('Starting Price Monitor...\n');

  const products = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream('products.csv')
      .pipe(csv())
      .on('data', (row) => products.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  console.log(`Loaded ${products.length} products\n`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();
  const results = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`Processing ${i + 1}/${products.length}: ${product.your_sku} - ${product.product_name}`);

    const amazonData = await scrapeAmazon(page, product.amazon_url);
    await randomDelay(3000, 6000);

    const noonData = await scrapeNoon(page, product.noon_url);
    await randomDelay(3000, 6000);

    const yourPrice = parseFloat(product.your_price);
    const amazonDiff = amazonData.amazon_price !== null ? (amazonData.amazon_price - yourPrice).toFixed(2) : null;
    const noonDiff = noonData.noon_price !== null ? (noonData.noon_price - yourPrice).toFixed(2) : null;

    results.push({
      timestamp: new Date().toISOString(),
      your_sku: product.your_sku,
      product_name: product.product_name,
      your_price: yourPrice,
      amazon_price: amazonData.amazon_price,
      noon_price: noonData.noon_price,
      amazon_diff: amazonDiff,
      noon_diff: noonDiff,
      amazon_status: amazonData.amazon_status,
      noon_status: noonData.noon_status,
      amazon_title: amazonData.amazon_title,
      noon_title: noonData.noon_title
    });

    console.log(`  Amazon: ${amazonData.amazon_price} | Noon: ${noonData.noon_price}\n`);
  }

  const outputFile = path.join('results', `price_report_${getTimestamp()}.csv`);

  const csvWriter = createCsvWriter({
    path: outputFile,
    header: [
      { id: 'timestamp', title: 'timestamp' },
      { id: 'your_sku', title: 'your_sku' },
      { id: 'product_name', title: 'product_name' },
      { id: 'your_price', title: 'your_price' },
      { id: 'amazon_price', title: 'amazon_price' },
      { id: 'noon_price', title: 'noon_price' },
      { id: 'amazon_diff', title: 'amazon_diff' },
      { id: 'noon_diff', title: 'noon_diff' },
      { id: 'amazon_status', title: 'amazon_status' },
      { id: 'noon_status', title: 'noon_status' },
      { id: 'amazon_title', title: 'amazon_title' },
      { id: 'noon_title', title: 'noon_title' }
    ]
  });

  await csvWriter.writeRecords(results);
  console.log(`\nResults saved to: ${outputFile}`);

  await browser.close();
  console.log('Done!');
}

run().catch(console.error);
