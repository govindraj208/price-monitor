const { cleanPrice } = require('./utils');

async function scrapeNoon(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    const priceSelector = '[data-qa="div-price-now"]';
    const titleSelector = 'h1';
    const availabilitySelector = '[data-qa="product-availability"]';

    const priceText = await page.locator(priceSelector).first().textContent().catch(() => null);
    const title = await page.locator(titleSelector).first().textContent().catch(() => null);
    const availability = await page.locator(availabilitySelector).first().textContent().catch(() => null);

    return {
      noon_price: cleanPrice(priceText),
      noon_title: title ? title.trim() : null,
      noon_availability: availability ? availability.trim() : null,
      noon_status: priceText ? 'success' : 'price_not_found'
    };
  } catch (error) {
    return {
      noon_price: null,
      noon_title: null,
      noon_availability: null,
      noon_status: `error: ${error.message}`
    };
  }
}

module.exports = { scrapeNoon };
