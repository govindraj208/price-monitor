// Text normalisation, similarity scoring and product-attribute extraction.
// These are the "string matched first" and "product details similar" signals.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'to', 'in', 'on', 'by',
  'set', 'sets', 'pcs', 'pc', 'pcs.', 'piece', 'pieces', 'pack', 'packs',
  'item', 'items', 'product', 'new', 'original', 'genuine', 'official',
  'service', 'include', 'includes', 'included', 'size', 'color', 'colour',
]);

const COLORS = [
  'white', 'black', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink',
  'brown', 'amber', 'grey', 'gray', 'silver', 'gold', 'beige', 'cream', 'navy',
  'teal', 'turquoise', 'maroon', 'ivory', 'transparent', 'clear',
  // Device finishes. Without these an iPhone's colour is invisible to the
  // matcher and to the search query, so Graphite and Gold look interchangeable.
  'graphite', 'midnight', 'starlight', 'titanium', 'charcoal', 'slate',
  'copper', 'bronze', 'rose gold', 'space gray', 'space grey', 'deep purple',
];

// Everything except lowercase letters, digits and single spaces.
function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text = '') {
  return normalize(text).split(' ').filter(Boolean);
}

function contentTokens(text = '') {
  return tokenize(text).filter(t => !STOPWORDS.has(t) && t.length > 1);
}

// Jaccard over meaningful tokens.
function tokenJaccard(a = '', b = '') {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  A.forEach(t => { if (B.has(t)) shared++; });
  return shared / (A.size + B.size - shared);
}

// Containment: what fraction of the *shorter* title's words appear in the other.
// Handles the common case where one listing is much more verbose than the other.
function tokenContainment(a = '', b = '') {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  A.forEach(t => { if (B.has(t)) shared++; });
  return shared / Math.min(A.size, B.size);
}

function bigrams(text = '') {
  const s = normalize(text).replace(/ /g, '');
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

// Sorensen-Dice on character bigrams: tolerant of word order, typos and punctuation.
function bigramDice(a = '', b = '') {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length < 2 || B.length < 2) return 0;
  const counts = new Map();
  A.forEach(g => counts.set(g, (counts.get(g) || 0) + 1));
  let hits = 0;
  B.forEach(g => {
    const c = counts.get(g) || 0;
    if (c > 0) { counts.set(g, c - 1); hits++; }
  });
  return (2 * hits) / (A.length + B.length);
}

// Blended 0..1 title similarity.
function titleSimilarity(a = '', b = '') {
  const jaccard = tokenJaccard(a, b);
  const containment = tokenContainment(a, b);
  const dice = bigramDice(a, b);
  return Math.max(0, Math.min(1, 0.4 * jaccard + 0.35 * containment + 0.25 * dice));
}

// Barcodes (EAN-13, UPC-12, GTIN-14)
function extractBarcode(text = '') {
  const m = String(text).match(/\b(\d{12,14})\b/);
  return m ? m[1] : null;
}

// Weight normalized to grams
function extractWeight(text = '') {
  const s = String(text).toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(kg|g|oz|lbs?)\b/);
  if (!m) return null;
  const val = Number(m[1]);
  const unit = m[2];
  if (unit === 'kg') return Math.round(val * 1000);
  if (unit === 'g') return Math.round(val);
  if (unit === 'oz') return Math.round(val * 28.3495);
  if (unit.startsWith('lb')) return Math.round(val * 453.592);
  return null;
}

// Volume normalized to milliliters (ml)
function extractVolume(text = '') {
  const s = String(text).toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(ml|ltr|litres?|liters?|l)\b/);
  if (!m) return null;
  const val = Number(m[1]);
  const unit = m[2];
  if (unit === 'ml') return Math.round(val);
  return Math.round(val * 1000);
}

const UNIT_WORD_SET = new Set([
  'piece', 'pieces', 'pcs', 'pc', 'pack', 'packs', 'inch', 'inches', 'in',
  'cm', 'mm', 'oz', 'ml', 'kg', 'g', 'day', 'hour', 'year', 'month', 'set', 'sets'
]);

// Manufacturer part numbers are the single strongest textual signal.
// Matches things like 4116481, 1116557, 2724574014864, vs-300, sm-s938, FLRLWLPS09, NTE0030287, ES5460, BC-2169.
function extractModelNumbers(text = '') {
  const out = new Set();
  const s = String(text).toLowerCase();

  for (const m of s.matchAll(/\b([a-z]{0,8}[-]?\d{2,}[a-z0-9-]*|[a-z0-9]+-[a-z0-9-]+)\b/g)) {
    const token = m[1].replace(/^-|-$/g, '');
    const digits = token.replace(/\D/g, '');
    if (digits.length < 2) continue;
    if (/^\d+\.\d+$/.test(token)) continue;
    // Skip pure measurements, storage, and network codes
    if (/^(?:\d+(?:gb|tb|mb|ml|g|kg|oz|cm|mm|%)|[2-6]g|lte)$/i.test(token)) continue;

    const parts = token.split('-');
    if (parts.some(p => UNIT_WORD_SET.has(p))) continue;

    if (/[a-z]/.test(token) && /\d/.test(token)) {
      out.add(token);
    } else if (digits.length >= 4) {
      out.add(token);
    }
  }

  // Also standalone model numbers explicitly tagged like "- 1045", "- 3002", "BC-2169"
  for (const m of s.matchAll(/(?:-\s*|\bmodel\s*:?\s*)(\d{3,5})\b/g)) {
    out.add(m[1]);
  }

  return [...out];
}

function extractPackSize(text = '') {
  const s = String(text).toLowerCase();
  const m = s.match(/(\d+)\s*(?:-|\s)?\s*(?:pcs?\.?|pieces?|packs?|pc)\b/)
    || s.match(/\b(\d+)\s*(?:-|\s)?\s*(?:piece|pc)\b/)
    || s.match(/(\d+)\s*pc\b/);
  return m ? Number(m[1]) : null;
}

function extractServiceFor(text = '') {
  const m = String(text).toLowerCase().match(/service\s*(?:for|of)\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function extractColors(text = '') {
  const n = normalize(text);
  return COLORS.filter(c => new RegExp(`\\b${c}\\b`).test(n));
}

function extractCapacity(text = '') {
  const m = String(text).toLowerCase().match(/(\d+(?:\.\d+)?)\s*(l|ltr|litre|liter|liters|litres|ml)\b/);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2];
  return unit === 'ml' ? value / 1000 : value;
}

function extractAttributes(text = '') {
  return {
    barcode: extractBarcode(text),
    weight: extractWeight(text),
    volume: extractVolume(text),
    models: extractModelNumbers(text),
    packSize: extractPackSize(text),
    serviceFor: extractServiceFor(text),
    colors: extractColors(text),
    capacity: extractCapacity(text),
  };
}

// Do two attribute sets describe the same product?
//
// Asymmetry matters here. When our listing states a defining detail (an 11-piece
// set, service for 4) and the candidate states nothing, that is not neutral - a
// listing for the same set would normally say so. Treating silence as agreement
// let single-item listings score perfectly against multi-piece sets.
const MISSING_DETAIL_CREDIT = 0.3;

function attributeSimilarity(a = '', b = '') {
  const A = extractAttributes(a);
  const B = extractAttributes(b);
  const reasons = [];

  const sharedModel = A.models.find(m => B.models.some(n => n === m || n.includes(m) || m.includes(n)));
  if (sharedModel) {
    return { score: 1, sharedModel, reasons: [`part number ${sharedModel}`] };
  }

  let signals = 0;
  let credit = 0;

  const compare = (name, ourValue, theirValue, format) => {
    if (ourValue === null && theirValue === null) return;
    signals++;
    if (ourValue !== null && theirValue === null) {
      credit += MISSING_DETAIL_CREDIT;
      reasons.push(`${name} not stated (${format(ourValue)})`);
    } else if (ourValue === null && theirValue !== null) {
      credit += MISSING_DETAIL_CREDIT;
      reasons.push(`our ${name} not stated`);
    } else if (ourValue === theirValue) {
      credit += 1;
      reasons.push(`${name} ${format(ourValue)}`);
    } else {
      reasons.push(`${name} differs (${format(ourValue)} vs ${format(theirValue)})`);
    }
  };

  compare('pack size', A.packSize, B.packSize, v => `${v}pc`);
  compare('service for', A.serviceFor, B.serviceFor, v => String(v));
  compare('colour',
    A.colors.length ? A.colors.slice().sort().join('/') : null,
    B.colors.length ? B.colors.slice().sort().join('/') : null,
    v => v);

  if (A.weight !== null || B.weight !== null) {
    signals++;
    if (A.weight !== null && B.weight === null) { credit += MISSING_DETAIL_CREDIT; reasons.push(`weight not stated (${A.weight}g)`); }
    else if (A.weight === null && B.weight !== null) { credit += MISSING_DETAIL_CREDIT; reasons.push('our weight not stated'); }
    else if (Math.abs(A.weight - B.weight) <= 5) { credit += 1; reasons.push(`weight ${A.weight}g`); }
    else reasons.push(`weight differs (${A.weight}g vs ${B.weight}g)`);
  }

  if (A.volume !== null || B.volume !== null) {
    signals++;
    if (A.volume !== null && B.volume === null) { credit += MISSING_DETAIL_CREDIT; reasons.push(`volume not stated (${A.volume}ml)`); }
    else if (A.volume === null && B.volume !== null) { credit += MISSING_DETAIL_CREDIT; reasons.push('our volume not stated'); }
    else if (Math.abs(A.volume - B.volume) <= 5) { credit += 1; reasons.push(`volume ${A.volume}ml`); }
    else reasons.push(`volume differs (${A.volume}ml vs ${B.volume}ml)`);
  }

  if (A.capacity !== null || B.capacity !== null) {
    signals++;
    if (A.capacity !== null && B.capacity === null) { credit += MISSING_DETAIL_CREDIT; reasons.push('capacity not stated'); }
    else if (A.capacity === null && B.capacity !== null) { credit += MISSING_DETAIL_CREDIT; reasons.push('our capacity not stated'); }
    else if (Math.abs(A.capacity - B.capacity) < 0.05) { credit += 1; reasons.push(`capacity ${A.capacity}L`); }
    else reasons.push(`capacity differs (${A.capacity}L vs ${B.capacity}L)`);
  }

  if (signals === 0) return { score: 0.5, sharedModel: null, reasons: ['no comparable details'] };

  return { score: credit / signals, sharedModel: null, reasons };
}

const CURRENCY_PREFIX_RE = /^\s*(?:aed|aeds|usd|\$|£|€|د\.إ)\s*/i;
const CURRENCY_SUFFIX_RE = /\s*(?:aed|aeds|usd)\s*$/i;
const BARE_NUMBER_RE = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$|^\d+(?:\.\d{1,2})?$/;

// Only accepts something that is unambiguously a price. Free text such as
// "Visions 6Pc (1.0L, 1.5L)" must return null rather than being reduced to a
// meaningless number.
function parsePrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const stripped = String(value).trim().replace(CURRENCY_PREFIX_RE, '').replace(CURRENCY_SUFFIX_RE, '').trim();
  if (!stripped || !BARE_NUMBER_RE.test(stripped)) return null;

  const num = Number.parseFloat(stripped.replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

module.exports = {
  STOPWORDS,
  normalize,
  tokenize,
  contentTokens,
  tokenJaccard,
  tokenContainment,
  bigramDice,
  titleSimilarity,
  extractBarcode,
  extractWeight,
  extractVolume,
  extractModelNumbers,
  extractPackSize,
  extractServiceFor,
  extractColors,
  extractCapacity,
  extractAttributes,
  attributeSimilarity,
  parsePrice,
};
