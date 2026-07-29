# AI Product Descriptions — Setup & Usage Guide

## Overview

This module generates AI-powered product descriptions using **Google Gemini (Flash / Flash-Lite)**. Descriptions are stored in the `descriptions` table for review and approval — **nothing is auto-published to Shopify**.

---

## 1. Setup

### 1.1 Get a Gemini API Key

1. Visit [Google AI Studio](https://aistudio.google.com/apikey) and sign in with your Google account.
2. Click **Create API Key** and select (or create) a Google Cloud project.
3. Copy the generated API key.

### 1.2 Configure Environment Variables

Add the following to your `.env` file in the project root:

```bash
# Required: Your Google Gemini API key
GEMINI_API_KEY=AIzaSy...

# Optional: preferred free-tier model (default: gemini-3.5-flash)
# If deprecated, system auto-falls back to other free Flash models — zero config needed.
# ⚠ Do NOT use gemini-flash-latest — that alias could resolve to a paid model.
GEMINI_MODEL_NAME=gemini-3.5-flash

# Optional: API version (default: v1beta, also accepts: v1)
GEMINI_API_VERSION=v1beta
```

**No secrets are hardcoded.** The API key is read from the environment at runtime.

### 1.3 Verify the Configuration

Start the backend and check the health endpoint:

```bash
cd backend
npm run dev
```

The server logs will confirm it started. Descriptions will fall back to **mock mode** (no API call) if `GEMINI_API_KEY` is missing or starts with `placeholder`.

---

## 2. Architecture

```
┌──────────────┐     POST /api/products/:id/generate-description     ┌──────────────────┐
│              │ ──────────────────────────────────────────────────▶  │                  │
│   Next.js    │                                                     │   Node.js API    │
│  Frontend    │ ◀──────────────────────────────────────────────────  │   (server.js)    │
│              │     { id, productTitle, generatedDescription, ... }  │                  │
└──────────────┘                                                     └────────┬─────────┘
                                                                               │
                                                                               ▼
                                                                     ┌──────────────────┐
                                                                     │   Gemini Client  │
                                                                     │   (gemini.js)    │
                                                                     └────────┬─────────┘
                                                                               │
                                                                         Gemini API
                                                                         (HTTPS)
                                                                               │
                                                                               ▼
                                                                     ┌──────────────────┐
                                                                     │   descriptions   │
                                                                     │   table (DB)     │
                                                                     └──────────────────┘
```

### Key Files

| File | Purpose |
| :--- | :--- |
| `backend/src/gemini.js` | Gemini API client — builds prompts, calls the API, returns text |
| `backend/src/lib.js` | `generateSingleDescription(product, { tone })` — orchestrates generation and DB storage |
| `backend/src/server.js` | Route handlers for generation and approval |
| `frontend/src/lib/api.ts` | Frontend API client functions |
| `frontend/src/app/products/page.tsx` | Products page with Generate button, tone picker, and review modal |

---

## 3. API Endpoints

### Generate a Description

```http
POST /api/products/:id/generate-description
Content-Type: application/json

{
  "tone": "friendly"          // optional: "professional" (default), "friendly", "playful", "expert"
}
```

**Backward-compatible alias:**
```http
POST /api/descriptions/generate/:id
```

**Response (201):**
```json
{
  "id": 12,
  "productId": 45,
  "productTitle": "Premium Cotton T-Shirt",
  "vendor": "FashionCo",
  "generatedDescription": "Introducing the Premium Cotton T-Shirt ...",
  "approved": false,
  "generatedAt": "2026-07-28T12:00:00.000Z"
}
```

**Response when description already exists:**
```json
{ "message": "Description already exists" }
```

### Approve a Description

```http
POST /api/descriptions/approve/:id
Content-Type: application/json

{
  "editedText": "Optional manual edits..."
}
```

**Response:**
```json
{
  "status": "APPROVED",
  "descriptionId": 12,
  "publishedAt": "2026-07-28T12:05:00.000Z"
}
```

### Get Pending Descriptions

```http
GET /api/descriptions/pending
```

### Batch Generate Missing Descriptions

```http
POST /api/descriptions/generate/batch
```

---

## 4. Using the Admin UI

1. Navigate to **Products** in the navigation bar.
2. **Optional:** Select a **Tone** for the AI copy from the dropdown next to the search bar.
   - **Professional** (default): Confident, benefit-focused language
   - **Friendly**: Warm, conversational tone
   - **Playful**: Energetic, fun language
   - **Expert**: Technical, authoritative voice
3. Click **Generate AI description** on any product row.
4. The modal appears with the AI-generated text. You can:
   - **Edit** the text directly in the textarea (word count shown)
   - **Approve & Apply** to mark it approved and update the product record
   - **Cancel** to leave it as pending
5. Use **Generate All Missing** to auto-generate descriptions for all products that don't have one yet.

---

## 5. Curl Examples

### Generate a description (default tone)

```bash
curl -X POST http://localhost:4000/api/products/1/generate-description \
  -H "Content-Type: application/json"
```

### Generate a description (friendly tone)

```bash
curl -X POST http://localhost:4000/api/products/1/generate-description \
  -H "Content-Type: application/json" \
  -d '{"tone": "friendly"}'
```

### Approve a description

```bash
curl -X POST http://localhost:4000/api/descriptions/approve/12 \
  -H "Content-Type: application/json" \
  -d '{"editedText": "Optional edited version..."}'
```

### List pending descriptions

```bash
curl http://localhost:4000/api/descriptions/pending
```

---

## 6. Tone Reference

| Tone | Best For | Prompt Addition |
| :--- | :--- | :--- |
| `professional` *(default)* | General store products | "Professional, engaging, and benefit-focused" |
| `friendly` | Lifestyle, home, gifts | "Warm, approachable, and conversational" |
| `playful` | Toys, novelty items, casual fashion | "Energetic, fun, and witty" |
| `expert` | Electronics, tools, technical gear | "Authoritative, technical, and detail-oriented" |

---

## 7. End-to-End Test Walkthrough

### Prerequisites

- Backend running on `http://localhost:4000`
- Products synced from Shopify (use the "Refresh" button or hit `POST /api/shopify/sync`)
- Your `.env` file has `GEMINI_API_KEY` (or the system falls back to mock mode)

### Steps

1. Open the frontend at `http://localhost:3000`
2. Click **Products** in the nav bar
3. In the **Tone** dropdown, select a tone (e.g., "Friendly")
4. Click **Generate AI description** on any product row
5. The review modal appears with the AI-generated text
6. **Verify:** The description is stored in the DB and appears in the modal
7. Edit the text if desired, then click **Approve & Apply**
8. **Verify:** The product's description is updated in the products table

### Verify via curl

```bash
# Step 1: List products to find an ID
curl http://localhost:4000/api/products | head -c 500

# Step 2: Generate a description
curl -s -X POST http://localhost:4000/api/products/1/generate-description \
  -H "Content-Type: application/json" -d '{"tone": "playful"}' | jq .

# Step 3: Check pending descriptions
curl -s http://localhost:4000/api/descriptions/pending | jq .
```

---

## 8. Logging

All generation events are logged to the `activity_logs` table with:

| Field | Example |
| :--- | :--- |
| `type` | `AI_GENERATION` |
| `message` | `Generated AI description for "Premium T-Shirt". prompt_len=512 gen_len=142 model=gemini-1.5-flash` |
| `status` | `SUCCESS` or `ERROR` |

The message includes:
- **Product title**
- **Prompt length** (characters)
- **Generated text length** (characters)
- **Model name**

---

## 9. Troubleshooting

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| `GEMINI_API_KEY is not configured` | No valid key found | Set `GEMINI_API_KEY` in `.env` |
| `Gemini API error (404)` | All Flash models exhausted | Run `curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$KEY" | jq '.models[].name'` to list available models. Add one to `FREE_MODEL_FALLBACKS` in `backend/src/gemini.js`. |
| `Gemini API error (403)` | Invalid API key | Regenerate the key in Google AI Studio |
| `Gemini API error (429)` | Rate limited | Wait and retry; free tier has limits |
| `Gemini returned no text` | Empty response | Check prompt; try a different tone |
| Mock descriptions shown | API key missing or starts with `placeholder` | Set a real key for live generation |
