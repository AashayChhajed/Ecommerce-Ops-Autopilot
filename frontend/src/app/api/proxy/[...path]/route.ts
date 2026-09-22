/**
 * Same-origin API proxy — the security boundary for the browser.
 *
 * The Next.js client calls /api/proxy/* on its own origin. This server-side
 * route handler attaches the AUTOPILOT_API_KEY from process.env and forwards
 * the request to the Node backend. The key is NEVER shipped to the browser:
 * it lives only in server-side environment configuration.
 *
 * Why a proxy instead of NEXT_PUBLIC_* key: anything prefixed NEXT_PUBLIC_
 * is inlined into the client bundle and would be visible to every visitor.
 *
 * Configure in frontend/.env.local (server-side only, no NEXT_PUBLIC_ prefix):
 *   API_BACKEND_URL=http://localhost:4000
 *   AUTOPILOT_API_KEY=your-key
 */

import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.API_BACKEND_URL || 'http://localhost:4000';

// Hop-by-hop / forbidden headers we never forward.
const STRIPPED_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'expect',
]);

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const backendPath = `/${path.join('/')}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIPPED_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  const apiKey = process.env.AUTOPILOT_API_KEY;
  if (apiKey) {
    headers.set('X-API-Key', apiKey);
  }

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  try {
    const backendRes = await fetch(`${BACKEND_URL}${backendPath}`, {
      method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      cache: 'no-store',
      // Next.js caching must never serve stale dashboard data.
    });

    const resHeaders = new Headers();
    backendRes.headers.forEach((value, key) => {
      if (!STRIPPED_HEADERS.has(key.toLowerCase())) resHeaders.set(key, value);
    });
    // Always JSON from this origin.
    resHeaders.set('Content-Type', 'application/json; charset=utf-8');

    const body = await backendRes.arrayBuffer();
    return new NextResponse(body, {
      status: backendRes.status,
      headers: resHeaders,
    });
  } catch {
    // Backend unreachable — standardized error envelope, no internals leaked.
    return NextResponse.json(
      { error: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Backend service is unreachable' } },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  return proxy(req, ctx);
}
export async function POST(req: NextRequest, ctx: RouteContext) {
  return proxy(req, ctx);
}
export async function PUT(req: NextRequest, ctx: RouteContext) {
  return proxy(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  return proxy(req, ctx);
}
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  return proxy(req, ctx);
}
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
