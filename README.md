# E-Commerce Operations Autopilot

E-Commerce Operations Autopilot is a full-stack operations command center for modern e-commerce teams. It connects Shopify product and order data with a polished dashboard, inventory safeguards, scheduled automations, and AI-generated product descriptions.

## What this project does

This app helps you:

- sync products and orders from Shopify into a PostgreSQL database
- monitor inventory, alerts, and low-stock conditions
- protect against overselling with an over-order guard and safety buffer
- review and approve AI-generated product descriptions with Gemini
- send order and stock notifications by email
- run scheduled background jobs for syncs, alerts, and reconciliation

## Main features

- Dashboard with KPIs for revenue, orders, products, alerts, and scheduler health
- Product and order management views
- Multi-channel inventory and mock channel simulation
- Order intake / allocation checks with warehouse stock protection
- AI description generation with Gemini, plus a mock fallback for local development
- Background scheduler for recurring operations
- Email notifications for order events and low-stock alerts

## Tech stack

- Backend: Node.js, PostgreSQL, `pg`, `node-cron`, `nodemailer`
- Frontend: Next.js, React, TypeScript, Tailwind CSS
- Integrations: Shopify Admin API, Google Gemini, Mailtrap-compatible email

## Project structure

- `backend/` — Node.js API server, DB setup, scheduler, Shopify sync logic, email and AI services
- `frontend/` — Next.js dashboard and UI pages
- `docs/` — implementation notes and AI description documentation
- `render.yaml` — Render deployment blueprint for the backend and PostgreSQL

## Prerequisites

Make sure you have:

- Node.js 20+ and npm 10+
- PostgreSQL running locally (or a hosted PostgreSQL instance)
- Optional: a Shopify access token and a Gemini API key

## Local setup

1. Clone the repository

```bash
git clone <your-repo-url>
cd ecommerce-ops-autopilot
```

2. Create a PostgreSQL database

Example:

```sql
CREATE DATABASE ecommerce_ops_autopilot;
```

3. Create environment variables

Create a `.env` file in the repository root with values similar to:

```env
PORT=4000
CORS_ORIGIN=http://localhost:3000

# Database
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/ecommerce_ops_autopilot
PGHOST=localhost
PGPORT=5432
PGDATABASE=ecommerce_ops_autopilot
PGUSER=postgres
PGPASSWORD=your_password

# Shopify sync (optional for local testing)
SHOPIFY_SYNC_ENABLED=false
SHOPIFY_SHOP_NAME=your-shop-name
SHOPIFY_ACCESS_TOKEN=your-shopify-token
SHOPIFY_API_VERSION=2024-04

# Gemini AI descriptions (optional)
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL_NAME=gemini-3.5-flash

# Email notifications (optional)
MAILTRAP_HOST=sandbox.smtp.mailtrap.io
MAILTRAP_PORT=2525
MAILTRAP_USERNAME=your_mailtrap_user
MAILTRAP_PASSWORD=your_mailtrap_password
MAILTRAP_FROM_EMAIL=from@example.com
MAILTRAP_FROM_NAME=E-Commerce Autopilot
ADMIN_EMAIL=you@example.com
ADMIN_PANEL_URL=http://localhost:3000
```

> If `GEMINI_API_KEY` is missing, the app will fall back to mock AI descriptions so you can test the UI without external billing.

4. Install backend dependencies

```bash
cd backend
npm install
```

5. Install frontend dependencies

```bash
cd ../frontend
npm install
```

## Run the application locally

### Start the backend

```bash
cd backend
npm run dev
```

The backend will run at:

- http://localhost:4000
- health check: http://localhost:4000/actuator/health

### Start the frontend

In a second terminal:

```bash
cd frontend
npm run dev
```

Open http://localhost:3000 to view the dashboard.

## How to test it quickly

You can test the app even without live Shopify credentials:

1. Start the backend and frontend as above.
2. Open the dashboard at http://localhost:3000.
3. Confirm the API health and database status appear correctly.
4. Visit the Products, Orders, Inventory, Scheduler, and Logs pages to explore the UI.
5. If you want to try AI descriptions, click the product description flow. Without a Gemini key, the system will generate placeholder/mock descriptions automatically.

## Backend test commands

Run the backend tests:

```bash
cd backend
npm test
```

## Key API endpoints

The backend exposes endpoints such as:

- `GET /actuator/health`
- `GET /api/products`
- `GET /api/orders`
- `GET /api/inventory`
- `POST /api/shopify/sync`
- `POST /api/orders/intake`
- `POST /api/products/:id/generate-description`
- `POST /api/descriptions/approve/:id`

## Deployment

The repository includes a Render blueprint for deployment:

- `render.yaml` — deploys the backend and PostgreSQL together
- Frontend can be deployed separately on Vercel or another hosting provider

Recommended deployment flow:

- Backend + PostgreSQL → Render
- Frontend → Vercel
- Set all secrets as environment variables in the deployment platform

## Notes

- The app is designed to work both with live Shopify data and with mock/demo flows.
- The scheduler runs recurring jobs in the background and writes run history into the database.
- The over-order guard is a core safeguard to prevent overselling beyond warehouse availability.