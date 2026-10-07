// Structured product-spec parsing.
//
// A title is read in the order the user specified - brand, model, configuration,
// then condition - because for phones and laptops those fields *are* the product.
// "iPhone 12 Pro Max 256GB Gold" and "iPhone 14 Pro Max 256GB Gold" differ by a
// single token, and character-level title similarity scores them ~0.8; the photo
// (identical industrial design) and a close price then lift the pair to "High"
// confidence. Text similarity cannot see that one digit is the whole product, so
// spec fields are compared as facts and a conflict vetoes the candidate outright
// instead of merely nudging its score down.
//
// Everything here is deliberately conservative: a field that is not stated on
// one side is never a conflict. Catalogue titles get truncated and marketplace
// listings omit details constantly, and a false veto is worse than a weak score.

const {
  normalize,
  extractColors,
  extractModelNumbers,
  extractPackSize,
  extractCapacity,
  extractBarcode,
  extractWeight,
  extractVolume,
} = require('./text');

// Longest first, so "Pro Max" is never read as just "Pro".
const TIER_WORDS = ['pro max', 'pro', 'plus', 'ultra', 'mini', 'max', 'lite', 'air', 'se'];

const NETWORK_CODES = new Set(['2g', '3g', '4g', '5g', '6g']);

// Words that turn the number after them into a quantity rather than a model
// generation: "set of 3", "service for 4", "pack of 12".
const QUANTITY_WORDS = new Set([
  'of', 'for', 'pack', 'packs', 'set', 'sets', 'service', 'with', 'and', 'the',
  'a', 'an', 'x', 'by', 'up', 'to', 'no', 'include', 'includes',
]);

// A number followed by one of these is a measurement, not a generation.
const UNIT_WORDS = new Set([
  'gb', 'tb', 'mb', 'inch', 'inches', 'in', 'pcs', 'pc', 'piece', 'pieces',
  'pack', 'packs', 'ml', 'l', 'ltr', 'litre', 'liter', 'liters', 'litres',
  'oz', 'lb', 'lbs', 'kg', 'g', 'w', 'kw', 'v', 'cm', 'mm', 'm', 'qt',
  'quart', 'quarts', 'mah', 'hz',
]);

// Words that can sit in front of a model name without being part of it.
const LINE_SKIP = new Set(['with', 'the', 'for', 'and', 'set', 'new', 'original', 'official', 'genuine']);

// Generic category nouns. "Apple MacBook Neo 13 Inch Laptop - A18" must search
// as "macbook neo a18", not "laptop a18".
const CATEGORY_WORDS = new Set([
  'laptop', 'notebook', 'computer', 'desktop', 'smartphone', 'phone', 'mobile', 'tablet',
]);

// "Refurbished" and "renewed" are the same product condition under different
// marketplace vocabularies, so they collapse to one value.
const CONDITION_RULES = [
  ['renewed', /\b(?:renewed|renew|refurbished|refurb|reconditioned|pre[\s-]?owned)\b/i],
  ['used', /\b(?:used|second[\s-]?hand)\b/i],
  ['open box', /\bopen[\s-]?box\b/i],
  ['new', /\b(?:brand[\s-]?new|new|sealed|unopened)\b/i],
];

// normalize() splits "15.3-inch" into 15 / 3 / inch, and that stray 15 would
// then be read as a model generation. Folding the decimal point into letters
// keeps the measurement in one token.
function specNormalize(title) {
  return normalize(String(title).replace(/(\d)[.,](\d)/g, '$1POINT$2'));
}

function findMemory(title) {
  const re = /(\d+(?:\.\d+)?)\s*(tb|gb)\b(\s*(?:ram|memory|ddr\d?)\b)?/gi;
  const hits = [];
  for (const m of String(title).matchAll(re)) {
    hits.push({
      gb: Number(m[1]) * (m[2].toLowerCase() === 'tb' ? 1024 : 1),
      labelledRam: Boolean(m[3]),
    });
  }
  if (!hits.length) return { storage: null, ram: null };

  const labelled = hits.filter(h => h.labelledRam).map(h => h.gb);
  const unlabelled = hits.filter(h => !h.labelledRam).map(h => h.gb);

  let ram = labelled.length ? Math.min(...labelled) : null;
  let storage = null;

  if (unlabelled.length >= 2) {
    // "16GB 512GB" states memory first and disk second.
    storage = Math.max(...unlabelled);
    if (ram === null) ram = Math.min(...unlabelled);
  } else if (unlabelled.length === 1) {
    storage = unlabelled[0];
  }

  // A lone figure of 32GB or less with no "RAM" label is memory, not disk:
  // phones and tablets start at 64GB, and 8/16/32GB on their own are laptop RAM.
  if (storage !== null && ram === null && hits.length === 1 && storage <= 32) {
    ram = storage;
    storage = null;
  }

  return { storage, ram };
}

function findScreen(title) {
  // "inch" only - a bare "in" also matches "2 in 1 convertible".
  const m = String(title).match(/(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(?:inch(?:es)?|")/i);
  return m ? Number(m[1]) : null;
}

function findCondition(title) {
  for (const [value, re] of CONDITION_RULES) {
    if (re.test(String(title))) return value;
  }
  return null;
}

const REGIONAL_VERSION_RULES = [
  ['tdra', /\b(?:tdra|tra|telecommunications\s+and\s+digital|uae\s+version|emirates\s+version)\b/i],
  ['middle_east', /\b(?:middle\s*east(?:\s+version)?|me\s+version|mena\s+version|ae\s+version|gcc\s+version|arab\s+version)\b/i],
  ['international', /\b(?:international(?:\s+version)?|intl(?:\s+version)?|global(?:\s+version)?|non[\s-]?active)\b/i],
  ['japan', /\b(?:japan(?:ese)?(?:\s+version)?|jp\s+version|j[\s-]?version)\b/i],
  ['us', /\b(?:u\.?s\.?a?(?:\s+version)?|american\s+version|united\s+states\s+version)\b/i],
  ['hong_kong', /\b(?:hong\s*kong(?:\s+version)?|hk\s+version|china(?:\s+version)?)\b/i],
  ['uk_europe', /\b(?:u\.?k\.?(?:\s+version)?|united\s+kingdom\s+version|europe(?:an)?(?:\s+version)?|eu\s+version)\b/i],
  ['india', /\b(?:india(?:n)?(?:\s+version)?|in\s+version)\b/i],
  ['ksa', /\b(?:ksa(?:\s+version)?|saudi(?:\s+arabia)?(?:\s+version)?)\b/i],
  ['singapore', /\b(?:singapore(?:\s+version)?|sg\s+version)\b/i],
  ['canada', /\b(?:canada|canadian)(?:\s+version)?\b/i],
  ['australia', /\b(?:australia|australian)(?:\s+version)?\b/i],
];

function findRegionalVersion(title) {
  for (const [val, re] of REGIONAL_VERSION_RULES) {
    if (re.test(String(title))) return val;
  }
  return null;
}

const SIM_CONFIG_RULES = [
  ['dual_esim', /\b(?:dual\s+esim|esim\s+only)\b/i],
  ['nano_sim_esim', /\b(?:nano\s+sim\s*\+\s*esim|single\s+sim\s*\+\s*esim|sim\s*\+\s*esim|physical\s+sim\s*\+\s*esim)\b/i],
  ['dual_physical_sim', /\b(?:dual\s+(?:physical\s+)?(?:nano\s+)?sim|physical\s+dual\s+sim|dual\s+sim\s+physical)\b/i],
];

function findSimConfig(title) {
  for (const [val, re] of SIM_CONFIG_RULES) {
    if (re.test(String(title))) return val;
  }
  return null;
}

// Tiers are collected as a set and compared by intersection. A single value
// would misfire on appliances: "Ninja Air Fryer" and "Ninja Pro Air Fryer" share
// "air" and are the same line, while "MacBook Air" and "MacBook Pro" share
// nothing and are not.
function findTiers(tokens) {
  const claimed = new Array(tokens.length).fill(false);
  const indices = [];
  const values = [];

  for (const phrase of TIER_WORDS.map(t => t.split(' '))) {
    for (let i = 0; i + phrase.length <= tokens.length; i++) {
      if (!phrase.every((w, k) => tokens[i + k] === w)) continue;
      if (phrase.some((_, k) => claimed[i + k])) continue;
      phrase.forEach((_, k) => { claimed[i + k] = true; indices.push(i + k); });
      values.push(phrase.join(' '));
    }
  }

  return { values: values.sort(), indices };
}

function findModel(tokens) {
  const indices = [];

  let generation = null;
  let family = null;
  for (let i = 1; i < tokens.length; i++) {
    if (!/^\d{1,3}$/.test(tokens[i])) continue;
    const prev = tokens[i - 1];
    if (!/^[a-z][a-z0-9]*$/.test(prev) || QUANTITY_WORDS.has(prev)) continue;
    if (UNIT_WORDS.has(tokens[i + 1] || '')) continue;
    generation = Number(tokens[i]);
    family = prev;
    indices.push(i - 1, i);
    break;
  }

  let modelCode = null;
  for (let i = 0; i < tokens.length; i++) {
    if (!/^[a-z]\d{1,3}$/.test(tokens[i]) || NETWORK_CODES.has(tokens[i])) continue;
    modelCode = tokens[i];
    indices.push(i);
    break;
  }

  return { generation, family, modelCode, indices };
}

// The model line is the run of words between the brand and the model identity
// that is not filler: "Galaxy" in "Samsung Galaxy S26 Ultra", "MacBook" in
// "MacBook Air M5". Without it the search query loses the product family.
function findLine(tokens, brandIndex, firstModelIndex) {
  const out = [];
  for (let i = brandIndex + 1; i < firstModelIndex; i++) {
    const t = tokens[i];
    if (!/^[a-z][a-z0-9]*$/.test(t)) continue;   // numbers and "15POINT3"
    if (UNIT_WORDS.has(t) || QUANTITY_WORDS.has(t) || LINE_SKIP.has(t) || CATEGORY_WORDS.has(t)) continue;
    out.push({ value: t, index: i });
  }
  return out;
}

// The user's rule: the first string is the brand. Used only to build the search
// query, never to veto - "HP" and "Hewlett Packard" are the same company.
function findBrand(tokens) {
  const index = tokens.findIndex(t => /^[a-z][a-z0-9+]+$/.test(t) && t.length > 1);
  return index === -1 ? { value: null, index: -1 } : { value: tokens[index], index };
}

function parseSpec(title = '') {
  const tokens = specNormalize(title).split(' ');
  const model = findModel(tokens);
  const tiers = findTiers(tokens);
  const brand = findBrand(tokens);
  const { storage, ram } = findMemory(title);

  const identityIndices = [...model.indices, ...tiers.indices];
  const line = identityIndices.length
    ? findLine(tokens, brand.index, Math.min(...identityIndices))
    : [];

  // Rebuild the model phrase from the tokens that actually identify the product,
  // in title order, so measurements and filler words in between are dropped:
  // "macbook neo 13 inch laptop a18" becomes "macbook neo a18".
  const phraseIndices = [...new Set([...identityIndices, ...line.map(l => l.index)])].sort((a, b) => a - b);
  const phrase = phraseIndices.map(i => tokens[i]).join(' ').replace(/POINT/g, '.');

  const spec = {
    brand: brand.value,
    model: phrase,
    family: model.family,
    generation: model.generation,
    modelCode: model.modelCode,
    tiers: tiers.values,
    storage,
    ram,
    screen: findScreen(title),
    packSize: extractPackSize(title),
    capacity: extractCapacity(title),
    weight: extractWeight(title),
    volume: extractVolume(title),
    barcode: extractBarcode(title),
    condition: findCondition(title),
    version: findRegionalVersion(title),
    simConfig: findSimConfig(title),
    colors: extractColors(title),
    models: extractModelNumbers(title),
  };
  spec.modelDetected = Boolean(model.family || model.modelCode);
  return spec;
}

// Fields where a stated difference means a different sellable item. Each entry
// is only compared when BOTH titles state it.
const HARD_FIELDS = [
  { key: 'barcode', label: 'barcode' },
  { key: 'weight', label: 'weight', tol: 5, unit: 'g' },
  { key: 'volume', label: 'volume', tol: 5, unit: 'ml' },
  { key: 'family', label: 'model family' },
  { key: 'generation', label: 'generation' },
  { key: 'modelCode', label: 'model code' },
  { key: 'tiers', label: 'model tier', set: true },
  { key: 'storage', label: 'storage', unit: 'GB' },
  { key: 'ram', label: 'RAM', unit: 'GB' },
  { key: 'screen', label: 'screen', tol: 0.2, unit: 'in' },
  { key: 'capacity', label: 'capacity', tol: 0.05, unit: 'L' },
  { key: 'packSize', label: 'pack size', unit: 'pc' },
  { key: 'condition', label: 'condition' },
  { key: 'version', label: 'regional version' },
  { key: 'simConfig', label: 'SIM configuration' },
];

function differs(field, a, b) {
  if (field.set) return !a.some(x => b.includes(x));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > (field.tol || 0);
  return a !== b;
}

function formatValue(field, v) {
  if (field.set) return v.join('+');
  if (field.key === 'version') return String(v).replace(/_/g, ' ').toUpperCase();
  if (field.key === 'simConfig') return String(v).replace(/_/g, ' ');
  return `${v}${field.unit || ''}`;
}

// Hard conflicts between two titles.
function specConflicts(ourTitle = '', theirTitle = '') {
  const ourStr = typeof ourTitle === 'object' && ourTitle !== null
    ? [ourTitle.title, ourTitle.sku, ourTitle.barcode].filter(Boolean).join(' ')
    : String(ourTitle || '');
  const theirStr = typeof theirTitle === 'object' && theirTitle !== null
    ? [theirTitle.title, theirTitle.id, theirTitle.sku, theirTitle.barcode].filter(Boolean).join(' ')
    : String(theirTitle || '');

  const ours = parseSpec(ourStr);
  const theirs = parseSpec(theirStr);
  const conflicts = [];

  for (const field of HARD_FIELDS) {
    const a = ours[field.key];
    const b = theirs[field.key];
    if (field.set ? (!a.length || !b.length) : (a === null || b === null)) continue;
    if (!differs(field, a, b)) continue;
    conflicts.push(`${field.label} ${formatValue(field, a)} vs ${formatValue(field, b)}`);
  }

  // Alphanumeric model code conflict (e.g. ES5460 vs ES5061, EFV-640D vs EFR-526L, FLRLWLPS09)
  const isAlpha = m => /[a-z]/.test(m) && /\d/.test(m);
  const ourAlpha = ours.models.filter(isAlpha);
  const theirAlpha = theirs.models.filter(isAlpha);
  if (ourAlpha.length > 0 && theirAlpha.length > 0) {
    const sharesModel = ourAlpha.some(m =>
      theirAlpha.some(n => n === m || n.includes(m) || m.includes(n))
    );
    if (!sharesModel) {
      conflicts.push(`model number ${ourAlpha.join('/')} vs ${theirAlpha.join('/')}`);
    }
  }

  return { conflicts, ours, theirs };
}

function memoryPhrase(storage, ram) {
  const parts = [];
  if (ram !== null) parts.push(`${ram}GB RAM`);
  if (storage !== null) {
    parts.push(storage >= 1024 && storage % 1024 === 0 ? `${storage / 1024}TB` : `${storage}GB`);
  }
  return parts.join(' ');
}

// Build the search string in the order the user asked for: brand, model,
// configuration, then condition. Only used when a model identity was actually
// detected - for dinnerware and cookware the descriptive words ("French White
// Round Set With Glass Lids") carry the identity and must not be dropped.
function buildSpecQuery(title = '', { includeCondition = true, includeColour = true } = {}) {
  const s = parseSpec(title);
  if (!s.modelDetected) return null;

  const parts = [];
  const add = value => {
    const v = String(value || '').trim().toLowerCase();
    if (v && !parts.includes(v)) parts.push(v);
  };

  add(s.brand);
  add(s.model);
  add(memoryPhrase(s.storage, s.ram));
  if (s.screen !== null) add(`${s.screen} inch`);
  if (s.packSize !== null) add(`${s.packSize} pcs`);
  if (s.capacity !== null) add(`${s.capacity}L`);
  if (includeColour) s.colors.forEach(add);
  if (includeCondition) add(s.condition);

  const query = parts.join(' ');
  return query.length >= 4 ? query : null;
}

module.exports = {
  parseSpec,
  specConflicts,
  buildSpecQuery,
  findRegionalVersion,
  findSimConfig,
  HARD_FIELDS,
  TIER_WORDS,
};
