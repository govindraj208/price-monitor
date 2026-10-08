// OurShopee — the user's own store. Provides the product URL and the reference
// photo used for image matching.
//
// Search results page: https://ourshopee.com/uae-en/search-result/<query>/
// Product URL pattern: /uae-en/<slug>/<SKU>/p/

const { goto } = require('../browser');

// A product card contains several bare numbers that all look like prices: the
// star rating ("4.4"), the current price ("2549"), the struck-through old
// price, and the "You saved" amount. They are only separable by structure:
//   - the old price sits in a line-through subtree
//   - the savings amount sits in the save-banner / currency-symbol subtree
//   - the rating is text-xs and shares a wrapper with a star SVG
//   - of what remains, the current price is the largest rendered text
// Taking the first bare number instead picks the rating on any card that shows
// one, which silently puts 4.4 in the price column.
//
// Prices render both with and without thousands separators ("1,535.00" on some
// cards, "2549" on others), so the pattern has to accept either.
const PRICE_RE = /^\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?$/;
const RATING_RE = /^\d(?:\.\d)?\s*\|?\s*\(\d+\)$/;

function searchUrl(query) {
  return `https://ourshopee.com/uae-en/search-result/?q=${encodeURIComponent(query)}`;
}

// Product URLs are /uae-en/<slug>/<SKU>/p/.
const SKU_HREF_RE = /\/([A-Z0-9]{4,})\/p\/?(?:[?#]|$)/;

function skuFromHref(href = '') {
  const m = String(href).match(SKU_HREF_RE);
  return m ? m[1] : null;
}

async function searchCandidates(page, query, limit = 10) {
  await goto(page, searchUrl(query), { settle: 2500, timeout: 20000 });

  return page.evaluate(({ SKU_HREF_SOURCE, max }) => {
    const skuRe = new RegExp(SKU_HREF_SOURCE);
    const seen = new Set();
    const out = [];

    const anchors = [];
    document.querySelectorAll('a[href*="/p/"], a[href*="/p?"], [class*="product"] a').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href && (href.includes('/p/') || href.includes('/p?') || skuRe.test(href)) && !anchors.includes(a)) {
        anchors.push(a);
      }
    });

    for (const a of anchors) {
      if (out.length >= max) break;
      const href = a.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;

      const skuMatch = href.match(skuRe);
      const sku = skuMatch ? skuMatch[1] : null;

      const card = a.closest('[class*="product-card"], [class*="product-item"], [class*="card"], div') || a;

      const titleEl = card.querySelector('h2, h3, h4, [class*="title"], [class*="name"]');
      const img = card.querySelector('img');
      const title = ((titleEl && titleEl.innerText) || (img && img.getAttribute('alt')) || a.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!title || title.length < 3) continue;

      let price = null;
      // Extract price
      const priceEls = card.querySelectorAll('[class*="price"], [class*="amount"], strong, span');
      for (const el of priceEls) {
        if (el.closest('[class*="line-through"]')) continue;
        const text = el.innerText.replace(/,/g, '').trim();
        const m = text.match(/\d+(?:\.\d{1,2})?/);
        if (m && parseFloat(m[0]) > 0 && parseFloat(m[0]) < 100000) {
          price = m[0];
          break;
        }
      }

      seen.add(href);
      out.push({
        source: 'ourshopee',
        title,
        priceRaw: price,
        url: href.startsWith('http') ? href : `https://ourshopee.com${href}`,
        id: sku,
        image: img ? (img.getAttribute('src') || img.getAttribute('data-src') || null) : null,
      });
    }

    return out;
  }, { SKU_HREF_SOURCE: SKU_HREF_RE.source, max: limit });
}

// The SKU is the strongest handle we have, so try it before falling back to title.
async function findBySku(page, sku) {
  if (!sku) return [];
  const candidates = await searchCandidates(page, sku);
  return candidates.filter(c => c.id && c.id.toLowerCase() === String(sku).toLowerCase());
}

async function scrapeProduct(page, url) {
  if (!url) return null;
  try {
    await goto(page, url);
    return page.evaluate(() => {
      const titleEl = document.querySelector('h1, [class*="product-title"], [class*="productName"]');
      const title = titleEl ? titleEl.innerText.trim() : '';

      let price = null;
      // Try specific product page price selectors
      const priceSelectors = [
        '[class*="special-price"]',
        '[class*="product-price"]',
        '[class*="final-price"]',
        '[class*="selling-price"]',
        'span.price',
        'div.price',
        'strong.price'
      ];
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const m = el.innerText.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
          if (m && parseFloat(m[0]) > 0) { price = m[0]; break; }
        }
      }

      const img = document.querySelector('[class*="product-image"] img, .gallery img, img.main-image, img');
      const image = img ? (img.getAttribute('src') || img.getAttribute('data-src')) : null;

      return { title, priceRaw: price, image, url: window.location.href };
    });
  } catch (err) {
    return null;
  }
}

module.exports = { searchCandidates, findBySku, scrapeProduct, searchUrl, skuFromHref };
