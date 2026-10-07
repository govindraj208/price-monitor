// Job runner — bridges the Express API to the existing scraper core.
//
// The scraper (src/index.js in the root project) was written as a CLI.
// This module re-uses its library functions directly so we don't fork the code.

const path = require('path');
const fs = require('fs');

// ── Resolve paths to the root scraper package ─────────────────────────────────
// Layout: price_monitor_2/
//           src/           ← original scraper
//           web/backend/   ← this API
const ROOT = path.resolve(__dirname, '../../../');  // price_monitor_2/
const SCRAPER_SRC = path.join(ROOT, 'src');

// Require from the parent package
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
      const values = [ourPrice, noonPrice, amazonPrice].filter(v => typeof v === 'number' && Number.isFinite(v));
      return values.length ? Math.min(...values) : null;
    }

    function priceDifference(ourPrice, best) {
      if (typeof ourPrice !== 'number' || typeof best !== 'number') return null;
      return Math.round((ourPrice - best) * 100) / 100;
    }

    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      job.progress.processed = i;
      job.progress.current = `[${i + 1}/${selected.length}] ${String(row.title).slice(0, 60)}`;
      addLog(job.progress.current);

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
        let our = {
          title: row.title,
          price: _parsePrice(row.ourPriceRaw),
          imageHash: null,
          url: row.ourLink || null,
          id: row.sku,
          barcode: row.barcode || null,
        };

        let osCandidates = [];
        try {
          osCandidates = await _ourshopee.findBySku(page, row.sku);
          if (!osCandidates.length) {
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
              our.url = chosen.url;
              our.id = chosen.id || our.id;
              if (chosen.title) our.title = chosen.title;
              const livePrice = chosen.price;
              if (livePrice !== null) {
                our.price = livePrice;
                record['OurShopee Price'] = livePrice;
              }
              our.imageHash = await hasher.hash(chosen.image);
            }
          }
        } else {
          notes.push('ourshopee not found');
        }

        record['OurShopee Link'] = our.url || '';
        await _randomDelay(_DELAY_BETWEEN_SITES);

        // Amazon
        const amz = await resolveSite({ page, hasher, site: _amazon, ours: our, label: 'amazon' });
        if (amz.status === 'matched') {
          record['Amazon Price'] = amz.found.price ?? '';
          record['Amazon Link'] = amz.found.url || '';
          record['Amazon ASIN'] = amz.found.id || '';
          record['Amazon Matched Title'] = amz.found.title || '';
          record['Amazon Confidence'] = amz.confidence;
          record['Amazon Score'] = amz.score;
          notes.push(`amazon:${amz.confidence}`);
        } else if (amz.status === 'unverified') {
          record['Amazon Matched Title'] = `(UNVERIFIED) ${amz.found?.title || ''}`.slice(0, 200);
          record['Amazon Confidence'] = 'Low';
          record['Amazon Score'] = amz.score;
          notes.push('amazon:unverified-check-manually');
        } else {
          record['Amazon Confidence'] = 'None';
          notes.push('amazon:not-found');
        }

        await _randomDelay(_DELAY_BETWEEN_SITES);

        // Noon
        const no = await resolveSite({ page, hasher, site: _noon, ours: our, label: 'noon' });
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
          notes.push('noon:unverified-dump-price-shown-not-used');
        } else {
          record['Noon Confidence'] = 'None';
          notes.push('noon:not-found-dump-price-shown-not-used');
        }

        // Derived columns
        const ourPrice = _parsePrice(record['OurShopee Price']);
        const noonPrice = _parsePrice(record['Noon Price']);
        const amazonPrice = _parsePrice(record['Amazon Price']);
        const verifiedNoon = no.status === 'matched' ? noonPrice : null;
        const verifiedAmazon = amz.status === 'matched' ? amazonPrice : null;
        const best = bestCompetitorPrice(ourPrice, verifiedNoon, verifiedAmazon);

        record['Best Competitor Price'] = best === null ? '' : best;
        const diff = priceDifference(ourPrice, best);
        record['Price Difference'] = diff === null ? '' : diff.toFixed(2);

        const flagParts = [];
        if (amz.status === 'matched') flagParts.push(`amazon:${amz.priceFlag}`);
        if (no.status === 'matched') flagParts.push(`noon:${no.priceFlag}`);
        record['Price Flag'] = flagParts.join('; ');

        record.Status = notes.join('; ');

        addLog(`  ours=${fmt(ourPrice)} amz=${fmt(verifiedAmazon)}(${record['Amazon Confidence']}) noon=${fmt(verifiedNoon)}(${record['Noon Confidence']}) → best=${fmt(best)}`);
      } catch (error) {
        fatal = isFatalPageError(error);
        record.Status = `${fatal ? 'BROWSER CLOSED' : 'ERROR'}: ${error.message}`.slice(0, 120);
        addLog(`  ERROR: ${record.Status}`);
      }

      records.push(record);

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
    // Clean up uploaded input file
    fs.unlink(inputPath, () => {});
  }
}

// ── Quick search (diagnose-mode) ──────────────────────────────────────────────
async function runSearch({ query, site = 'all', limit = 5 }) {
  loadScraperModules();

  const { browser, context, page } = await _launch({ headless: true });
  const hasher = new _ImageHasher(context, page);
  const results = {};

  const siteMap = {
    amazon: _amazon,
    noon: _noon,
    ourshopee: _ourshopee,
  };

  const sitesToSearch = site === 'all' ? Object.keys(siteMap) : [site];

  try {
    for (const siteName of sitesToSearch) {
      const siteObj = siteMap[siteName];
      if (!siteObj) continue;
      try {
        const candidates = await siteObj.searchCandidates(page, query, limit);
        for (const c of candidates) c.price = _parsePrice(c.priceRaw);
        results[siteName] = candidates.slice(0, limit);
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
