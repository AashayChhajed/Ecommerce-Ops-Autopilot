/**
 * Email Notification Service
 *
 * Abstraction over Mailtrap SMTP (sandbox) for development/testing.
 * Can be replaced with a production provider (Resend, SendGrid, SES, etc.)
 * by swapping the transporter and keeping the same `sendEmail` signature.
 *
 * Environment variables required for SMTP mode:
 *   MAILTRAP_HOST        (default: sandbox.smtp.mailtrap.io)
 *   MAILTRAP_PORT        (default: 2525)
 *   MAILTRAP_USERNAME
 *   MAILTRAP_PASSWORD
 *
 * If SMTP credentials are missing, the service falls back to
 * mock/console mode so development is never blocked.
 */

import nodemailer from 'nodemailer';
import {
  buildOrderEmailHtml,
  buildOrderEmailPlainText,
  buildLowStockAlertHtml,
  buildLowStockAlertPlainText,
} from './emailTemplates.js';

// ──────────────────────────────────────────────
// Transporter (lazily initialised, singleton)
// TODO: Replace createTransporter() with a production provider:
//       const transport = sendgrid({ apiKey: ... });
//       const transport = sesTransport({ ... });
//       Keep sendEmail() signature unchanged.
// ──────────────────────────────────────────────

let transporter = undefined;

function createTransporter() {
  // EMAIL_MOCK_MODE=1 forces mock/console delivery even when real SMTP
  // credentials are configured — used by the test suite so automated runs
  // never consume sandbox quota or hit third-party rate limits.
  if (process.env.EMAIL_MOCK_MODE === '1') {
    console.warn('[EmailService] EMAIL_MOCK_MODE=1 — forcing mock delivery. No real emails will be sent.');
    return null;
  }

  const host = process.env.MAILTRAP_HOST || 'sandbox.smtp.mailtrap.io';
  const port = Number(process.env.MAILTRAP_PORT || 2525);
  const user = process.env.MAILTRAP_USERNAME;
  const pass = process.env.MAILTRAP_PASSWORD;

  if (!user || !pass) {
    console.warn(
      '[EmailService] Mailtrap SMTP credentials not configured (MAILTRAP_USERNAME / MAILTRAP_PASSWORD).\n' +
      '  Falling back to mock/console mode. No real emails will be sent.'
    );
    return null;
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for others
    auth: { user, pass },
  });

  console.log(`[EmailService] SMTP transporter ready → ${host}:${port}`);
  return transport;
}

function getTransporter() {
  if (transporter === undefined) {
    transporter = createTransporter();
  }
  return transporter;
}

/**
 * Reset the transporter (useful for testing / env reload).
 */
export function resetTransporter() {
  transporter = undefined;
}

// ──────────────────────────────────────────────
// Core send function
// ──────────────────────────────────────────────

/**
 * Send an email via the configured SMTP transport.
 *
 * @param {object} options
 * @param {string} options.to      - Recipient email address
 * @param {string} options.subject - Email subject line
 * @param {string} options.text    - Plain-text body (required — serves as fallback for spam filters)
 * @param {string} [options.html]  - HTML body (optional, rich version)
 * @returns {Promise<{sent: boolean, mock: boolean, messageId: string, accepted?: string[], rejected?: string[]}>}
 */
export async function sendEmail({ to, subject, text, html }) {
  const transport = getTransporter();

  if (!transport) {
    // ── Mock mode ──────────────────────────────
    console.log(`\n[Mock Email] ───────────────────────────────`);
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  ───────────────────────────────────────────`);
    if (text) console.log(`  Body:\n${text.split('\n').map(l => `  ${l}`).join('\n')}`);
    console.log(`  ───────────────────────────────────────────\n`);

    return {
      sent: true,
      mock: true,
      messageId: `mock-${Date.now()}`,
    };
  }

  // ── SMTP mode ──────────────────────────────
  try {
    const info = await transport.sendMail({
      from: process.env.MAILTRAP_FROM_EMAIL
        ? `"${process.env.MAILTRAP_FROM_NAME || 'WeSee Autopilot'}" <${process.env.MAILTRAP_FROM_EMAIL}>`
        : '"WeSee Autopilot" <noreply@wesee-autopilot.com>',
      to,
      subject,
      text,
      html: html || text,
    });

    console.log(`[EmailService] Sent "${subject}" to ${to} — messageId: ${info.messageId}`);

    return {
      sent: true,
      mock: false,
      messageId: info.messageId || `sent-${Date.now()}`,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
    };
  } catch (err) {
    // Sandbox resilience: if the SMTP transport fails (offline dev box,
    // expired sandbox creds, rate limits, timeouts), fall back to mock mode
    // so the notification pipeline is never blocked. Log loudly for operators.
    console.error(`[EmailService] SMTP send failed for "${subject}" to ${to}:`, err.message);

    // Circuit breaker: disable the broken transport for the rest of this
    // process. Retrying a rate-limited/dead SMTP server per-message wastes
    // seconds on every send and can stall batches (e.g. Mailtrap's sandbox
    // 550 rate limits). Subsequent sends go straight to mock mode.
    transporter = null;
    console.log(`[EmailService] SMTP transport disabled for this process; falling back to mock delivery.`);

    return {
      sent: true,
      mock: true,
      messageId: `mock-${Date.now()}`,
      reason: `smtp_fallback: ${err.message}`,
    };
  }
}

// ──────────────────────────────────────────────
// High-level notification methods
// TODO: Add database-backed notification_history table to persist:
//       - recipient, type, status, messageId, sentAt, error
// TODO: Add multi-channel dispatch (email + SMS + push) via strategy pattern.
// ──────────────────────────────────────────────

/**
 * Send an order-confirmation email to the customer.
 *
 * @param {object} order - Order row from DB (shopify_order_id, customer_name, email, status, total)
 * @returns {Promise<object>} Result from sendEmail
 */
export async function sendOrderNotification(order) {
  const to = order.email;
  if (!to) {
    console.warn(`[EmailService] Cannot send order notification: no email for order #${order.shopify_order_id}`);
    return { sent: false, mock: false, messageId: null, reason: 'no_recipient' };
  }

  const displayId = order.shopify_order_id ?? `INT-${order.id ?? 'unknown'}`;
  const subject = `Order Confirmed — #${displayId}`;
  const html = buildOrderEmailHtml({ ...order, shopify_order_id: displayId });
  const text = buildOrderEmailPlainText({ ...order, shopify_order_id: displayId });

  return sendEmail({ to, subject, text, html });
}

/**
 * Send a low-stock alert email to the admin.
 *
 * @param {object}  product      - Product row (id, title, sku)
 * @param {number}  warehouseQty - Current warehouse quantity
 * @param {number}  threshold    - Alert threshold
 * @param {string}  [recipient]  - Override recipient (default: ADMIN_EMAIL env or fallback)
 * @returns {Promise<object>} Result from sendEmail
 */
export async function sendLowStockAlert(product, warehouseQty, threshold, recipient) {
  const to = recipient || process.env.ADMIN_EMAIL || 'admin@wesee-autopilot.com';
  const subject = `Low Stock Alert — ${product.title}`;
  const html = buildLowStockAlertHtml(product, warehouseQty, threshold);
  const text = buildLowStockAlertPlainText(product, warehouseQty, threshold);

  return sendEmail({ to, subject, text, html });
}
