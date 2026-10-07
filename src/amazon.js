const { cleanPrice } = require('./utils');

async function scrapeAmazon(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    const priceSelector = '.a-price .a-offscreen';
    const titleSelector = '#productTitle';
    const availabilitySelector = '#availability';

    const priceText = await page.locator(priceSelector).first().textContent().catch(() => null);
    const title = await page.locator(titleSelector).first().textContent().catch(() => null);
    const availability = await page.locator(availabilitySelector).first().textContent().catch(() => null);

    return {
      amazon_price: cleanPrice(priceText),
      amazon_title: title ? title.trim() : null,
      amazon_availability: availability ? availability.trim() : null,
      amazon_status: priceText ? 'success' : 'price_not_found'
    };
  } catch (error) {
    return {
      amazon_price: null,
      amazon_title: null,
      amazon_availability: null,
      amazon_status: `error: ${error.message}`
    };
  }
}

module.exports = { scrapeAmazon };
