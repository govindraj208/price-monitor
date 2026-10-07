#!/usr/bin/env node
// Diagnostic helper: show exactly what each site returns for one product name.
// Use this when results look wrong or a site changes its markup.
//
//   node src/diagnose.js "Corelle Ocean Blues 16 piece dinnerware set"
//   node src/diagnose.js PQ4053 --site noon
//   node src/diagnose.js "..." --site amazon --headless

const { launch } = require('./lib/browser');
const { ImageHasher } = require('./lib/imageHash');
const { parsePrice, extractAttributes } = require('./lib/text');
const { parseSpec, specConflicts, buildSpecQuery } = require('./lib/spec');
const { isAiEnabled, aiMatchCandidates, PRIMARY_MODEL } = require('./lib/aiMatch');
const ourshopee = require('./lib/sites/ourshopee');
const amazon = require('./lib/sites/amazon');
const noon = require('./lib/sites/noon');

const SITES = { ourshopee, amazon, noon };

const dash = v => (v === null || v === undefined || v === '' ? '-' : v);

function describeSpec(title) {
  const s = parseSpec(title);
  return `brand=${dash(s.brand)} model=${dash(s.model)} storage=${dash(s.storage)} ram=${dash(s.ram)}` +
    ` screen=${dash(s.screen)} pack=${dash(s.packSize)} tier=${dash(s.tiers.join('+'))} condition=${dash(s.condition)}` +
    ` colours=${dash(s.colors.join('/'))} partNo=${dash(s.models.join('/'))}`;
}

function parseArgs(argv) {
  const args = { query: null, site: null, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site') args.site = argv[++i];
    else if (a === '--headless') args.headless = true;
    else if (!a.startsWith('-') && args.query === null) args.query = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Usage: node src/diagnose.js "<product title or SKU>" [--site ourshopee|amazon|noon] [--headless]');
    process.exit(1);
  }

  const wanted = args.site ? [args.site] : Object.keys(SITES);
  const unknown = wanted.filter(w => !SITES[w]);
  if (unknown.length) {
    console.error(`Unknown site: ${unknown.join(', ')}. Choose from ${Object.keys(SITES).join(', ')}.`);
    process.exit(1);
  }

  const { browser, context, page } = await launch({ headless: args.headless });
  const hasher = new ImageHasher(context, page);

  console.log(`\nQuery     : ${args.query}`);
  console.log(`AI Status : ${isAiEnabled() ? `Gemini Free Tier Enabled (@google/genai, primary: ${PRIMARY_MODEL})` : 'Disabled (add GEMINI_API_KEY in .env)'}`);
  console.log(`Parsed    : ${describeSpec(args.query)}`);
  console.log(`Search as : ${buildSpecQuery(args.query) || '(full title - no model identity detected)'}`);
  console.log(`Fallback  : ${buildSpecQuery(args.query, { includeCondition: false, includeColour: false }) || '-'}`);

  for (const name of wanted) {
    console.log(`\n===== ${name.toUpperCase()} =====`);
    try {
      const candidates = await SITES[name].searchCandidates(page, args.query, 8);
      if (!candidates.length) {
        console.log('  no candidates returned');
        continue;
      }
      for (const [i, c] of candidates.entries()) {
        const hash = await hasher.hash(c.image);
        console.log(`\n  [${i + 1}] ${c.title}`);
        console.log(`      price : ${c.priceRaw ? `${c.priceRaw} -> ${parsePrice(c.priceRaw)}` : '(none)'}`);
        console.log(`      id    : ${c.id || '(none)'}`);
        console.log(`      url   : ${c.url || '(none)'}`);
        console.log(`      image : ${hash ? `hashed ${hash}` : 'FAILED TO LOAD'}`);
        if (c.rating) console.log(`      rating: ${c.rating}`);
        if (c.sponsored) console.log('      sponsored: yes');
        const attrs = extractAttributes(c.title);
        console.log(`      attrs : pack=${attrs.packSize} serviceFor=${attrs.serviceFor} capacity=${attrs.capacity} colours=${attrs.colors.join('/') || '-'} models=${attrs.models.join('/') || '-'}`);
        console.log(`      spec  : ${describeSpec(c.title)}`);
        const conflicts = specConflicts(args.query, c.title).conflicts;
        console.log(`      veto  : ${conflicts.length ? conflicts.join(', ') : 'none'}`);
      }

      if (isAiEnabled() && candidates.length > 0) {
        console.log(`\n  --- GEMINI FREE TIER EVALUATION (${name.toUpperCase()}) ---`);
        try {
          const aiDecision = await aiMatchCandidates({ title: args.query, price: null }, candidates.slice(0, 5));
          if (aiDecision) {
            if (aiDecision.matchedCandidateIndex >= 0) {
              console.log(`  AI Match    : Candidate [${aiDecision.matchedCandidateIndex + 1}] (${aiDecision.confidence} confidence)`);
              console.log(`  Title       : ${candidates[aiDecision.matchedCandidateIndex]?.title}`);
            } else {
              console.log(`  AI Match    : No match accepted (${aiDecision.confidence} confidence)`);
            }
            console.log(`  AI Reason   : ${aiDecision.reason}`);
            if (aiDecision.modelUsed) console.log(`  AI Model    : ${aiDecision.modelUsed}`);
          }
        } catch (err) {
          console.log(`  AI Error    : ${err.message}`);
        }
      }
    } catch (error) {
      console.log(`  ERROR${error.code ? ` (${error.code})` : ''}: ${error.message}`);
    }
  }

  await browser.close();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
