// Lightweight test for the matching engine - no browser needed.
// Run with: npm test

const assert = require('assert');
const { pickBest } = require('../src/lib/match');
const { titleSimilarity, attributeSimilarity, parsePrice, extractModelNumbers } = require('../src/lib/text');
const { parseSpec, specConflicts, buildSpecQuery } = require('../src/lib/spec');
const { imageSimilarity } = require('../src/lib/imageHash');

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(`${name}: ${e.message}`); console.log(` FAIL ${name}\n       ${e.message}`); }
}

console.log('\ntext parsing');

check('parsePrice strips currency symbols', () => {
  assert.strictEqual(parsePrice('AED 261.90'), 261.9);
  assert.strictEqual(parsePrice('1,234.56'), 1234.56);
  assert.strictEqual(parsePrice(''), null);
});

check('parsePrice rejects titles containing decimals like 1.0L', () => {
  assert.strictEqual(parsePrice('Visions 6Pc (1.0L, 1.5L)'), null);
});

check('extractModelNumbers finds part numbers', () => {
  const models = extractModelNumbers('Corningware French White 11 Pcs - 4116481');
  assert.ok(models.some(m => m.includes('4116481')), `got ${JSON.stringify(models)}`);
});

check('identical titles score 1', () => {
  const t = 'Corelle Ocean Blues Dinnerware Set Service For 4';
  assert.strictEqual(Math.round(titleSimilarity(t, t)), 1);
});

check('unrelated titles score near zero', () => {
  assert.ok(titleSimilarity('Corelle Ocean Blues Dinnerware Set', 'Samsung Galaxy S26 Ultra Smartphone') < 0.1);
});

console.log('\nmatching decisions');

// Real listings captured from amazon.ae / noon.com during development.
const CORNINGWARE = {
  ours: { title: 'Corningware French White Round Set With Glass LID Covers Plastic 11 Pcs - 4116481', price: 254.63 },
  candidates: [
    { title: 'CorningWare FRENCH WHITE 11PC ROUND SET WITH GLASS LID/PLASTIC COVERS (1116557)', price: 261.90, source: 'amazon', url: 'a' },
    { title: 'CorningWare FRENCH WHITE 6PC SNACK SET', price: 120.00, source: 'amazon', url: 'b' },
    { title: 'Corelle Ocean Blues 16pc Chip & Break Resistant Dinnerware Set', price: 341.00, source: 'amazon', url: 'c' },
    { title: 'Corelle Winter Frost White 16 Piece Dinnerware Set', price: 250.00, source: 'amazon', url: 'd' },
  ],
};

check('picks the genuine CorningWare match over cheaper distractors', () => {
  const { best } = pickBest(CORNINGWARE.ours, CORNINGWARE.candidates);
  assert.strictEqual(best.candidate.url, 'a');
  assert.strictEqual(best.evaluation.confidence, 'High');
});

check('does not pick a distractor just because its price is within +/-5', () => {
  // "Corelle Winter Frost White" at 250.00 is within 5 AED of 254.63 but is a
  // different product. Price alone must never win.
  const { best } = pickBest(CORNINGWARE.ours, CORNINGWARE.candidates);
  assert.notStrictEqual(best.candidate.url, 'd');
});

check('a shared part number forces a high-confidence match', () => {
  const { best } = pickBest(
    { title: 'Corelle Vitrelle Dinnerware Set 1130931', price: 374.06 },
    [
      { title: 'Completely unrelated kitchen item', price: 374.00, url: 'x' },
      { title: 'Corelle c/trelis dinner set 18pc 1130931- White', price: 278.25, url: 'y' },
    ]
  );
  assert.strictEqual(best.candidate.url, 'y', 'part number should outweigh price proximity');
  assert.strictEqual(best.evaluation.confidence, 'High');
});

check('Corelle Ocean Blues matches its exact variant', () => {
  const { best } = pickBest(
    { title: 'Corelle Ocean Blues , Chip And Break Resistant Dinnerware Set, Service For 4, Dinner Plates And Bowls', price: 341.25 },
    [
      { title: 'Corelle White Vitrelle 12-Piece Dinnerware Set Glass Triple-Layer', price: 302.00, url: 'x' },
      { title: 'Corelle Leaf Stitch Dinnerware Set Red Glass Service For 4', price: 324.00, url: 'y' },
      { title: 'Corelle Ocean Blues 16pc, Chip & Break Resistant Dinnerware Set, Service for 4, Dinner Plates and Bowls', price: 351.00, url: 'z' },
    ]
  );
  assert.strictEqual(best.candidate.url, 'z');
});

check('a matching photo lifts an otherwise weak text match', () => {
  // "Brown" vs "Amber" and different wording make the text signal weak; this is
  // the case the image hash exists to rescue.
  const ours = { title: 'Visions Cookware Brown, Set Glass 6 Pack - 4118365', price: 610.31 };
  const candidates = [
    { title: 'Visions 6-Piece Amber Saucepan Set', price: 569.50, url: 'a', imageHash: 'aabbccddeeff0011' },
    { title: 'Tefal Non Stick Cookware Set 5 Pieces', price: 299.00, url: 'b', imageHash: '1122334455667788' },
  ];
  const withoutImage = pickBest({ ...ours, imageHash: null }, candidates);
  const withImage = pickBest({ ...ours, imageHash: 'aabbccddeeff0011' }, candidates);

  assert.strictEqual(withImage.best.candidate.url, 'a');
  assert.ok(
    withImage.best.evaluation.score > withoutImage.best.evaluation.score,
    'identical photo should raise the score'
  );
});

check('attribute mismatch on pack size lowers confidence', () => {
  const ours = { title: 'Corelle Dinnerware Set 16 Piece Service For 4', price: 300 };
  const big = pickBest(ours, [{ title: 'Corelle Dinnerware Set 16 Piece Service For 4', price: 300, url: 'a' }]);
  const small = pickBest(ours, [{ title: 'Corelle Dinnerware Set 6 Piece Service For 2', price: 300, url: 'b' }]);
  assert.ok(big.best.evaluation.score > small.best.evaluation.score);
});

console.log('\nacceptance gate');

check('placeholder titles are never scored', () => {
  const { best } = pickBest(
    { title: 'Corelle Leaf Stitch Dinnerware Set Red Glass Service For 4', price: 315 },
    [
      { title: 'placeholder', price: 315, url: 'x' },
      { title: '', price: 315, url: 'y' },
    ]
  );
  assert.strictEqual(best, null, 'a placeholder must not win just because its price matches');
});

check('an unrelated cheap product is reported but not accepted', () => {
  // This is the exact failure seen in development: Noon returned "EETU Glass
  // Cooking Pot" at 53.10 for a 254.63 CorningWare set, which corrupted
  // Best Competitor Price.
  const { best, accepted } = pickBest(
    { title: 'Corningware French White Round Set With Glass LID Covers Plastic 11 Pcs', price: 254.63 },
    [
      { title: 'EETU Glass Cooking Pot With Lid, 1600ML Heat Resistant Borosilicate', price: 53.10, url: 'x' },
      { title: 'Pyrex Essential Round Casserole Set of 3 with Glass Lid', price: 129, url: 'y' },
    ]
  );
  assert.ok(best, 'we still surface the closest candidate for review');
  assert.strictEqual(accepted, false, 'but it must not be allowed to supply a price');
});

check('a strong match is accepted', () => {
  const { accepted } = pickBest(CORNINGWARE.ours, CORNINGWARE.candidates);
  assert.strictEqual(accepted, true);
});

check('a price-only coincidence is not accepted', () => {
  const { accepted } = pickBest(
    { title: 'Corelle Leaf Stitch Dinnerware Set Red Glass Service For 4', price: 315 },
    [{ title: '33 Pieces Opalware Dinner Set', price: 315, url: 'x' }]
  );
  assert.strictEqual(accepted, false, 'identical price with unrelated text must not pass');
});

console.log('\nspec parsing (brand / model / configuration / condition)');

check('reads an iPhone title into its parts', () => {
  const s = parseSpec('Apple iPhone 12 Pro Max With Facetime 256GB 5G Graphite Renewed');
  assert.strictEqual(s.brand, 'apple');
  assert.strictEqual(s.model, 'iphone 12 pro max');
  assert.strictEqual(s.generation, 12);
  assert.deepStrictEqual(s.tiers, ['pro max']);
  assert.strictEqual(s.storage, 256);
  assert.strictEqual(s.condition, 'renewed');
  assert.deepStrictEqual(s.colors, ['graphite']);
});

check('separates RAM from storage', () => {
  const s = parseSpec('Apple MacBook Air M5 15.3-inch 16GB RAM 512GB');
  assert.strictEqual(s.ram, 16);
  assert.strictEqual(s.storage, 512);
  assert.strictEqual(s.screen, 15.3);
  assert.strictEqual(s.model, 'macbook air m5');
});

check('an unlabelled small figure is RAM, not storage', () => {
  const s = parseSpec('Apple MacBook Air M5 15.3-inch 16GB');
  assert.strictEqual(s.ram, 16);
  assert.strictEqual(s.storage, null);
});

check('a screen size is not mistaken for a model generation', () => {
  assert.strictEqual(parseSpec('Apple MacBook Air M5 15.3-inch 16GB RAM 512GB').generation, null);
});

check('quantities are not model generations', () => {
  const s = parseSpec('Pyrex Essential Round Casserole Set of 3 with Glass Lid');
  assert.strictEqual(s.generation, null);
  assert.strictEqual(s.modelDetected, false);
});

check('renewed and refurbished are the same condition', () => {
  assert.strictEqual(
    specConflicts('iPhone 12 Pro Max 256GB Renewed', 'Apple (Refurbished) iPhone 12 Pro Max (256GB)').conflicts.length,
    0
  );
});

console.log('\nspec conflicts veto the wrong variant');

// Every pair below was matched confidently by the previous version and is a
// different sellable item. Taken from Result_2026-09-30T13-11-43-429Z.csv.
check('iPhone 12 Pro Max is not iPhone 14 Pro Max', () => {
  const c = specConflicts(
    'Apple iPhone 12 Pro Max With Facetime 256GB 5G Gold Renewed',
    'Apple Renewed - iPhone 14 Pro Max 256GB Gold 5G With Facetime - International Version'
  );
  assert.ok(c.conflicts.some(x => /generation 12 vs 14/.test(x)), JSON.stringify(c.conflicts));
});

check('iPhone 11 Pro Max is not iPhone 11 Pro', () => {
  const c = specConflicts(
    'Apple iPhone 11 Pro Max 256GB Gold',
    'Apple Renewed - iPhone 11 Pro 256GB Gold 4G With Facetime - International Version'
  );
  assert.ok(c.conflicts.some(x => /tier pro max vs pro/.test(x)), JSON.stringify(c.conflicts));
});

check('128GB is not 256GB', () => {
  const c = specConflicts(
    'Apple iPhone 11 With Facetime Black 128GB 4G LTE Renewed',
    'Apple (Refurbished) iPhone 11 (256GB) - Black'
  );
  assert.ok(c.conflicts.some(x => /storage 128GB vs 256GB/.test(x)), JSON.stringify(c.conflicts));
});

check('MacBook Air is not MacBook Pro', () => {
  const c = specConflicts('Apple MacBook Air M5 15.3-inch 16GB RAM 512GB', 'Apple MacBook Pro M5 14-inch 16GB RAM 512GB');
  assert.ok(c.conflicts.some(x => /tier air vs pro/.test(x)), JSON.stringify(c.conflicts));
});

check('an unmentioned spec is never a conflict', () => {
  const c = specConflicts(
    'Apple iPhone 12 Pro Max 256GB Gold',
    'Apple iPhone 12 Pro Max Gold'
  );
  assert.deepStrictEqual(c.conflicts, []);
});

check('a shared tier word keeps an appliance line intact', () => {
  const c = specConflicts('Ninja Air Fryer 5.5L', 'Ninja Pro Air Fryer AF160 5.5L');
  assert.deepStrictEqual(c.conflicts, []);
});

check('weight difference is a spec conflict (340g vs 454g)', () => {
  const c = specConflicts(
    'CeraVe Moisturizing Cream 340g',
    'CeraVe Moisturizing Cream 454g'
  );
  assert.ok(c.conflicts.some(x => /weight 340g vs 454g/.test(x)), JSON.stringify(c.conflicts));
});

check('volume difference is a spec conflict (50ml vs 30ml)', () => {
  const c = specConflicts(
    'Dr. Althea 147 Barrier Cream 50ml',
    'Dr. Althea 147 Barrier Cream 30ml'
  );
  assert.ok(c.conflicts.some(x => /volume 50ml vs 30ml/.test(x)), JSON.stringify(c.conflicts));
});

check('alphanumeric model difference is a spec conflict (ES5460 vs ES5061)', () => {
  const c = specConflicts(
    'Fossil Scarlette Womens Watch - ES5460',
    'Fossil Scarlette Mini Watch - ES5061'
  );
  assert.ok(c.conflicts.some(x => /model number/.test(x)), JSON.stringify(c.conflicts));
});

check('watch model difference is a spec conflict (EFV-640D vs EFR-526L)', () => {
  const c = specConflicts(
    'Casio Edifice Mens Analog Watch - EFV-640D-1AVUDF',
    'Casio Edifice Mens Analog Watch - EFR-526L-1AVUDF'
  );
  assert.ok(c.conflicts.some(x => /model number/.test(x)), JSON.stringify(c.conflicts));
});

check('barcode difference is a spec conflict', () => {
  const c = specConflicts(
    'Corelle 2724574014864 Vitrelle Crimson Trellis',
    'Corelle 4895204102003 Vitrelle Crimson Trellis'
  );
  assert.ok(c.conflicts.some(x => /barcode/.test(x)), JSON.stringify(c.conflicts));
});

check('a vetoed variant cannot supply a price even with a matching photo', () => {
  const ours = {
    title: 'Apple iPhone 12 Pro Max With Facetime 256GB 5G Gold Renewed',
    price: 1469,
    imageHash: 'aabbccddeeff0011',
  };
  const { best, accepted } = pickBest(ours, [
    {
      title: 'Apple Renewed - iPhone 14 Pro Max 256GB Gold 5G With Facetime - International Version',
      price: 1828,
      url: 'wrong',
      imageHash: 'aabbccddeeff0011',
    },
  ]);
  assert.strictEqual(accepted, false, 'a different generation must never drive Best Competitor Price');
  assert.ok(/SPEC CONFLICT/.test(best.evaluation.reasons.join(' ')), JSON.stringify(best.evaluation.reasons));
});

check('the correct variant still wins when the wrong one is cheaper', () => {
  const ours = { title: 'Apple iPhone 11 With Facetime Black 128GB 4G LTE Renewed', price: 748 };
  const { best } = pickBest(ours, [
    { title: 'Apple (Refurbished) iPhone 11 (64GB) - Black', price: 599, url: 'wrong-storage' },
    { title: 'Apple Renewed - iPhone 11 128GB Black 4G With Facetime - International Version', price: 750, url: 'right' },
  ]);
  assert.strictEqual(best.candidate.url, 'right');
});

console.log('\nsearch query construction');

check('builds the query as brand, model, configuration, condition', () => {
  assert.strictEqual(
    buildSpecQuery('Apple iPhone 12 Pro Max With Facetime 256GB 5G Graphite Renewed'),
    'apple iphone 12 pro max 256gb graphite renewed'
  );
});

check('the fallback query drops colour and condition', () => {
  assert.strictEqual(
    buildSpecQuery('Apple iPhone 11 With Facetime Black 128GB 4G LTE Renewed', { includeCondition: false, includeColour: false }),
    'apple iphone 11 128gb'
  );
});

check('titles with no model identity get no structured query', () => {
  // For dinnerware the descriptive words ARE the identity; dropping them would
  // make the search far worse.
  assert.strictEqual(
    buildSpecQuery('Corningware French White Round Set With Glass LID Covers Plastic 11 Pcs - 4116481'),
    null
  );
});

console.log('\nourshopee url parsing');

check('the SKU is read from the product URL, not the slug', () => {
  // A case-insensitive "/p" also matches the "/P" that begins "/PN3968", which
  // returned the slug and silently disabled the SKU lookup for every product.
  const { skuFromHref } = require('../src/lib/sites/ourshopee');
  assert.strictEqual(
    skuFromHref('/uae-en/apple-iphone-11-pro-max-256gb-4g-gold-single-sim-esim-intern/PN3968/p/?vendor_id=0'),
    'PN3968'
  );
  assert.strictEqual(skuFromHref('/uae-en/corelle-ocean-blues-16pc-dinnerware-set/PQ4072/p'), 'PQ4072');
  assert.strictEqual(skuFromHref('/uae-en/no-sku-here/p/'), null);
});

console.log('\nimage hashing');

check('identical hashes give similarity 1', () => {
  assert.strictEqual(imageSimilarity('aabbccddeeff0011', 'aabbccddeeff0011'), 1);
});

check('opposite hashes give similarity 0', () => {
  assert.strictEqual(imageSimilarity('0000000000000000', 'ffffffffffffffff'), 0);
});

check('an unhashable image returns null rather than 0', () => {
  assert.strictEqual(imageSimilarity(null, 'aabbccddeeff0011'), null);
});

console.log('\ngemini free tier module');

check('detects if ai is enabled when key is present', () => {
  const { isAiEnabled } = require('../src/lib/aiMatch');
  assert.strictEqual(typeof isAiEnabled(), 'boolean');
});

check('handles rate limiting without error', async () => {
  const { enforceRateLimit } = require('../src/lib/aiMatch');
  await enforceRateLimit();
});

console.log('\nregional version matching (iPhone / smartphone)');

check('exact TDRA version match wins over international version even if cheaper', () => {
  const target = { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - TDRA Version', price: 6349 };
  const candidates = [
    { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - International Version', price: 6199, url: 'intl' },
    { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - Middle East Version', price: 6299, url: 'me' },
    { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - TDRA Version', price: 6349, url: 'tdra' },
  ];
  const { best } = pickBest(target, candidates);
  assert.strictEqual(best.candidate.url, 'tdra');
  assert.ok(best.evaluation.reasons.some(r => /exact version match \(tdra\)/i.test(r)));
});

check('exact International version match wins when target is International', () => {
  const target = { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - International Version', price: 6199 };
  const candidates = [
    { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - TDRA Version', price: 6349, url: 'tdra' },
    { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - International Version', price: 6199, url: 'intl' },
  ];
  const { best } = pickBest(target, candidates);
  assert.strictEqual(best.candidate.url, 'intl');
  assert.ok(best.evaluation.reasons.some(r => /exact version match \(international\)/i.test(r)));
});

check('differing regional versions are rejected as spec conflicts and never accepted', () => {
  const target = { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - TDRA Version', price: 6349 };
  const candidates = [
    { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - International Version', price: 6199, url: 'intl' },
    { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - Middle East Version', price: 6299, url: 'me' },
    { title: 'Apple iPhone 18 Pro Max 512GB Burgundy - Japan Version', price: 6099, url: 'jp' },
  ];
  const { accepted, best } = pickBest(target, candidates);
  assert.strictEqual(accepted, false, 'differing regional version must never be accepted');
  assert.ok(best.evaluation.reasons.some(r => r.includes('SPEC CONFLICT: regional version')));
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log(' - ' + f));
  process.exit(1);
}
