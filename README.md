# E-Commerce Operations Autopilot

E-Commerce Operations Autopilot synchronizes Shopify product data into PostgreSQL and presents it in a Next.js operations dashboard.

## Stack

- Backend: Node.js 20+, native HTTP server, PostgreSQL (`pg`), dotenv
- Frontend: Next.js, React, TypeScript, Tailwind CSS
- Integrations: Shopify Admin REST API, Gemini, Mailtrap

## Prerequisites

- Node.js 20+ and npm 10+
- PostgreSQL running locally on port 5432

Create the `ecommerce_ops_autopilot` database, then copy `.env.example` to `.env` and set your PostgreSQL and Shopify credentials.

## Run the backend

```bash
cd backend
npm install
npm run dev
```

The backend starts at `http://localhost:4000` by default. Set `PORT` to override it.

Available Day 1 endpoints:

- `GET /health`
- `GET /api/products`
- `GET /api/products/:id`
- `GET /api/shopify/products`
- `POST /api/shopify/sync`

## Run the frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend is available at `http://localhost:3000` and expects the backend at `http://localhost:4000`. Override this with `NEXT_PUBLIC_API_BASE_URL`.

## Test the backend

```bash
cd backend
npm test
```

## Deploy

- **Backend + PostgreSQL → Render** (blueprint: `render.yaml`) and **Frontend → Vercel**:
  see [DEPLOYMENT.md](DEPLOYMENT.md) for the full step-by-step guide, env var tables,
  keep-alive setup for the free-tier scheduler, and verification steps.
- The frontend connects to the backend via `NEXT_PUBLIC_API_BASE_URL`
  (defaults to `http://localhost:4000`).
- Copy `backend/.env.example` → repo root `.env` (or `backend/.env`) for local development.
