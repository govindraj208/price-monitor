// Amazon.ae search scraper.
//
// Note: on amazon.ae the <h2> holds only the brand ("CorningWare"). The full
// product title lives in the thumbnail's alt attribute, so that is the primary
// title source here.

const { goto, isBlocked } = require('../browser');

function searchUrl(query) {
  return `https://www.amazon.ae/s?k=${encodeURIComponent(query)}`;
}

function productUrl(asin) {
  return `https://www.amazon.ae/dp/${asin}`;
}

function extractAsin(url = '') {
  const m = url.match(/\/dp\/([A-Z0-9]{10})(?![A-Z0-9])/i)
    || url.match(/\/gp\/product\/([A-Z0-9]{10})(?![A-Z0-9])/i);
  return m ? m[1].toUpperCase() : null;
}

async function searchCandidates(page, query, limit = 10) {
  await goto(page, searchUrl(query));

  if (await isBlocked(page)) {
    const error = new Error('Amazon returned a bot challenge');
    error.code = 'BLOCKED';
    throw error;
  }

  const raw = await page.evaluate((max) => {
    const cards = document.querySelectorAll('[data-component-type="s-search-result"]');
    const out = [];
    for (const card of cards) {
      if (out.length >= max) break;

      const asin = card.getAttribute('data-asin');
      if (!asin) continue;

      const img = card.querySelector('img.s-image');
      const h2 = card.querySelector('h2');
      const textNormal = card.querySelector('.a-text-normal');

      // Prefer the image alt: it carries the complete listing title.
      let title = (img && img.getAttribute('alt')) || '';
      if (!title) {
        const brand = (h2 && h2.innerText) || '';
        const rest = (textNormal && textNormal.innerText) || '';
        title = [brand, rest].filter(Boolean).join(' ');
      }
      title = title.replace(/\s+/g, ' ').trim();

      // Robust price extraction: offscreen, whole+fraction, or color-price
      let price = null;
      const priceEl = card.querySelector('.a-price .a-offscreen, span.a-price > span.a-offscreen');
      if (priceEl && priceEl.innerText && priceEl.innerText.trim()) {
        price = priceEl.innerText.trim();
      } else {
        const whole = card.querySelector('.a-price-whole');
        const fraction = card.querySelector('.a-price-fraction');
        if (whole && whole.innerText && whole.innerText.trim()) {
          const fracText = fraction && fraction.innerText ? fraction.innerText.trim() : '00';
          price = `${whole.innerText.trim().replace(/[^\d]/g, '')}.${fracText.replace(/[^\d]/g, '')}`;
        } else {
          const colorPrice = card.querySelector('.a-color-price, [data-a-color="price"], .a-size-base.a-color-price');
          if (colorPrice && colorPrice.innerText && colorPrice.innerText.trim()) {
            price = colorPrice.innerText.trim();
          }
        }
      }

      const sponsored = Boolean(card.querySelector('[data-component-type="sp-sponsored-result"]'))
        || /^\s*Sponsored/i.test(card.innerText || '');

      out.push({
        asin,
        title,
        priceRaw: price,
        image: img ? img.getAttribute('src') : null,
        sponsored,
        rating: (card.querySelector('[aria-label*="out of 5 stars"]')?.getAttribute('aria-label') || '').match(/([\d.]+) out of 5/)?.[1] || null,
      });
    }
    return out;
  }, limit);

  return raw
    .filter(c => c.title)
    .map(c => ({
      source: 'amazon',
      title: c.title,
      priceRaw: c.priceRaw,
      url: productUrl(c.asin),
      id: c.asin,
      image: c.image,
      sponsored: c.sponsored,
      rating: c.rating,
    }));
}

module.exports = { searchCandidates, searchUrl, productUrl, extractAsin };
