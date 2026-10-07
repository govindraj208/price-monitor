# OurShopee Price Monitor

Compares every product in your daily catalogue dump against **Amazon.ae** and **Noon.com**, then produces a priced comparison sheet.

You give it product names. It finds each product on all three sites, verifies it is genuinely the same item, and fills in the prices and links.

---

## What it does

For each row in your dump it:

1. **Finds your product on OurShopee** (by SKU first, then by title) → gets the verified product URL, live price and reference photo.
2. **Searches Amazon.ae and Noon** using that product name.
3. **Scores every candidate** it finds against your product using four signals (see *How matching works*).
4. **Accepts or rejects** the best candidate. Rejected matches never contribute a price.
5. **Writes the Result CSV** in your template's exact column order.

---

## Setup (one time)

Requires **Node.js 18 or newer**.

```bash
npm install
npx playwright install chromium
```

---

## Daily use

**1.** Export your dump from Google Sheets and save it into the `input/` folder. Any `.csv` filename works — the tool automatically picks the **newest** one.

**2.** Run:

```bash
npm start
```

**3.** Collect your file from `results/Result_<timestamp>.csv`.

That's it. A browser window opens so you can watch it work; results are saved **after every product**, so stopping it part-way still leaves you a usable file.

### Options

| Command | Effect |
|---|---|
| `npm start` | All products, visible browser |
| `npm run headless` | All products, no browser window (unattended) |
| `node src/index.js --limit 5` | First 5 products only — good for a test run |
| `node src/index.js --sku PQ4055,PQ4072` | Re-run specific SKUs only |
| `node src/index.js --verbose` | Show every candidate considered and its score |
| `node src/index.js --input path/to/file.csv` | Use a specific file instead of the newest |
| `node src/index.js --exact` | Output only the 11 template columns, no audit columns |
| `npm test` | Verify the matching logic (no browser, no network) |

### Diagnosing a single product

When a result looks wrong, inspect exactly what each site returned:

```bash
node src/diagnose.js "Corelle Ocean Blues 16 piece dinnerware set"
node src/diagnose.js PQ4053 --site noon        # one site only
```

It prints the spec parsed out of your query and the search string that will actually be sent, then every candidate with its title, price, product ID, URL, whether the photo loaded and hashed, the attributes and spec extracted from the title, and whether the candidate was vetoed — so you can see why the matcher chose what it did.

---

## Input format ("Dump")

Minimum required columns — extra columns are ignored, and header spelling/casing is matched loosely:

```
Section,SKU,Product Title,OurShopee Price,Noon Price
```

`Product Title` is the only truly essential column. `SKU` makes the OurShopee lookup much more reliable. `OurShopee Price` is refreshed from the live listing (a change is noted in `Status`), and `Noon Price` is used as a reference value when Noon cannot be matched.

## Output format ("Result")

The first eleven columns are your template, in your exact order:

```
Section,SKU,Product Title,OurShopee Price,Noon Price,Amazon Price,
Best Competitor Price,Price Difference,OurShopee Link,Noon Link,Amazon Link
```

- **Best Competitor Price** = the lowest of *your* price, Noon and Amazon. It equals your own price when you are already the cheapest.
- **Price Difference** = `OurShopee Price − Best Competitor Price`. Positive means the market is cheaper than you by that amount; `0.00` means you are the cheapest.

Only prices **verified during this run** feed those two columns. If Noon could not be matched, your dump's `Noon Price` is still shown in its own column for reference, but it is excluded from `Best Competitor Price` — it is yesterday's number, and letting it drive `Price Difference` would produce a repricing signal nobody actually checked today. `Status` records `dump-price-shown-not-used` when this happens.

After those, audit columns are appended so you can check the tool's reasoning (suppress with `--exact`):

| Column | Meaning |
|---|---|
| `Amazon ASIN` / `Noon Product ID` | The marketplace's own product identifier |
| `Amazon Matched Title` / `Noon Matched Title` | The listing it settled on |
| `Amazon Confidence` / `Noon Confidence` | High / Medium / Low / None |
| `Amazon Score` / `Noon Score` | Raw match score, 0–1 |
| `Price Flag` | `Within ±5`, `Within 15%` or `Outside 15%`, per site |
| `Status` | What happened, e.g. `amazon:High; noon:not-found-dump-price-shown-not-used` |

A `Status` beginning **`REVIEW:`** means the price driving your `Price Difference` came from a match that is *not* High confidence *and* sits outside the price window. These are the rows to look at before changing a price — a related-but-different product from the same brand (a "floor cleaning kit" matched against a "spray mop kit") can look convincing on photo alone while being far cheaper. Filter the column for `REVIEW:` to get a daily check-list.

---

## How matching works

Finding the *same* product across three sites is the hard part — listings use different wording, pack sizes and variants. Rather than taking the first search result, every candidate is scored on four signals, in the priority order you specified:

| Signal | Weight | What it checks |
|---|---|---|
| **Title text** | 40% | Word overlap, word containment, and character-bigram similarity (tolerant of reordering and typos) |
| **Product photo** | 25% | Perceptual hash (dHash) of each listing's image vs. your OurShopee photo |
| **Product details** | 20% | Part numbers, pack size, "service for N", capacity, colour |
| **Price agreement** | 15% | How close the competitor price is to your OurShopee price, with your ±5 AED rule as the top band |

Two special rules override the weighted sum:

- **A shared part number** (e.g. `1130931` appearing in both titles) is treated as near-conclusive and heavily boosts the score.
- **A price match alone never wins.** If the titles barely overlap, the candidate is capped at a low score no matter how close the price is. This stops an unrelated cheap item from being mistaken for yours.

### Spec veto — the wrong *version* of the right product

Text similarity cannot tell `iPhone 12 Pro Max 256GB` from `iPhone 14 Pro Max 256GB`: one digit apart, the two titles score ~0.8, and because the photos are near-identical and the prices close, the pair used to be reported as **High** confidence. That is the most dangerous kind of error, since it looks trustworthy.

So every title is also parsed into its parts — **brand → model → configuration → condition** — and those parts are compared as facts rather than as text:

| Part | Examples read from the title |
|---|---|
| Brand | `Apple`, `Samsung`, `Corelle` |
| Model | `iphone 12 pro max`, `macbook air m5`, `galaxy s26 ultra` |
| Configuration | storage `256GB`, RAM `16GB`, screen `15.3 inch`, pack `11 pcs`, capacity `5.5L`, part number `4116481` |
| Condition | `renewed` / `refurbished` (same thing), `used`, `open box`, `new` / `sealed` |

If **both** titles state one of these and the values differ, the candidate is **vetoed** — capped at 0.30, below the 0.50 acceptance bar, so it can never supply a price. The `Status` column says why:

```
noon:rejected(generation 12 vs 14)-dump-price-shown-not-used
amazon:rejected(storage 128GB vs 256GB)
```

A spec that only one side mentions is never a conflict — marketplace listings omit details constantly, and a false rejection is worse than a weak score. Colour is deliberately *not* a veto: it stays a soft signal, because sites name the same finish differently ("brown" vs "amber") and the photo is the better judge.

The same parsing builds the search query, in the order above, so filler words stop diluting it:

```
Apple iPhone 12 Pro Max With Facetime 256GB 5G Graphite Renewed
  → searched as: apple iphone 12 pro max 256gb graphite renewed
  → fallback:    apple iphone 12 pro max 256gb
```

Titles with no model identity (dinnerware, cookware) keep the full title as their query — for those, the descriptive words *are* the identity.

### The acceptance gate

A match scoring below **0.50** is **not trusted**:

- Its price is **left blank** rather than written into the sheet.
- Its link is **left blank**.
- The candidate is still recorded in `Matched Title`, prefixed `(UNVERIFIED)`, so you can look it up yourself.
- `Confidence` is set to `Low` and `Status` notes it needs a manual check.

This matters because of how `Best Competitor Price` is calculated. One wrongly-matched cheap product would make it look as though you are massively undercut, which is exactly the kind of error that causes a bad repricing decision. An honest blank is safer than a confident wrong number.

### Reading the confidence column

| Confidence | Meaning | Action |
|---|---|---|
| **High** | Text, photo and details agree | Trust it |
| **Medium** | Probably right, one signal weak | Spot-check |
| **Low** / `(UNVERIFIED)` | Not trusted, price withheld | Check manually |
| **None** | Nothing suitable found on that site | Add the link to your dump by hand |

---

## Troubleshooting

**A site returns a bot challenge / captcha.** Run in visible mode (`npm start`) and solve it in the window that opens; the run continues. Headless mode is challenged far more often — prefer visible mode for accuracy.

**Everything comes back `None`.** Check your internet connection and that `npx playwright install chromium` has been run. Amazon and Noon occasionally change their markup; if one site breaks while the other works, its selectors in `src/lib/sites/` need updating.

**Prices look wrong.** Look at `Price Flag` and `Matched Title` first. If `Matched Title` is a different product, the match was wrong — the row will normally have been left blank by the acceptance gate.

**It matched the wrong size / generation / colour variant.** Check `Status` for `rejected(...)`, which names the spec that disagreed. If the veto fired on a pair you believe *is* the same product, one side has been parsed wrongly — run `node src/diagnose.js "<title>"` and read the `spec` and `veto` lines to see exactly what was extracted.

**OurShopee price or link came back blank with `ourshopee found <SKU> not <SKU>`.** The SKU search failed and a title search landed on a sibling variant. Rather than write another product's price and link into this row, the tool keeps your dump's values and tells you which SKU it found instead. Add the correct `OurShopee Link` to your dump for that row.

**Noon shows unrelated products.** Noon paints "recommended" items before the real search results load. The tool waits for the grid to settle, but on a slow connection you can raise `TIMEOUTS.settle` in `src/config.js`.

---

## Tuning

Every threshold lives in `src/config.js`:

```js
THRESHOLDS.high          // 0.72  score needed for "High" confidence
THRESHOLDS.medium        // 0.50  score needed for "Medium"
THRESHOLDS.minAcceptScore// 0.50  below this, no price is written
THRESHOLDS.priceExactWindow // 5  the ±5 AED rule
THRESHOLDS.pricePercentWindow // 0.15
WEIGHTS                  // how much each of the four signals counts
```

If you are getting too many `Low` results, lower `minAcceptScore` gradually — but review the `(UNVERIFIED)` rows before trusting them.

---

## Gemini Free Tier AI Module

The tool includes an AI matching layer powered by the official `@google/genai` module:

- **Free Tier Safe**: Automatically enforces the 15 RPM limit (~4.2s interval) and handles 429 quota backoffs to avoid exhausting free limits.
- **Model Fallback**: Uses `gemini-3.8-flash` by default, with automatic fallback to `gemini-3.5-flash-lite` or `gemini-3.5-flash` if temporary demand spikes (503) occur.
- **Precision Validation**: Checks brand, model numbers, variants, quantities, pack counts, and accessories against strict e-commerce rules.
- **Visible Feedback**: Outputs real-time matching decisions directly in the console (`[Gemini AI] amazon: High match -> ...`).
- **Diagnostic Mode**: Test AI decisions interactively for any product via `node src/diagnose.js "<product>"`.

To enable:
Add your free Google AI Studio key to `.env`:
```bash
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.8-flash
```

---

## Project layout

```
price-monitor/
├── input/            ← drop your daily dump CSV here
├── results/          ← Result CSVs appear here
├── test/
│   └── match.test.js   matching-logic tests (npm test)
└── src/
    ├── index.js        entry point / CLI
    ├── diagnose.js     inspect what one product returns from each site
    ├── config.js       all tunable numbers and thresholds
    └── lib/
        ├── browser.js    launch, cookie walls, bot detection, retry
        ├── csv.js        read the dump, write the Result
        ├── imageHash.js  perceptual photo hashing
        ├── match.js      combines the four signals, decides acceptance
        ├── spec.js       brand/model/configuration/condition parsing + veto
        ├── text.js       title similarity, attribute extraction, price parsing
        └── sites/
            ├── ourshopee.js
            ├── amazon.js
            └── noon.js
```

Legacy scripts from earlier iterations (`src/main.js`, `src/auto-main.js`, `src/smart-main.js`) are still present but unused — `src/index.js` is the tool.
