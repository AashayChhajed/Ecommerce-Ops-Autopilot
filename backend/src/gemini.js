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

// Cooldown shared across requests in this process to avoid hammering free-tier limits.
let nextAllowedRequestAt = 0;
let requestGate = Promise.resolve();
let lastRequestStartedAt = 0;

const MIN_REQUEST_INTERVAL_MS = Number(process.env.GEMINI_MIN_REQUEST_INTERVAL_MS ?? 15000);
const GEMINI_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS ?? 45000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRateLimitError(message, retryAfterMs) {
  const error = new Error(message);
  error.code = 'GEMINI_RATE_LIMITED';
  error.retryAfterMs = retryAfterMs;
  return error;
}

async function acquireGeminiSlot() {
  const current = requestGate;
  let release;
  requestGate = new Promise((resolve) => {
    release = resolve;
  });

  await current;

  const waitMs = Math.max(0, (lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS) - Date.now());
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  lastRequestStartedAt = Date.now();
  release();
}

function parseRetryDelayMs(bodyText) {
  if (!bodyText) return null;

  try {
    const data = JSON.parse(bodyText);
    const retryDelay = data?.error?.details?.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
    if (!retryDelay) return null;

    const match = String(retryDelay).match(/^(\d+(?:\.\d+)?)(ms|s)$/i);
    if (!match) return null;

    const value = Number(match[1]);
    return match[2].toLowerCase() === 's' ? Math.round(value * 1000) : Math.round(value);
  } catch {
    return null;
  }
}

/**
 * Build an e-commerce product description prompt.
 *
 * @param {object} product  - Product row from DB (title, vendor, inventory, price, description, etc.)
 * @param {object} [options]
 * @param {object} [options.brandVoice] - Brand voice settings from description_settings table
 * @param {string} [options.brandVoice.tone] - "professional" | "friendly" | "playful" | "expert"
 * @param {string} [options.brandVoice.language] - Language (e.g., "English")
 * @param {string} [options.brandVoice.brand_phrases] - Key brand phrases or keywords
 * @param {string} [options.brandVoice.style_notes] - Additional style instructions
 * @param {string} [options.tone] - Override tone (takes precedence over brandVoice.tone)
 * @returns {string} The formatted prompt text
 */
export function buildDescriptionPrompt(product, { tone, brandVoice } = {}) {
  // Determine tone — explicit override wins, then brandVoice, then default
  const activeTone = tone || brandVoice?.tone || 'professional';

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

  const toneInstruction = toneMap[activeTone] || toneMap.professional;

  const details = [
    `Product Title: ${product.title}`,
    `Vendor/Category: ${product.vendor || 'General'}`,
    `Price: $${Number(product.price || 0).toFixed(2)}`,
    `Stock Level: ${product.inventory ?? 'Unknown'}`,
  ];

  if (product.description) {
    details.push(`Original Description: ${product.description.slice(0, 300)}`);
  }

  // Build brand voice section
  const brandVoiceParts = [];
  if (brandVoice?.language && brandVoice.language !== 'English') {
    brandVoiceParts.push(`- Language: Write in **${brandVoice.language}**`);
  }
  if (brandVoice?.brand_phrases?.trim()) {
    brandVoiceParts.push(`- Brand Keywords: Naturally incorporate these phrases when relevant: "${brandVoice.brand_phrases.trim()}"`);
  }
  if (brandVoice?.style_notes?.trim()) {
    brandVoiceParts.push(`- Style Notes: ${brandVoice.style_notes.trim()}`);
  }

  const brandVoiceBlock = brandVoiceParts.length > 0
    ? `\nBrand Voice:\n${brandVoiceParts.join('\n')}`
    : '';

  return `You are an expert e-commerce copywriter for high-converting online stores. Generate a compelling product description.${brandVoiceBlock}

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

  const cooldownMs = Math.max(0, nextAllowedRequestAt - Date.now());
  if (cooldownMs > 0) {
    throw makeRateLimitError(`Gemini rate limited; wait ${Math.ceil(cooldownMs / 1000)}s before retrying`, cooldownMs);
  }

  for (const model of candidates) {
    // Skip models we already know fail
    if (failedModels.has(model)) continue;

    const url = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${geminiKey}`;

    await acquireGeminiSlot();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Gemini request timed out after ${GEMINI_REQUEST_TIMEOUT_MS}ms`)),
      GEMINI_REQUEST_TIMEOUT_MS
    );

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 512,
            temperature: 0.7,
          },
        }),
      });
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        throw new Error(`Gemini request timed out after ${GEMINI_REQUEST_TIMEOUT_MS}ms while calling ${model}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

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

    const errBody = await response.text().catch(() => '');

    if (response.status === 429) {
      lastError = new Error(`Gemini API rate limited (${model})`);
      const retryDelayMs = parseRetryDelayMs(errBody);
      const waitMs = Math.max(retryDelayMs ?? MIN_REQUEST_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS);
      nextAllowedRequestAt = Date.now() + waitMs;

      console.warn(`[Gemini] Rate limited on ${model}; cooling down for ${Math.round(waitMs / 1000)}s`);
      throw makeRateLimitError(`Gemini rate limited on ${model}; retry after ${Math.ceil(waitMs / 1000)}s`, waitMs);
    }

    // Non-404 error (auth, rate limit after retries, etc.) — throw immediately
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
  nextAllowedRequestAt = 0;
  requestGate = Promise.resolve();
  lastRequestStartedAt = 0;
}
