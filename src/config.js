// Central place for every tunable number and selector in the tool.
// Adjust thresholds here rather than digging through the site scrapers.

const THRESHOLDS = {
  // Combined score needed for each confidence band
  high: 0.72,
  medium: 0.50,

  // A match scoring below this is reported for manual review but is NOT used to
  // fill in a price. Writing an unverified price would corrupt
  // "Best Competitor Price" and could trigger a bad repricing decision.
  minAcceptScore: 0.50,

  // Price agreement with the OurShopee price.
  // The user's rule: a competitor price within +/- 5 AED strongly indicates the same product.
  priceExactWindow: 5,
  // Beyond that window, tolerance scales with the product price.
  pricePercentWindow: 0.15,

  // How many search results to evaluate per site
  candidatesPerSite: 10,

  // How many pre-ranked candidates to download photos for
  imageFinalists: 5,
};

// How much each signal contributes to the combined score.
// Order reflects the user's stated priority: text first, then image, then details, then price.
const WEIGHTS = {
  title: 0.40,
  image: 0.25,
  attributes: 0.20,
  price: 0.15,
};

// A matching manufacturer part number is near-conclusive on its own.
const MODEL_NUMBER_BONUS = 0.35;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
};

const TIMEOUTS = {
  navigation: 35000,
  settle: 6000,
  retryDelay: 3000,
};

// Politeness: random pause between products to reduce bot detection.
const DELAY_BETWEEN_PRODUCTS = [4000, 8000];
const DELAY_BETWEEN_SITES = [2500, 5000];

module.exports = {
  THRESHOLDS,
  WEIGHTS,
  MODEL_NUMBER_BONUS,
  HEADERS,
  TIMEOUTS,
  DELAY_BETWEEN_PRODUCTS,
  DELAY_BETWEEN_SITES,
};
