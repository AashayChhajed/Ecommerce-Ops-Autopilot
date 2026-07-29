/**
 * Gemini API Client — Google Gemini text generation
 *
 * Environment variables:
 *   GEMINI_API_KEY      (required)  Your Google Gemini API key
 *   GEMINI_MODEL_NAME   (optional)  Preferred free-tier model (default: gemini-3.5-flash)
 *   GEMINI_API_VERSION  (optional)  API version (default: v1beta)
 *
 * ═══════════════════════════════════════════════════════
 *  FREE-TIER ONLY — Automatic model fallback
 * ═══════════════════════════════════════════════════════
 *
 * Google deprecates model versions frequently. Instead of breaking when a model
 * is sunset, this client tries a prioritized list of known free-tier Flash models
 * in sequence. If the preferred model returns 404, it falls through to the next.
 * You never get charged because every model in the fallback list is a Flash/Lite
 * variant — all confirmed on the Google AI Studio free tier.
 *
 * To see what's currently available manually:
 *   curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$KEY" \
 *     | jq '[.models[].name | select(contains("flash"))]'
 */

// ── User preference (tried first) ───────────────────
const USER_MODEL = process.env.GEMINI_MODEL_NAME;
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';

// ── Free-tier Flash models, newest first ─────────────
// These are all Flash / Flash-Lite variants, guaranteed on the free tier.
// When Google deprecates one, the next in the list is tried automatically.
const FREE_MODEL_FALLBACKS = [
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
];

// Models to try, in order:
// 1. User's explicit preference (if set)
// 2. FREE_MODEL_FALLBACKS in order
const MODELS_TO_TRY = USER_MODEL
  ? [USER_MODEL, ...FREE_MODEL_FALLBACKS.filter((m) => m !== USER_MODEL)]
  : FREE_MODEL_FALLBACKS;

// Cache the last working model so we don't retry failed ones every request
let workingModel = null;

// Track which models we've already seen fail to skip them fast
const failedModels = new Set();

/**
 * Build an e-commerce product description prompt.
 *
 * @param {object} product  - Product row from DB (title, vendor, inventory, price, description, etc.)
 * @param {object} options
 * @param {string} [options.tone] - Optional tone: "professional" | "friendly" | "playful" | "expert"
 * @returns {string} The formatted prompt text
 */
export function buildDescriptionPrompt(product, { tone } = {}) {
  const toneMap = {
    professional:
      'Tone: Professional, engaging, and benefit-focused. Use confident, polished language that builds trust with discerning shoppers.',
    friendly:
      'Tone: Warm, approachable, and conversational. Write as if you are personally recommending this product to a friend.',
    playful:
      'Tone: Energetic, fun, and witty. Use lighthearted language that creates excitement and joy around the product.',
    expert:
      'Tone: Authoritative, technical, and detail-oriented. Emphasize specifications, craftsmanship, and industry expertise.',
  };

  const toneInstruction =
    toneMap[tone] ||
    'Tone: Professional, engaging, and benefit-focused.';

  const details = [
    `Product Title: ${product.title}`,
    `Vendor/Category: ${product.vendor || 'General'}`,
    `Price: $${Number(product.price || 0).toFixed(2)}`,
    `Stock Level: ${product.inventory ?? 'Unknown'}`,
  ];

  if (product.description) {
    details.push(`Original Description: ${product.description.slice(0, 300)}`);
  }

  return `You are an expert e-commerce copywriter for high-converting online stores. Generate a compelling product description.

${details.join('\n')}

Requirements:
- Target Word Count: 120-150 words
- ${toneInstruction}
- Format: Opening hook paragraph, then 3-4 bullet points of key features/benefits, then a strong call-to-action
- Output: PLAIN TEXT ONLY, no markdown headers, no HTML tags, no asterisks`;
}

/**
 * Call the Gemini API to generate text, with automatic fallback if the model
 * is deprecated. Tries each model in the priority list until one succeeds.
 *
 * @param {string} prompt  - The prompt to send
 * @returns {Promise<string>} The generated text
 * @throws {Error} If no API key is configured, or ALL models in the fallback list fail
 */
export async function generateWithGemini(prompt) {
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey || geminiKey.startsWith('placeholder')) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  // If we already found a working model, try it first
  const candidates = workingModel
    ? [workingModel, ...MODELS_TO_TRY.filter((m) => m !== workingModel)]
    : MODELS_TO_TRY;

  let lastError = null;

  for (const model of candidates) {
    // Skip models we already know fail
    if (failedModels.has(model)) continue;

    const url = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${geminiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.7,
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        const finishReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
        throw new Error(`Gemini returned no text (finishReason: ${finishReason})`);
      }

      // Cache this model so we skip dead ones next time
      if (workingModel !== model) {
        workingModel = model;
        console.log(`[Gemini] Using model: ${model}`);
      }
      return text.trim();
    }

    // Model returned an error — if it's a 404 (deprecated), mark it and continue
    if (response.status === 404) {
      failedModels.add(model);
      lastError = new Error(`Model "${model}" is not available`);
      console.warn(`[Gemini] Model "${model}" unavailable, trying next fallback...`);
      continue;
    }

    // Non-404 error (auth, rate limit, etc.) — throw immediately
    const errBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error (${response.status}): ${errBody}`);
  }

  // All models failed
  const usedModels = MODELS_TO_TRY.join(', ');
  throw new Error(
    `All Gemini free-tier models failed. Tried: ${usedModels}. ` +
    `Last error: ${lastError?.message || 'Unknown'}. ` +
    `Run this to see available models:\n` +
    `  curl -s "https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models?key=${geminiKey.slice(0, 8)}..." | jq '.models[].name'`
  );
}

/**
 * Reset the model cache (useful for testing or after updating env vars).
 */
export function resetModelCache() {
  workingModel = null;
  failedModels.clear();
}
