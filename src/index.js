#!/usr/bin/env node
// Daily price comparison tool.
//
//   node src/index.js                     newest CSV in input/, all products
//   node src/index.js --limit 5           first 5 products only
//   node src/index.js --sku PQ4055,PQ4072 re-run specific SKUs only
//   node src/index.js --headless          no browser window
//   node src/index.js --input my.csv      explicit input file
//   node src/index.js --exact             output only the 11 template columns
//   node src/index.js --verbose           show every candidate and its score
//
// Reads the "Dump" CSV, discovers each product on OurShopee, Amazon.ae and
// Noon, then writes the "Result" CSV.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { launch, randomDelay, withRetry } = require('./lib/browser');
const { ImageHasher } = require('./lib/imageHash');
const { pickBest, summarize, priceFlag } = require('./lib/match');
const { parsePrice, titleSimilarity, attributeSimilarity, extractModelNumbers } = require('./lib/text');
const { parseSpec, buildSpecQuery, specConflicts } = require('./lib/spec');
const { isAiEnabled, aiMatchCandidates, PRIMARY_MODEL } = require('./lib/aiMatch');
const ourshopee = require('./lib/sites/ourshopee');
const amazon = require('./lib/sites/amazon');
const noon = require('./lib/sites/noon');
const {
  readDump,
  writeResult,
  newestCsv,
  defaultOutputPath,
  RESULT_COLUMNS,
} = require('./lib/csv');
const { DELAY_BETWEEN_PRODUCTS, DELAY_BETWEEN_SITES, THRESHOLDS } = require('./config');

const ROOT = path.join(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'input');
const RESULTS_DIR = path.join(ROOT, 'results');

function parseArgs(argv) {
  const args = { headless: false, limit: Infinity, input: null, output: null, exact: false, verbose: false, skus: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headless') args.headless = true;
    else if (a === '--exact') args.exact = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i], 10) || Infinity;
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--out' || a === '--output') args.output = argv[++i];
    else if (a === '--sku') args.skus = String(argv[++i] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (!a.startsWith('-') && args.input === null) args.input = a;
  }
  return args;
}

// Long catalogue titles over-constrain a site search, and raw titles bury the
// identity of the product under filler ("With Facetime", "4G LTE",
// "International Version"). For anything with a detectable model identity the
// query is rebuilt in the order brand -> model -> configuration -> condition, so
// "Apple iPhone 12 Pro Max With Facetime 256GB 5G Graphite Renewed" becomes
// "apple iphone 12 pro max 256gb graphite renewed". A second query drops the
// condition and colour in case the exact variant is not listed.
//
// Multi-tier search query builder optimized for Amazon.ae and Noon.com search algorithms.
// Constructs queries from exact barcodes and MPNs down to clean brand+series keywords.
function buildQueries(title, barcode = null) {
  const full = String(title || '').trim();
  const queries = [];

  // 1. If a barcode is known, it is always the highest-priority query.
  if (barcode) {
    const rawBarcode = String(barcode).trim();
    if (rawBarcode && !queries.includes(rawBarcode)) queries.push(rawBarcode);
    // If it is 12 digits, also try the 13-digit EAN with leading 0
    if (/^\d{12}$/.test(rawBarcode)) {
      const ean13 = '0' + rawBarcode;
      if (!queries.includes(ean13)) queries.push(ean13);
    } else if (/^0\d{12}$/.test(rawBarcode)) {
      // If 13 digits starting with 0, also try 12-digit UPC without leading 0
      const upc12 = rawBarcode.slice(1);
      if (!queries.includes(upc12)) queries.push(upc12);
    }
  }

  // Check if title has an embedded 12-14 digit barcode
  const m = full.match(/\b(\d{12,14})\b/);
  if (m && !queries.includes(m[1])) {
    queries.push(m[1]);
  }

  const cleanedTitle = full
    .replace(/\s+-\s+[34]\d{6}$/, '')
    .replace(/\s+-\s+\d+$/, '')
    .replace(/\s+-\s+TDRA\s+Version/i, '')
    .replace(/\s+-\s+Middle\s+East\s+Version/i, '')
    .replace(/\s+-\s+International\s+Version/i, '')
    .trim();

  const spec = parseSpec(full);
  const brand = spec.brand ? spec.brand.charAt(0).toUpperCase() + spec.brand.slice(1) : '';

  // 2. High-precision query with Brand + Model / MPN (e.g. "RENPHO R-Q001-BK", "Fissman 4895204103277")
  const partNums = extractModelNumbers(cleanedTitle).filter(mn =>
    !/^(?:5g|4g|1tb|2tb|\d+gb|\d+mp|\d+pcs?|\d+pack|[34]\d{6})$/i.test(mn)
  );
  if (brand && partNums.length > 0) {
    for (const pn of partNums) {
      const q = `${brand} ${pn}`.trim();
      if (!queries.includes(q)) queries.push(q);
    }
  }

  // 3. Clean electronics/phones query: Brand + Family + Gen + Tier + Storage (Clean, no display/chip fluff!)
  if (spec.family && spec.generation) {
    const tierStr = (spec.tiers || []).filter((v, i, a) => a.indexOf(v) === i).join(' ');
    const storageStr = spec.storage ? (spec.storage >= 1024 ? `${spec.storage / 1024}TB` : `${spec.storage}GB`) : '';
    const colorStr = spec.colors && spec.colors[0] ? spec.colors[0] : '';
    const versionMap = {
      tdra: 'TDRA',
      middle_east: 'Middle East',
      international: 'International',
      japan: 'Japan',
      us: 'US',
      hong_kong: 'Hong Kong',
      uk_europe: 'UK',
      india: 'India',
      ksa: 'KSA',
      singapore: 'Singapore',
      canada: 'Canada',
      australia: 'Australia',
    };
    const versionStr = versionMap[spec.version] || (spec.version ? spec.version.replace(/_/g, ' ').toUpperCase() : '');
    const simMap = {
      dual_esim: 'eSIM',
      nano_sim_esim: 'Nano SIM',
      dual_physical_sim: 'Dual SIM',
    };
    const simStr = simMap[spec.simConfig] || '';

    // Targeted query with Version and SIM config if present (prioritizes exact marketplace version listings)
    if (versionStr || simStr) {
      const phoneVer = [brand || 'Apple', spec.family, spec.generation, tierStr, storageStr, versionStr, simStr].filter(Boolean).join(' ');
      if (phoneVer && !queries.includes(phoneVer)) queries.push(phoneVer);
    }

    const phoneFull = [brand || 'Apple', spec.family, spec.generation, tierStr, storageStr, colorStr].filter(Boolean).join(' ');
    if (phoneFull && !queries.includes(phoneFull)) queries.push(phoneFull);

    const phoneCore = [brand || 'Apple', spec.family, spec.generation, tierStr, storageStr].filter(Boolean).join(' ');
    if (phoneCore && !queries.includes(phoneCore)) queries.push(phoneCore);
  }

  // 4. For Cookware/Dinnerware/Household: Brand + Series + Pack
  const packMatch = full.match(/\b(\d+)\s*(?:pcs?|pieces?|pack|set)\b/i);
  const packStr = packMatch ? `${packMatch[1]} Piece` : '';
  const seriesMatch = cleanedTitle.match(new RegExp(`^(?:${brand}\\s+)?([A-Za-z0-9\\s]+?)(?:,|Dinnerware|Cookware|Set|Handy|Spray|Smart|-\\s*)`, 'i'));
  const series = seriesMatch ? seriesMatch[1].replace(/^(?:Dinnerware|Cookware|Set)\s*/i, '').trim() : '';
  if (series && series.length > 2 && series.split(' ').length <= 4) {
    const seriesQuery = [brand, series, packStr].filter(Boolean).join(' ');
    if (seriesQuery.length > 5 && !queries.includes(seriesQuery)) queries.push(seriesQuery);
  }

  // 5. Structured query (brand + model + specs)
  const structured = buildSpecQuery(full);
  if (structured) {
    const core = buildSpecQuery(full, { includeCondition: false, includeColour: false });
    [structured, core].filter(Boolean).forEach(q => { if (!queries.includes(q)) queries.push(q); });
  }

  // 6. Clean query (first 6 core words)
  let cleanWords = cleanedTitle
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  const short6 = cleanWords.slice(0, 6).join(' ');
  if (short6 && !queries.includes(short6)) queries.push(short6);

  if (cleanedTitle && !queries.includes(cleanedTitle)) queries.push(cleanedTitle);
  if (!queries.includes(full)) queries.push(full);
  return queries;
}

// Cheap pre-rank on text only, so we download images for the few candidates
// that actually have a chance of winning. A spec conflict is penalised here too,
// otherwise the wrong variant (256GB instead of 128GB) can crowd the genuine one
// out of the finalist list before it is ever scored properly.
function preRank(ours, candidates, keep = 5) {
  return candidates
    .map(c => {
      const t = titleSimilarity(ours.title, c.title || '');
      const a = attributeSimilarity(ours.title, c.title || '').score;
      const conflict = specConflicts(ours.title, c.title || '').conflicts.length > 0;
      return { c, pre: conflict ? 0.1 * (0.65 * t + 0.35 * a) : 0.65 * t + 0.35 * a };
    })
    .sort((x, y) => y.pre - x.pre)
    .slice(0, keep)
    .map(x => x.c);
}

async function resolveSite({ page, hasher, site, ours, log, label }) {
  const queries = buildQueries(ours.title, ours.barcode);
  let bestEntry = null;
  let bestAccepted = false;
  let ranked = [];
  let usedQuery = null;
  let totalCandidates = 0;
  const seenAiFingerprints = new Map();

  for (const query of queries) {
    let candidates;
    try {
      candidates = await site.searchCandidates(page, query, THRESHOLDS.candidatesPerSite);
    } catch (error) {
      if (isFatalPageError(error)) throw error;
      log(`    ${label}: ${error.code === 'BLOCKED' ? 'bot challenge' : error.message}`);
      candidates = [];
    }

    if (!candidates || !candidates.length) continue;

    usedQuery = query;
    totalCandidates += candidates.length;
    const finalists = preRank(ours, candidates, THRESHOLDS.imageFinalists);

    // Attach image hashes only for the finalists.
    await Promise.all(finalists.map(async c => { c.imageHash = await hasher.hash(c.image); }));
    const hashed = finalists.filter(c => c.imageHash).length;
    log(`    ${label}: ${candidates.length} results, ${finalists.length} finalists, ${hashed} photos hashed, reference photo=${ours.imageHash ? 'yes' : 'no'}`);

    for (const c of finalists) c.price = parsePrice(c.priceRaw);

    let result = pickBest(ours, finalists);

    // AI Filtration Layer: evaluate finalists using Gemini Free Tier module if enabled
    if (isAiEnabled() && finalists.length > 0) {
      // Relevance filter: skip AI call if candidates have near-zero text similarity and no shared model number
      const topTitle = finalists[0]?.title || '';
      const topSim = titleSimilarity(ours.title, topTitle);
      const ourModels = extractModelNumbers(ours.title);
      const hasModel = ourModels.some(m => topTitle.toLowerCase().includes(m.toLowerCase()));
      const isPlausible = topSim >= 0.15 || hasModel;

      const candidateKey = finalists.slice(0, 4).map(c => c.id || c.title).join('|');

      let aiDecision = null;
      if (!isPlausible) {
        log(`    [Gemini AI] ${label}: skipped query candidates (low text similarity < 15%)`);
      } else if (seenAiFingerprints.has(candidateKey)) {
        // Reuse cached AI decision if this query returned the same candidates as an earlier query
        aiDecision = seenAiFingerprints.get(candidateKey);
      } else {
        try {
          aiDecision = await aiMatchCandidates(ours, finalists);
          if (aiDecision) seenAiFingerprints.set(candidateKey, aiDecision);
        } catch (err) {
          console.log(`    [Gemini AI] Evaluation error: ${err.message}`);
        }
      }

      if (aiDecision) {
        if (aiDecision.matchedCandidateIndex >= 0 && aiDecision.matchedCandidateIndex < finalists.length) {
          const aiChosen = finalists[aiDecision.matchedCandidateIndex];
          const aiScore = aiDecision.confidence === 'High' ? 0.95 : (aiDecision.confidence === 'Medium' ? 0.75 : 0.40);
          const candidateRank = result.ranked?.find(r => r.candidate === aiChosen);
          const chosenPriceFlag = candidateRank?.evaluation?.priceFlag || priceFlag(ours.price ?? null, aiChosen.price ?? null);
          console.log(`    [Gemini AI] ${label}: ${aiDecision.confidence} match -> "${String(aiChosen.title).slice(0, 65)}" (${aiDecision.reason})`);
          result = {
            best: {
              candidate: aiChosen,
              evaluation: {
                score: aiScore,
                confidence: aiDecision.confidence,
                reasons: [`AI (${aiDecision.modelUsed || 'Gemini'}): ${aiDecision.reason}`],
                specConflicts: [],
                signals: { ai: 1, text: candidateRank?.evaluation?.signals?.title ?? result.best?.evaluation?.signals?.title ?? null },
                priceFlag: chosenPriceFlag,
              },
            },
            ranked: result.ranked,
            accepted: aiDecision.confidence === 'High' || aiDecision.confidence === 'Medium',
          };
        } else if (aiDecision.matchedCandidateIndex === -1) {
          if (!seenAiFingerprints.has(candidateKey + '_logged')) {
            console.log(`    [Gemini AI] ${label}: no match (${aiDecision.confidence}) - ${aiDecision.reason}`);
            seenAiFingerprints.set(candidateKey + '_logged', true);
          }

          // If algorithmic matcher already verified a strong match (score >= 0.70) with 0 spec conflicts,
          // do NOT discard it unless the AI detected an explicit hard conflict (e.g., accessory/case, wrong model, different brand).
          const isHardConflict = /accessory|case|cover|protector|refill|replacement|different brand|wrong storage|wrong generation|wrong model|different series/i.test(aiDecision.reason);
          if (!isHardConflict && result.best && result.best.evaluation.score >= 0.70 && (!result.best.evaluation.specConflicts || result.best.evaluation.specConflicts.length === 0)) {
            result.best.evaluation.confidence = 'Medium';
            result.best.evaluation.reasons = [`Algorithmic match verified (AI neutral): ${aiDecision.reason}`, ...result.best.evaluation.reasons];
            result.accepted = true;
          } else {
            result = {
              best: result.best,
              ranked: result.ranked,
              accepted: false,
            };
            if (result.best) {
              result.best.evaluation.reasons = [`AI rejected (${aiDecision.modelUsed || 'Gemini'}): ${aiDecision.reason}`, ...result.best.evaluation.reasons];
              result.best.evaluation.confidence = 'None';
              result.best.evaluation.score = 0.20;
            }
          }
        }
      }
    }

    if (result.best && (!bestEntry || result.best.evaluation.score > bestEntry.evaluation.score)) {
      bestEntry = result.best;
      bestAccepted = result.accepted;
      ranked = result.ranked;
      log(`    ${label} signals: ${JSON.stringify(result.best.evaluation.signals)}`);
    }

    if (bestEntry && bestAccepted && bestEntry.evaluation.score >= THRESHOLDS.high) break;
  }

  if (!bestEntry) {
    return { status: 'not_found', confidence: 'None', score: 0, query: usedQuery, candidates: totalCandidates };
  }

  const e = bestEntry.evaluation;
  const found = {
    price: bestEntry.candidate.price ?? null,
    title: bestEntry.candidate.title,
    url: bestEntry.candidate.url,
    id: bestEntry.candidate.id,
  };

  if (log && ranked.length > 1) {
    log(`    ${label} candidates: ${summarize(ranked)}`);
  }

  // Below the acceptance bar we report what we saw but do not trust the price.
  if (!bestAccepted) {
    return {
      status: 'unverified',
      found,
      confidence: 'Low',
      score: e.score,
      priceFlag: e.priceFlag,
      specConflict: (e.specConflicts || []).join(', '),
      query: usedQuery,
      candidates: totalCandidates,
    };
  }

  return {
    status: 'matched',
    found,
    confidence: e.confidence,
    score: e.score,
    priceFlag: e.priceFlag,
    reasons: e.reasons,
    specConflict: (e.specConflicts || []).join(', '),
    query: usedQuery,
    candidates: totalCandidates,
  };
}

function bestCompetitorPrice(ourPrice, noonPrice, amazonPrice) {
  // Confirmed from the user's sheet: the minimum across our own price and both
  // competitors, so it equals our price when we are already the cheapest.
  const values = [ourPrice, noonPrice, amazonPrice].filter(v => typeof v === 'number' && Number.isFinite(v));
  return values.length ? Math.min(...values) : null;
}

function priceDifference(ourPrice, best) {
  if (typeof ourPrice !== 'number' || typeof best !== 'number') return null;
  return Math.round((ourPrice - best) * 100) / 100;
}

const fmt = v => (v === null || v === undefined ? '' : v);

// Once the browser is gone every remaining product fails, and those failures are
// indistinguishable in the report from a day when the products genuinely were
// not found - a sheet full of confident-looking blanks. Stop instead and keep
// the rows already collected.
const FATAL_PAGE_RE = /Target (?:page|context) or browser has been closed|browser has been closed|Page crashed|Browser closed/i;

function isFatalPageError(error) {
  return FATAL_PAGE_RE.test((error && error.message) || '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const inputPath = args.input
    ? path.resolve(args.input)
    : newestCsv(INPUT_DIR);

  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(`No input CSV found. Drop your daily dump into:\n  ${INPUT_DIR}\n`);
    process.exit(1);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outputPath = args.output ? path.resolve(args.output) : defaultOutputPath(RESULTS_DIR);

  console.log('OurShopee Price Monitor');
  console.log('-----------------------');
  console.log(`Input : ${path.relative(ROOT, inputPath)}`);
  console.log(`Output: ${path.relative(ROOT, outputPath)}`);
  console.log(`Mode  : ${args.headless ? 'headless' : 'visible browser'}`);
  console.log(`AI    : ${isAiEnabled() ? `Gemini Free Tier Module Enabled (@google/genai, primary: ${PRIMARY_MODEL})` : 'Heuristic Rules (Add GEMINI_API_KEY in .env for AI)'}\n`);

  const { rows, columnMap } = await readDump(inputPath);
  if (!rows.length) {
    console.error('Input CSV contains no product rows.');
    process.exit(1);
  }
  if (!columnMap.title) {
    console.error('Could not find a "Product Title" column in the input CSV.');
    process.exit(1);
  }

  const selected = (args.skus
    ? rows.filter(r => args.skus.includes(String(r.sku || '').trim().toUpperCase()))
    : rows
  ).slice(0, args.limit);

  if (!selected.length) {
    console.error(`No rows to process${args.skus ? ` for SKU(s): ${args.skus.join(', ')}` : ''}.`);
    process.exit(1);
  }

  const limit = selected.length;
  console.log(`Loaded ${rows.length} products. Processing ${limit}.\n`);

  const { browser, context, page } = await launch({ headless: args.headless });
  const hasher = new ImageHasher(context, page);

  const records = [];
  let interrupted = false;

  const flush = async () => {
    if (records.length) await writeResult(outputPath, records, { exactOnly: args.exact });
  };

  // Ctrl-C once: let the product in flight finish, then the loop breaks on
  // `interrupted` and main() saves on its way out. Ctrl-C twice: the user is
  // not waiting, so save what we have and exit now.
  // Flushing here as well as in the loop used to race - the handler could
  // write a half-finished record set while the loop was still appending to it.
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      interrupted = true;
      if (stopping) {
        console.log(`\n${signal} again - saving ${records.length} rows and exiting now.`);
        await flush();
        await browser.close().catch(() => {});
        process.exit(0);
      }
      stopping = true;
      console.log(`\n${signal} received - finishing the current product, then saving. Press Ctrl-C again to stop immediately.`);
    });
  }

  for (let i = 0; i < limit; i++) {
    const row = selected[i];
    const log = args.verbose
      ? (m => console.log(m))
      : (m => { if (/bot challenge|error|failed/i.test(m)) console.log(m); });

    console.log(`[${i + 1}/${limit}] ${row.sku || '(no SKU)'} - ${String(row.title).slice(0, 60)}`);

    const record = {
      Section: row.section,
      SKU: row.sku,
      'Product Title': row.title,
      'OurShopee Price': row.ourPriceRaw,
      'Noon Price': row.noonPriceRaw,
      'Amazon Price': '',
      'Best Competitor Price': '',
      'Price Difference': '',
      'OurShopee Link': row.ourLink,
      'Noon Link': row.noonLink,
      'Amazon Link': row.amazonLink,
      'Amazon ASIN': '',
      'Noon Product ID': '',
      'Amazon Matched Title': '',
      'Noon Matched Title': '',
      'Amazon Confidence': '',
      'Noon Confidence': '',
      'Amazon Score': '',
      'Noon Score': '',
      'Price Flag': '',
      Status: '',
    };

    const notes = [];

    let fatal = false;
    try {
      // ---- OurShopee: establishes the URL, the live price and the reference photo ----
      let our = {
        title: row.title,
        price: parsePrice(row.ourPriceRaw),
        imageHash: null,
        url: row.ourLink || null,
        id: row.sku,
        barcode: row.barcode || null,
      };

      let osCandidates = [];
      try {
        osCandidates = await ourshopee.findBySku(page, row.sku);
        if (!osCandidates.length) {
          const byTitle = await ourshopee.searchCandidates(page, row.title, 6);
          osCandidates = byTitle;
        }
      } catch (error) {
        if (isFatalPageError(error)) throw error;
        notes.push(`ourshopee:${error.message.slice(0, 40)}`);
      }

      if (osCandidates.length) {
        for (const c of osCandidates) c.price = parsePrice(c.priceRaw);
        const skuMatch = osCandidates.find(c => c.id && row.sku && c.id.toLowerCase() === String(row.sku).toLowerCase());
        const chosen = skuMatch || pickBest({ title: row.title, price: our.price }, osCandidates).best?.candidate;

        if (chosen) {
          // A title search can land on a sibling variant: row PC4711 resolved to
          // PC4714's listing, which then overwrote this row's link and price with
          // another product's. The sibling's colour and configuration also bias
          // the competitor query, so nothing is adopted from it - the dump stays
          // authoritative and Status says which SKU was actually found.
          const foreignSku = Boolean(row.sku) && chosen.id &&
            String(chosen.id).toLowerCase() !== String(row.sku).trim().toLowerCase();

          if (foreignSku) {
            notes.push(`ourshopee found ${chosen.id} not ${row.sku}-kept dump values`);
          } else {
            our.url = chosen.url;
            our.id = chosen.id || our.id;
            // Prefer the verified OurShopee title as the search string for competitors.
            if (chosen.title) our.title = chosen.title;
            const livePrice = chosen.price;
            const dumpPrice = parsePrice(row.ourPriceRaw);
            if (livePrice !== null) {
              if (dumpPrice !== null && Math.abs(livePrice - dumpPrice) > 0.01) {
                notes.push(`ourshopee price changed ${dumpPrice}->${livePrice}`);
              }
              our.price = livePrice;
              record['OurShopee Price'] = livePrice;
            }
            our.imageHash = await hasher.hash(chosen.image);
            if (!our.imageHash) notes.push('no reference image');
          }
        }
      } else {
        notes.push('ourshopee not found');
      }

      record['OurShopee Link'] = our.url || '';

      await randomDelay(DELAY_BETWEEN_SITES);

      // ---- Amazon ----
      const amz = await resolveSite({ page, hasher, site: amazon, ours: our, log, label: 'amazon' });
      if (amz.status === 'matched') {
        record['Amazon Price'] = amz.found.price ?? '';
        record['Amazon Link'] = amz.found.url || '';
        record['Amazon ASIN'] = amz.found.id || '';
        record['Amazon Matched Title'] = amz.found.title || '';
        record['Amazon Confidence'] = amz.confidence;
        record['Amazon Score'] = amz.score;
        notes.push(`amazon:${amz.confidence}`);
      } else if (amz.status === 'unverified') {
        // Show what we found for a human to check, but contribute no price.
        record['Amazon Matched Title'] = `(UNVERIFIED) ${amz.found?.title || ''}`.slice(0, 200);
        record['Amazon Confidence'] = 'Low';
        record['Amazon Score'] = amz.score;
        notes.push(amz.specConflict
          ? `amazon:rejected(${amz.specConflict})`
          : 'amazon:unverified-check-manually');
      } else {
        record['Amazon Confidence'] = 'None';
        notes.push('amazon:not-found');
      }

      await randomDelay(DELAY_BETWEEN_SITES);

      // ---- Noon ----
      const no = await resolveSite({ page, hasher, site: noon, ours: our, log, label: 'noon' });
      if (no.status === 'matched') {
        record['Noon Price'] = no.found.price ?? record['Noon Price'];
        record['Noon Link'] = no.found.url || '';
        record['Noon Product ID'] = no.found.id || '';
        record['Noon Matched Title'] = no.found.title || '';
        record['Noon Confidence'] = no.confidence;
        record['Noon Score'] = no.score;
        notes.push(`noon:${no.confidence}`);
      } else if (no.status === 'unverified') {
        record['Noon Matched Title'] = `(UNVERIFIED) ${no.found?.title || ''}`.slice(0, 200);
        record['Noon Confidence'] = 'Low';
        record['Noon Score'] = no.score;
        notes.push(no.specConflict
          ? `noon:rejected(${no.specConflict})-dump-price-shown-not-used`
          : 'noon:unverified-dump-price-shown-not-used');
      } else {
        record['Noon Confidence'] = 'None';
        notes.push('noon:not-found-dump-price-shown-not-used');
      }

      // ---- Derived columns ----
      // Best Competitor Price and Price Difference are the numbers that drive a
      // repricing decision, so they may only use prices verified today. A Noon
      // Price carried over from the dump stays visible in its own column but is
      // excluded here - it is stale by definition, and the whole point of the
      // run is to replace it.
      const ourPrice = parsePrice(record['OurShopee Price']);
      const noonPrice = parsePrice(record['Noon Price']);
      const amazonPrice = parsePrice(record['Amazon Price']);
      const verifiedNoon = no.status === 'matched' ? noonPrice : null;
      const verifiedAmazon = amz.status === 'matched' ? amazonPrice : null;
      const best = bestCompetitorPrice(ourPrice, verifiedNoon, verifiedAmazon);

      record['Best Competitor Price'] = best === null ? '' : best;
      const diff = priceDifference(ourPrice, best);
      record['Price Difference'] = diff === null ? '' : diff.toFixed(2);

      // Report each site's price agreement separately; an unmatched site
      // contributes nothing rather than implying agreement it never checked.
      const flagParts = [];
      if (amz.status === 'matched') flagParts.push(`amazon:${amz.priceFlag}`);
      if (no.status === 'matched') flagParts.push(`noon:${no.priceFlag}`);
      record['Price Flag'] = flagParts.join('; ');

      // A large price gap is what triggers a repricing decision, so it should
      // demand better evidence than a marginal match. When the cheapest
      // verified competitor price - the one Best/Difference are built from -
      // comes from a match that is not High confidence and sits outside the
      // price window, say so loudly rather than presenting a clean number.
      // Related-but-different products from the same brand (a "floor cleaning
      // kit" matched against a "spray mop kit") look plausible on photo alone.
      const driving = [
        { site: 'amazon', price: verifiedAmazon, result: amz },
        { site: 'noon', price: verifiedNoon, result: no },
      ].find(s =>
        s.price !== null &&
        best !== null &&
        Math.abs(s.price - best) < 0.005 &&
        (ourPrice === null || s.price < ourPrice)
      );

      if (driving && driving.result.confidence !== 'High' && /^Outside/.test(driving.result.priceFlag || '')) {
        notes.push(`REVIEW:${driving.site}-sets-best-price-but-only-${driving.result.confidence}-and-outside-window`);
      }

      record.Status = notes.join('; ');

      console.log(`    ours=${fmt(ourPrice)} amazon=${fmt(verifiedAmazon)} (${record['Amazon Confidence']}) noon=${fmt(verifiedNoon)} (${record['Noon Confidence']}) -> best=${fmt(best)} diff=${fmt(record['Price Difference'])}`);
    } catch (error) {
      fatal = isFatalPageError(error);
      record.Status = `${fatal ? 'BROWSER CLOSED' : 'ERROR'}: ${error.message}`.slice(0, 120);
      console.log(`    ${record.Status}`);
    }

    records.push(record);
    await flush(); // incremental save so a crash never loses the whole run

    if (fatal) {
      const remaining = limit - i - 1;
      console.log(`\nBrowser closed - stopping. ${records.length} rows saved; ${remaining} product${remaining === 1 ? '' : 's'} not checked.`);
      console.log(`Re-run them with: node src/index.js --sku <SKU>${remaining ? ',<SKU>' : ''}`);
      break;
    }
    if (interrupted) break;
    if (i < limit - 1) await randomDelay(DELAY_BETWEEN_PRODUCTS);
  }

  await browser.close().catch(() => {});

  console.log(`\nDone. ${records.length} rows written to:\n  ${outputPath}`);
  console.log(`Columns: ${RESULT_COLUMNS.length} template columns${args.exact ? '' : ' + audit columns'}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('\nFatal:', error.message);
    process.exit(1);
  });
}

module.exports = {
  buildQueries,
  main,
};
