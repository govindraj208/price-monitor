// Combines the four signals into a single ranked match decision.
// Signal priority follows the user's brief: string match first, then photos,
// then product details, then the +/- 5 price agreement as confirmation.

const { titleSimilarity, attributeSimilarity } = require('./text');
const { specConflicts } = require('./spec');
const { imageSimilarity } = require('./imageHash');
const { THRESHOLDS, WEIGHTS, MODEL_NUMBER_BONUS } = require('../config');

// Below this title similarity the listing is a different product no matter how
// close the price or image happens to be. Prevents "cheapest item on the page"
// style false positives.
const TITLE_FLOOR = 0.15;

// A conflicting spec - different storage, generation, model tier or condition -
// means a different sellable item, so the candidate is capped below
// minAcceptScore and can never supply a price. It stays above the title floor's
// 0.25 so the report still surfaces it as the closest thing that site had.
const SPEC_CONFLICT_CAP = 0.30;

// Price is only allowed to influence candidates whose text/image score is
// within this much of the strongest one. Otherwise a cheap but unrelated item
// can outscore the genuine match on price alone.
const PRICE_ELIGIBILITY_BAND = 0.12;

function priceScore(ourPrice, theirPrice) {
  if (ourPrice === null || theirPrice === null) return null;
  const diff = Math.abs(ourPrice - theirPrice);
  if (diff <= THRESHOLDS.priceExactWindow) return 1;
  return Math.max(0.05, 1 - (diff - THRESHOLDS.priceExactWindow) / Math.max(ourPrice, 1));
}

function priceFlag(ourPrice, theirPrice) {
  if (ourPrice === null || theirPrice === null) return 'No price';
  const diff = Math.abs(ourPrice - theirPrice);
  if (diff <= THRESHOLDS.priceExactWindow) return 'Within ±5';
  if (diff / Math.max(ourPrice, 1) <= THRESHOLDS.pricePercentWindow) return 'Within 15%';
  return 'Outside 15%';
}

function confidenceFor(score) {
  if (score >= THRESHOLDS.high) return 'High';
  if (score >= THRESHOLDS.medium) return 'Medium';
  return 'Low';
}

// ours:    { title, price, imageHash }
// candidate: { title, price, url, id, imageHash, source }
// options.usePrice: include the price signal (only for textually plausible candidates)
function scoreCandidate(ours, candidate, { usePrice = true } = {}) {
  const title = titleSimilarity(ours.title || '', candidate.title || '');
  const attributes = attributeSimilarity(ours.title || '', candidate.title || '');
  const spec = specConflicts(ours.title || '', candidate.title || '');
  const image = imageSimilarity(ours.imageHash || null, candidate.imageHash || null);
  const price = usePrice ? priceScore(ours.price ?? null, candidate.price ?? null) : null;

  // Re-weight when a signal is unavailable so a missing photo does not
  // permanently cap every score.
  const weights = { ...WEIGHTS };
  const missing = [];
  if (image === null) missing.push('image');
  if (price === null) missing.push(usePrice ? 'price' : 'price(excluded)');

  let score = weights.title * title + weights.attributes * attributes.score;
  let weightUsed = weights.title + weights.attributes;

  if (image !== null) { score += weights.image * image; weightUsed += weights.image; }
  if (price !== null) { score += weights.price * price; weightUsed += weights.price; }

  score = weightUsed > 0 ? score / weightUsed : 0;

  // A shared manufacturer part number settles it - and outranks a spec conflict,
  // since the same part number cannot belong to two different variants.
  if (attributes.sharedModel) {
    score = Math.min(1, score + MODEL_NUMBER_BONUS);
  } else if (spec.conflicts.length) {
    score = Math.min(score, SPEC_CONFLICT_CAP);
  }

  // Strict regional version matching (TDRA vs Middle East vs International, etc.)
  const ourVer = spec.ours.version;
  const theirVer = spec.theirs.version;
  const reasons = [...attributes.reasons];
  if (spec.conflicts.length) reasons.unshift(`SPEC CONFLICT: ${spec.conflicts.join(', ')}`);

  if (ourVer) {
    if (theirVer) {
      if (ourVer === theirVer) {
        score = Math.min(1, score + 0.15);
        reasons.push(`exact version match (${ourVer.replace(/_/g, ' ').toUpperCase()})`);
      } else {
        // Different version is already a hard spec conflict, capped at SPEC_CONFLICT_CAP (0.30)
        score = Math.min(score, SPEC_CONFLICT_CAP);
      }
    } else {
      // Target explicitly specified a version, but candidate title/data does not state it
      score = Math.min(score, 0.40);
      reasons.push(`unverified version (target requires ${ourVer.replace(/_/g, ' ').toUpperCase()})`);
    }
  }

  // Hard reject on text, then let the score speak.
  if (title < TITLE_FLOOR) score = Math.min(score, 0.25);

  return {
    score: Math.max(0, Math.min(1, score)),
    confidence: null, // set by pickBest once we know if this is the winner
    signals: {
      title: round(title),
      image: image === null ? null : round(image),
      attributes: round(attributes.score),
      price: price === null ? null : round(price),
    },
    reasons,
    specConflicts: spec.conflicts,
    sharedModel: attributes.sharedModel || null,
    priceFlag: priceFlag(ours.price ?? null, candidate.price ?? null),
    priceConsidered: price !== null,
    missingSignals: missing,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

// Listings whose photo has not loaded yet, or which are placeholders, must not
// be scored: they match on price alone and produce confident-looking false positives.
const JUNK_TITLES = /^(placeholder|image|n\/?a|loading|\.\.\.|undefined|null)$/i;

function isUsableTitle(title) {
  const t = String(title || '').trim();
  if (t.length < 8) return false;
  if (JUNK_TITLES.test(t)) return false;
  // A real product title contains at least two alphabetic words.
  return t.replace(/[^a-z\s]/gi, '').trim().split(/\s+/).filter(w => w.length > 1).length >= 2;
}

// Returns the best candidate plus the ranked list for manual review.
//
// Two passes, matching the user's stated priority of "string matched first,
// then the +/- 5 price check":
//   1. rank on text, details and photo alone;
//   2. let price break ties, but only among candidates that are already
//      textually plausible.
function pickBest(ours, candidates = []) {
  const usable = candidates.filter(c => c && isUsableTitle(c.title));
  if (!usable.length) return { best: null, ranked: [], accepted: false };

  const prelim = usable.map(c => ({ candidate: c, textScore: scoreCandidate(ours, c, { usePrice: false }).score }));
  const bestText = Math.max(...prelim.map(p => p.textScore));
  const cutoff = bestText - PRICE_ELIGIBILITY_BAND;

  const scored = prelim
    .map(({ candidate, textScore }) => {
      const priceEligible = textScore >= cutoff;
      const evaluation = scoreCandidate(ours, candidate, { usePrice: priceEligible });
      return { candidate, evaluation: { ...evaluation, confidence: confidenceFor(evaluation.score) } };
    })
    .sort((a, b) => b.evaluation.score - a.evaluation.score);

  const best = scored[0] || null;
  return {
    best,
    ranked: scored,
    // Only an accepted match may contribute a price to the report.
    accepted: Boolean(best && best.evaluation.score >= THRESHOLDS.minAcceptScore),
  };
}

function summarize(ranked, n = 3) {
  return ranked.slice(0, n).map((r, i) => {
    const price = r.candidate.price === null || r.candidate.price === undefined ? '?' : r.candidate.price;
    const veto = r.evaluation.specConflicts?.length ? ' [spec conflict]' : '';
    return `${i + 1}. ${String(r.candidate.title).slice(0, 55)} [${price}] ${Math.round(r.evaluation.score * 100)}%${veto}`;
  }).join(' | ');
}

module.exports = { scoreCandidate, pickBest, summarize, priceScore, priceFlag, confidenceFor, isUsableTitle, TITLE_FLOOR, SPEC_CONFLICT_CAP };
