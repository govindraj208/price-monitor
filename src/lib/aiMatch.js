// Google Gemini Free Tier AI Product Matcher using official @google/genai SDK
// Optimized for Gemini Free Tier limits:
// - 15 RPM (enforces >= 4.2s delay between calls)
// - 1,500 RPD
// - Robust handling for 429 (rate limit / quota) and 503 (demand spike fallback)

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Modern free-tier supported models with automatic fallback
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash'];

const MIN_CALL_INTERVAL_MS = 4200; // 4.2 seconds = ~14.2 RPM (well under 15 RPM limit)

let lastCallTimestamp = 0;
let aiClient = null;

function isAiEnabled() {
  return Boolean(GEMINI_API_KEY && GEMINI_API_KEY.length > 10);
}

function getAiClient() {
  if (!aiClient && isAiEnabled()) {
    aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return aiClient;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - lastCallTimestamp;
  if (elapsed < MIN_CALL_INTERVAL_MS) {
    const waitMs = MIN_CALL_INTERVAL_MS - elapsed;
    await sleep(waitMs);
  }
  lastCallTimestamp = Date.now();
}

const SYSTEM_INSTRUCTION = `You are a precision e-commerce product matching expert for UAE marketplaces (Amazon.ae, Noon.com, OurShopee.com).
Your job is to determine whether any candidate product is the EXACT identical product as our target product.

RULES FOR EXACT MATCH:
1. Brand MUST match (ignore minor typos, casing, or brand prefixes).
2. Core Model and Series MUST match (e.g. "iPhone 18 Pro Max" is NOT "iPhone 18 Pro", "ES5460" is NOT "ES5061").
3. Storage, RAM, Size, Pack Count, or Volume MUST match (e.g. 512GB is NOT 256GB; 11-piece is NOT 6-piece; 50ml is NOT 30ml; 1-pack is NOT 2-pack).
4. IPHONE & SMARTPHONE REGIONAL VERSION MATCHING:
   - Candidates on Noon often list regional versions: "TDRA Version", "Middle East Version", "International Version".
   - When our target specifies a version (e.g. "TDRA Version", "Middle East Version", "International Version"):
     a) TOP PRIORITY (EXACT MATCH): If any candidate has the EXACT same regional version as our target, you MUST select that candidate!
     b) COMPATIBLE LOCAL MATCH: If the exact version is not present, "TDRA Version" and "Middle East Version" are compatible local UAE market models.
     c) IMPORT VARIANT: If only "International Version" is available, select it with "Medium" confidence provided brand, model, and storage match.
     d) ALWAYS choose the candidate with the closest version match to our target!
5. Title Truncation: Online marketplace sellers often abbreviate titles (e.g. "11pc" instead of "11 Pcs", "6-Piece" instead of "6 Pack", omitting secondary display tech like "6.9-inch Super Retina"). If brand, series, and key variant match, it IS an exact match!
6. Color difference: If a candidate has identical specs and brand but differs only in color or packaging, return "Medium" match.
7. Accessories & Covers: Do NOT match cases, screen protectors, cables, or replacement parts when our product is the main item.
8. If an exact match is found, return its index (0-based) and confidence "High".
9. If a candidate is the same product variant with slight packaging/color variation or compatible version, return index and confidence "Medium".
10. If all candidates are fundamentally different products (wrong model, wrong storage, accessory only), return matchedCandidateIndex: -1 and confidence: "None".

You MUST reply with ONLY a valid JSON object in this exact schema:
{
  "matchedCandidateIndex": <number, 0-based index or -1 if no exact match>,
  "confidence": "High" | "Medium" | "None",
  "reason": "<short 1-sentence explanation of why it matched or why all were rejected>"
}`;

/**
 * Evaluates candidate products against the target product using Gemini AI.
 * @param {Object} ours - { title, price, id }
 * @param {Array} candidates - Array of candidate objects [{ title, price, url, id }]
 * @returns {Promise<{ matchedCandidateIndex: number, confidence: string, reason: string, modelUsed: string } | null>}
 */
async function aiMatchCandidates(ours, candidates) {
  if (!isAiEnabled() || !candidates || candidates.length === 0) {
    return null;
  }

  const ai = getAiClient();
  if (!ai) return null;

  await enforceRateLimit();

  const candidateList = candidates.map((c, i) => ({
    index: i,
    title: c.title,
    price: c.price ?? c.priceRaw,
  }));

  const userPrompt = `Target Product:
Title: "${ours.title}"
Price: ${ours.price !== null ? `${ours.price} AED` : 'Unknown'}

Candidate Listings:
${JSON.stringify(candidateList, null, 2)}

Which candidate is the exact same product?`;

  const modelQueue = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter(m => m !== PRIMARY_MODEL)];

  for (const model of modelQueue) {
    let maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        });

        const rawText = response.text;
        if (!rawText) continue;

        const cleaned = rawText.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
        const result = JSON.parse(cleaned);

        if (typeof result.matchedCandidateIndex === 'number') {
          return {
            matchedCandidateIndex: result.matchedCandidateIndex,
            confidence: result.confidence || (result.matchedCandidateIndex >= 0 ? 'High' : 'None'),
            reason: result.reason || '',
            modelUsed: model,
          };
        }
      } catch (err) {
        const status = err.status || err.statusCode || (err.message?.includes('429') ? 429 : (err.message?.includes('503') ? 503 : 0));

        if (status === 429) {
          if (attempt === 1 && modelQueue.indexOf(model) < modelQueue.length - 1) {
            console.log(`    [Gemini Free Tier] Rate limit (429) on ${model}. Switching to alternative model...`);
            break; // break retry loop to try next model in modelQueue immediately
          }
          console.log(`    [Gemini Free Tier] Rate limit (429) hit on ${model}. Waiting 4s before retry (${attempt}/${maxRetries})...`);
          await sleep(4000);
          continue;
        }

        if (status === 503) {
          console.log(`    [Gemini Free Tier] High demand on ${model} (503). Trying fallback model...`);
          break; // break retry loop to try next model in modelQueue
        }

        if (status === 404) {
          console.log(`    [Gemini Free Tier] Model ${model} not found (404). Trying fallback model...`);
          break;
        }

        console.log(`    [Gemini Free Tier] Error calling ${model}: ${err.message?.slice(0, 120)}`);
        if (attempt < maxRetries) await sleep(2000);
      }
    }
  }

  return null;
}

module.exports = {
  isAiEnabled,
  aiMatchCandidates,
  enforceRateLimit,
  PRIMARY_MODEL,
};
