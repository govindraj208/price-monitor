// Job runner — bridges the Express API to the existing scraper core.
//
// The scraper (src/index.js in the root project) was written as a CLI.
// This module re-uses its library functions directly so we don't fork the code.

const path = require('path');
const fs = require('fs');

// Resolve root scraper path flexibly
let SCRAPER_SRC;
if (fs.existsSync(path.resolve(__dirname, '../../../src'))) {
  SCRAPER_SRC = path.resolve(__dirname, '../../../src');
} else if (fs.existsSync(path.resolve(__dirname, '../../src'))) {
  SCRAPER_SRC = path.resolve(__dirname, '../../src');
} else if (fs.existsSync(path.resolve(process.cwd(), 'src'))) {
  SCRAPER_SRC = path.resolve(process.cwd(), 'src');
} else {
  SCRAPER_SRC = path.resolve(__dirname, '../../src');
}

// Require from the scraper package
function scraperRequire(mod) {
  return require(path.join(SCRAPER_SRC, mod));
}

// ── Shared references ─────────────────────────────────────────────────────────
let _launch, _ImageHasher, _pickBest, _summarize, _priceFlag,
    _parsePrice, _titleSimilarity, _attributeSimilarity, _extractModelNumbers,
    _parseSpec, _buildSpecQuery, _specConflicts,
    _isAiEnabled, _aiMatchCandidates,
    _ourshopee, _amazon, _noon,
    _readDump, _writeResult, _RESULT_COLUMNS,
    _DELAY_BETWEEN_PRODUCTS, _DELAY_BETWEEN_SITES, _THRESHOLDS,
    _buildQueries;

function loadScraperModules() {
  if (_launch) return; // already loaded
  try {
    ({ launch: _launch, randomDelay: _randomDelay, withRetry: _withRetry } = scraperRequire('lib/browser'));
    ({ ImageHasher: _ImageHasher } = scraperRequire('lib/imageHash'));
    ({ pickBest: _pickBest, summarize: _summarize, priceFlag: _priceFlag } = scraperRequire('lib/match'));
    ({ parsePrice: _parsePrice, titleSimilarity: _titleSimilarity, attributeSimilarity: _attributeSimilarity, extractModelNumbers: _extractModelNumbers } = scraperRequire('lib/text'));
    ({ parseSpec: _parseSpec, buildSpecQuery: _buildSpecQuery, specConflicts: _specConflicts } = scraperRequire('lib/spec'));
    ({ isAiEnabled: _isAiEnabled, aiMatchCandidates: _aiMatchCandidates } = scraperRequire('lib/aiMatch'));
    _ourshopee = scraperRequire('lib/sites/ourshopee');
    _amazon = scraperRequire('lib/sites/amazon');
    _noon = scraperRequire('lib/sites/noon');
    ({ readDump: _readDump, writeResult: _writeResult, RESULT_COLUMNS: _RESULT_COLUMNS } = scraperRequire('lib/csv'));
    ({ DELAY_BETWEEN_PRODUCTS: _DELAY_BETWEEN_PRODUCTS, DELAY_BETWEEN_SITES: _DELAY_BETWEEN_SITES, THRESHOLDS: _THRESHOLDS } = scraperRequire('config'));
    ({ buildQueries: _buildQueries } = scraperRequire('index'));
  } catch (err) {
    throw new Error(`Failed to load scraper modules from ${SCRAPER_SRC}: ${err.message}`);
  }
}

let _randomDelay, _withRetry;

// ── Fatal error detection (same as original) ──────────────────────────────────
const FATAL_PAGE_RE = /Target (?:page|context) or browser has been closed|browser has been closed|Page crashed|Browser closed/i;
function isFatalPageError(error) {
  return FATAL_PAGE_RE.test((error && error.message) || '');
}

// ── Pre-ranking helper (same logic as original index.js) ─────────────────────
function preRank(ours, candidates, keep = 5) {
  return candidates
    .map(c => {
      const t = _titleSimilarity(ours.title, c.title || '');
      const a = _attributeSimilarity(ours.title, c.title || '').score;
      const conflict = _specConflicts(ours.title, c.title || '').conflicts.length > 0;
      return { c, pre: conflict ? 0.1 * (0.65 * t + 0.35 * a) : 0.65 * t + 0.35 * a };
    })
    .sort((x, y) => y.pre - x.pre)
    .slice(0, keep)
    .map(x => x.c);
}

// ── resolveSite — same logic as original (copy-adapted for API use) ───────────
async function resolveSite({ page, hasher, site, ours, label }) {
  const queries = _buildQueries(ours.title, ours.barcode);
  let bestEntry = null;
  let bestAccepted = false;
  let ranked = [];
  let usedQuery = null;
  let totalCandidates = 0;
  const seenAiFingerprints = new Map();

  for (const query of queries) {
    let candidates;
    try {
      candidates = await site.searchCandidates(page, query, _THRESHOLDS.candidatesPerSite);
    } catch (error) {
      if (isFatalPageError(error)) throw error;
      candidates = [];
    }

    if (!candidates || !candidates.length) continue;

    usedQuery = query;
    totalCandidates += candidates.length;
    const finalists = preRank(ours, candidates, _THRESHOLDS.imageFinalists);

    await Promise.all(finalists.map(async c => { c.imageHash = await hasher.hash(c.image); }));
    for (const c of finalists) c.price = _parsePrice(c.priceRaw);

    let result = _pickBest(ours, finalists);

    if (_isAiEnabled() && finalists.length > 0) {
      const topTitle = finalists[0]?.title || '';
      const topSim = _titleSimilarity(ours.title, topTitle);
      const ourModels = _extractModelNumbers(ours.title);
      const hasModel = ourModels.some(m => topTitle.toLowerCase().includes(m.toLowerCase()));
      const isPlausible = topSim >= 0.15 || hasModel;

      const candidateKey = finalists.slice(0, 4).map(c => c.id || c.title).join('|');
      let aiDecision = null;

      if (isPlausible) {
        if (seenAiFingerprints.has(candidateKey)) {
          aiDecision = seenAiFingerprints.get(candidateKey);
        } else {
          try {
            aiDecision = await _aiMatchCandidates(ours, finalists);
            if (aiDecision) seenAiFingerprints.set(candidateKey, aiDecision);
          } catch (_) {}
        }
      }

      if (aiDecision) {
        if (aiDecision.matchedCandidateIndex >= 0 && aiDecision.matchedCandidateIndex < finalists.length) {
          const aiChosen = finalists[aiDecision.matchedCandidateIndex];
          const aiScore = aiDecision.confidence === 'High' ? 0.95 : (aiDecision.confidence === 'Medium' ? 0.75 : 0.40);
          const candidateRank = result.ranked?.find(r => r.candidate === aiChosen);
          const chosenPriceFlag = candidateRank?.evaluation?.priceFlag || _priceFlag(ours.price ?? null, aiChosen.price ?? null);
          result = {
            best: {
              candidate: aiChosen,
              evaluation: {
                score: aiScore,
                confidence: aiDecision.confidence,
                reasons: [`AI: ${aiDecision.reason}`],
                specConflicts: [],
                signals: { ai: 1 },
                priceFlag: chosenPriceFlag,
              },
            },
            ranked: result.ranked,
            accepted: aiDecision.confidence === 'High' || aiDecision.confidence === 'Medium',
          };
        } else if (aiDecision.matchedCandidateIndex === -1) {
          const isHardConflict = /accessory|case|cover|protector|refill|replacement|different brand|wrong storage|wrong generation|wrong model|different series/i.test(aiDecision.reason);
          if (!isHardConflict && result.best && result.best.evaluation.score >= 0.70 && (!result.best.evaluation.specConflicts || result.best.evaluation.specConflicts.length === 0)) {
            result.best.evaluation.confidence = 'Medium';
            result.accepted = true;
          } else {
            result = { best: result.best, ranked: result.ranked, accepted: false };
          }
        }
      }
    }

    if (result.best && (!bestEntry || result.best.evaluation.score > bestEntry.evaluation.score)) {
      bestEntry = result.best;
      bestAccepted = result.accepted;
      ranked = result.ranked;
    }

    if (bestEntry && bestAccepted && bestEntry.evaluation.score >= _THRESHOLDS.high) break;
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

// ── Main job runner ───────────────────────────────────────────────────────────
async function runJob({ jobId, inputPath, outputPath, options, job }) {
  loadScraperModules();

  const addLog = (msg) => {
    job.logs.push(`${new Date().toTimeString().slice(0, 8)} ${msg}`);
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  };

  job.status = 'running';
  addLog('Starting scrape job...');

  let browser, context, page;
  try {
    const { rows } = await _readDump(inputPath);
    if (!rows.length) throw new Error('Input CSV has no product rows');

    const selected = (options.skus
      ? rows.filter(r => options.skus.includes(String(r.sku || '').trim().toUpperCase()))
      : rows
    ).slice(0, options.limit);

    if (!selected.length) throw new Error('No rows matched the given filters');

    job.progress.total = selected.length;
    addLog(`Loaded ${rows.length} products. Processing ${selected.length}.`);

    ({ browser, context, page } = await _launch({ headless: options.headless }));
    const hasher = new _ImageHasher(context, page);

    const records = [];
    const fmt = v => (v === null || v === undefined ? '' : v);

    function bestCompetitorPrice(ourPrice, noonPrice, amazonPrice) {
      // Confirmed rule: 0 or empty values are NOT valid prices and MUST be ignored
      const competitorPrices = [noonPrice, amazonPrice].filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
      if (typeof ourPrice === 'number' && Number.isFinite(ourPrice) && ourPrice > 0) {
        const all = [ourPrice, ...competitorPrices];
        return Math.min(...all);
      }
      return competitorPrices.length ? Math.min(...competitorPrices) : null;
    }

    function priceDifference(ourPrice, best) {
      if (typeof ourPrice !== 'number' || typeof best !== 'number' || ourPrice <= 0 || best <= 0) return null;
      return Math.round((ourPrice - best) * 100) / 100;
    }

    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      job.progress.processed = i;
      job.progress.current = `[${i + 1}/${selected.length}] ${String(row.title).slice(0, 60)}`;
      addLog(job.progress.current);

      const record = {
        Section: row.section || '',
        SKU: row.sku || '',
        'Product Title': row.title || '',
        'OurShopee Price': row.ourPriceRaw || '',
        'Noon Price': row.noonPriceRaw || '',
        'Amazon Price': '',
        'Best Competitor Price': '',
        'Price Difference': '',
        'OurShopee Link': row.ourLink || '',
        'Noon Link': row.noonLink || '',
        'Amazon Link': row.amazonLink || '',
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
        let our = {
          title: row.title,
          price: _parsePrice(row.ourPriceRaw),
          imageHash: null,
          url: row.ourLink || null,
          id: row.sku,
          barcode: row.barcode || null,
        };

        // If direct OurShopee link provided, scrape it directly
        if (row.ourLink && /^https?:\/\//i.test(row.ourLink)) {
          try {
            const osDirect = await _ourshopee.scrapeProduct(page, row.ourLink);
            if (osDirect && osDirect.priceRaw) {
              const livePrice = _parsePrice(osDirect.priceRaw);
              if (livePrice && livePrice > 0) {
                our.price = livePrice;
                record['OurShopee Price'] = livePrice;
              }
              if (osDirect.title) our.title = osDirect.title;
              if (osDirect.image) our.imageHash = await hasher.hash(osDirect.image);
            }
          } catch (e) {
            notes.push(`ourshopee-direct:${e.message.slice(0, 30)}`);
          }
        }

        let osCandidates = [];
        if (!our.price || !our.url) {
          try {
            osCandidates = await _ourshopee.findBySku(page, row.sku);
            if (!osCandidates.length) {
              // Try title search
              osCandidates = await _ourshopee.searchCandidates(page, row.title, 6);
            }
          } catch (error) {
            if (isFatalPageError(error)) throw error;
            notes.push(`ourshopee:${error.message.slice(0, 40)}`);
          }

          if (osCandidates.length) {
            for (const c of osCandidates) c.price = _parsePrice(c.priceRaw);
            const skuMatch = osCandidates.find(c => c.id && row.sku && c.id.toLowerCase() === String(row.sku).toLowerCase());
            const chosen = skuMatch || _pickBest({ title: row.title, price: our.price }, osCandidates).best?.candidate;

            if (chosen) {
              const foreignSku = Boolean(row.sku) && chosen.id &&
                String(chosen.id).toLowerCase() !== String(row.sku).trim().toLowerCase();

              if (foreignSku) {
                notes.push(`ourshopee found ${chosen.id} not ${row.sku}-kept dump values`);
              } else {
                our.url = chosen.url || our.url;
                our.id = chosen.id || our.id;
                if (chosen.title) our.title = chosen.title;
                const livePrice = chosen.price;
                if (livePrice !== null && livePrice > 0) {
                  our.price = livePrice;
                  record['OurShopee Price'] = livePrice;
                }
                our.imageHash = await hasher.hash(chosen.image);
              }
            }
          } else if (!our.url) {
            notes.push('ourshopee not found');
          }
        }

        record['OurShopee Link'] = our.url || row.ourLink || '';
        await _randomDelay(_DELAY_BETWEEN_SITES);

        // Amazon: if link provided in input CSV, scrape directly first
        let amz = null;
        if (row.amazonLink && /^https?:\/\//i.test(row.amazonLink)) {
          try {
            await page.goto(row.amazonLink, { waitUntil: 'domcontentloaded', timeout: 35000 });
            await page.waitForTimeout(2000);
            const priceText = await page.locator('.a-price .a-offscreen, .a-price-whole, span.a-price > span.a-offscreen').first().textContent().catch(() => null);
            const title = await page.locator('#productTitle, h1').first().textContent().catch(() => null);
            const priceVal = _parsePrice(priceText);
            const asin = row.amazonLink.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || '';
            amz = {
              status: priceVal !== null && priceVal > 0 ? 'matched' : 'unverified',
              found: { price: priceVal, title: title?.trim() || '', url: row.amazonLink, id: asin },
              confidence: 'High',
              score: 0.98,
              priceFlag: 'Direct Link',
            };
          } catch (err) {
            notes.push(`amazon-direct-error:${err.message.slice(0, 30)}`);
          }
        }

        if (!amz || amz.status !== 'matched') {
          const searchAmz = await resolveSite({ page, hasher, site: _amazon, ours: our, label: 'amazon' });
          if (!amz || searchAmz.status === 'matched') amz = searchAmz;
        }

        if (amz.found?.url) record['Amazon Link'] = amz.found.url;
        if (amz.found?.id) record['Amazon ASIN'] = amz.found.id;
        
        if (amz.status === 'matched') {
          record['Amazon Price'] = amz.found.price ?? '';
          record['Amazon Link'] = amz.found.url || record['Amazon Link'] || row.amazonLink || '';
          record['Amazon ASIN'] = amz.found.id || record['Amazon ASIN'] || '';
          record['Amazon Matched Title'] = amz.found.title || '';
          record['Amazon Confidence'] = amz.confidence || 'High';
          record['Amazon Score'] = amz.score || 0.95;
          notes.push(`amazon:${record['Amazon Confidence']}`);
        } else if (amz.status === 'unverified') {
          record['Amazon Matched Title'] = `(UNVERIFIED) ${amz.found?.title || ''}`.slice(0, 200);
          record['Amazon Link'] = amz.found?.url || record['Amazon Link'] || row.amazonLink || '';
          record['Amazon ASIN'] = amz.found?.id || record['Amazon ASIN'] || '';
          if (amz.found?.price && amz.found.price > 0) record['Amazon Price'] = amz.found.price;
          record['Amazon Confidence'] = 'Low';
          record['Amazon Score'] = amz.score || 0.40;
          notes.push('amazon:unverified-check-manually');
        } else {
          record['Amazon Link'] = record['Amazon Link'] || row.amazonLink || '';
          record['Amazon Confidence'] = 'None';
          notes.push('amazon:not-found');
        }

        await _randomDelay(_DELAY_BETWEEN_SITES);

        // Noon: if link provided in input CSV, scrape directly first
        let no = null;
        if (row.noonLink && /^https?:\/\//i.test(row.noonLink)) {
          try {
            await page.goto(row.noonLink, { waitUntil: 'domcontentloaded', timeout: 35000 });
            await page.waitForTimeout(2000);
            const priceText = await page.locator('[data-qa="div-price-now"], .priceNow, [class*="priceNow"], [class*="sellingPrice"]').first().textContent().catch(() => null);
            const title = await page.locator('h1, [data-qa="product-name"]').first().textContent().catch(() => null);
            const priceVal = _parsePrice(priceText);
            const noonId = row.noonLink.match(/\/([A-Za-z0-9]{10,})\/p\//i)?.[1] || '';
            no = {
              status: priceVal !== null && priceVal > 0 ? 'matched' : 'unverified',
              found: { price: priceVal, title: title?.trim() || '', url: row.noonLink, id: noonId },
              confidence: 'High',
              score: 0.98,
              priceFlag: 'Direct Link',
            };
          } catch (err) {
            notes.push(`noon-direct-error:${err.message.slice(0, 30)}`);
          }
        }

        if (!no || no.status !== 'matched') {
          const searchNo = await resolveSite({ page, hasher, site: _noon, ours: our, label: 'noon' });
          if (!no || searchNo.status === 'matched') no = searchNo;
        }

        if (no.found?.url) record['Noon Link'] = no.found.url;
        if (no.found?.id) record['Noon Product ID'] = no.found.id;

        if (no.status === 'matched') {
          record['Noon Price'] = no.found.price ?? record['Noon Price'];
          record['Noon Link'] = no.found.url || record['Noon Link'] || row.noonLink || '';
          record['Noon Product ID'] = no.found.id || record['Noon Product ID'] || '';
          record['Noon Matched Title'] = no.found.title || '';
          record['Noon Confidence'] = no.confidence || 'High';
          record['Noon Score'] = no.score || 0.95;
          notes.push(`noon:${record['Noon Confidence']}`);
        } else if (no.status === 'unverified') {
          record['Noon Matched Title'] = `(UNVERIFIED) ${no.found?.title || ''}`.slice(0, 200);
          record['Noon Link'] = no.found?.url || record['Noon Link'] || row.noonLink || '';
          record['Noon Product ID'] = no.found?.id || record['Noon Product ID'] || '';
          if (no.found?.price && no.found.price > 0) record['Noon Price'] = no.found.price;
          record['Noon Confidence'] = 'Low';
          record['Noon Score'] = no.score || 0.40;
          notes.push('noon:unverified-dump-price-shown-not-used');
        } else {
          record['Noon Link'] = record['Noon Link'] || row.noonLink || '';
          record['Noon Confidence'] = 'None';
          notes.push('noon:not-found-dump-price-shown-not-used');
        }

        // Derived columns (Strictly ignoring 0 or invalid numbers)
        const ourPrice = _parsePrice(record['OurShopee Price']);
        const noonPrice = _parsePrice(record['Noon Price']);
        const amazonPrice = _parsePrice(record['Amazon Price']);
        const verifiedNoon = (no.status === 'matched' && noonPrice > 0) ? noonPrice : null;
        const verifiedAmazon = (amz.status === 'matched' && amazonPrice > 0) ? amazonPrice : null;
        const best = bestCompetitorPrice(ourPrice, verifiedNoon, verifiedAmazon);

        record['Best Competitor Price'] = (best === null || best <= 0) ? '' : best;
        const diff = priceDifference(ourPrice, best);
        record['Price Difference'] = diff === null ? '' : diff.toFixed(2);

        const flagParts = [];
        if (amz.status === 'matched' && amz.priceFlag) flagParts.push(`amazon:${amz.priceFlag}`);
        if (no.status === 'matched' && no.priceFlag) flagParts.push(`noon:${no.priceFlag}`);
        record['Price Flag'] = flagParts.join('; ');

        record.Status = notes.join('; ');

        addLog(`  ours=${fmt(ourPrice)} amz=${fmt(verifiedAmazon)}(${record['Amazon Confidence']}) noon=${fmt(verifiedNoon)}(${record['Noon Confidence']}) → best=${fmt(best)} diff=${record['Price Difference'] || '0'}`);
      } catch (error) {
        fatal = isFatalPageError(error);
        record.Status = `${fatal ? 'BROWSER CLOSED' : 'ERROR'}: ${error.message}`.slice(0, 120);
        addLog(`  ERROR: ${record.Status}`);
      }

      records.push(record);
      job.records = records;

      // Incremental write
      await _writeResult(outputPath, records, { exactOnly: options.exact || false });

      if (fatal) {
        addLog(`Browser closed — stopping early. ${records.length} rows saved.`);
        break;
      }

      if (i < selected.length - 1) await _randomDelay(_DELAY_BETWEEN_PRODUCTS);
    }

    job.progress.processed = records.length;
    job.progress.current = 'Done';
    job.status = 'done';
    job.records = records;
    job.finishedAt = new Date().toISOString();
    addLog(`Finished. ${records.length} rows written.`);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    addLog(`FATAL: ${err.message}`);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.unlink(inputPath, () => {});
  }
}

// ── Quick search (across Amazon.ae, Noon.com, and OurShopee.com) ─────────────
async function runSearch({ query, site = 'all', limit = 5 }) {
  loadScraperModules();

  const { browser, context, page } = await _launch({ headless: true });
  const results = {};

  const siteMap = {
    amazon: _amazon,
    noon: _noon,
    ourshopee: _ourshopee,
  };

  const sitesToSearch = site === 'all' ? Object.keys(siteMap) : [site];

  // Helper for cleaner search fallback query if original query has too many words
  const cleanQ = query.trim();
  const shortQ = cleanQ.split(' ').slice(0, 4).join(' ');

  try {
    for (const siteName of sitesToSearch) {
      const siteObj = siteMap[siteName];
      if (!siteObj) continue;
      try {
        let candidates = await siteObj.searchCandidates(page, cleanQ, limit);
        if ((!candidates || !candidates.length) && shortQ && shortQ !== cleanQ) {
          candidates = await siteObj.searchCandidates(page, shortQ, limit);
        }
        for (const c of (candidates || [])) {
          c.price = _parsePrice(c.priceRaw);
          if (c.price === 0) c.price = null;
        }
        results[siteName] = (candidates || []).slice(0, limit);
      } catch (err) {
        results[siteName] = { error: err.message };
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}

module.exports = { runJob, runSearch };
