/**
 * Centralized Zod schemas for every API input.
 *
 * Rules:
 *  - Schemas are the single source of truth for request validation.
 *  - Failures become 400 VALIDATION_ERROR via validateWith() (safe messages,
 *    no Zod internals, no request payloads echoed back).
 *  - Existing business rules are preserved (e.g. quantity 1-9999, mock channel
 *    enum, tone enum). Schemas stay permissive where the app intentionally
 *    accepts optional fields.
 */

import { z } from 'zod';
import { MOCK_CHANNEL_CODES } from './channels/index.js';

// ──────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────
export const positiveIntSchema = z
  .number({ invalid_type_error: 'must be an integer' })
  .int('must be an integer')
  .min(1, 'must be >= 1');

export const idParamSchema = z.coerce
  .number({ invalid_type_error: 'must be an integer' })
  .int('must be an integer')
  .min(1, 'must be >= 1');

export const emailSchema = z
  .string()
  .trim()
  .max(254, 'must be at most 254 characters')
  .email('must be a valid email address')
  .optional()
  .or(z.literal('').transform(() => undefined));

const mockChannelEnum = z.enum(['AMAZON_MOCK', 'MYNTRA_MOCK', 'FLIPKART_MOCK']);

// ──────────────────────────────────────────────
// Pagination
// ──────────────────────────────────────────────
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const productQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(200).optional().default(''),
  status: z.string().trim().max(50).optional().default(''),
});

export const orderQuerySchema = paginationQuerySchema.extend({
  status: z.string().trim().max(50).optional().default(''),
});

export const logQuerySchema = paginationQuerySchema.extend({
  type: z.string().trim().max(100).optional().default(''),
});

export const descriptionQuerySchema = paginationQuerySchema.extend({
  status: z.string().trim().max(50).optional().default(''),
});

export const inventoryQuerySchema = paginationQuerySchema.extend({
  lowStockOnly: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

// ──────────────────────────────────────────────
// Order intake (POST /api/orders/intake)
// ──────────────────────────────────────────────
const intakeItemSchema = z
  .object({
    productId: positiveIntSchema.optional(),
    channelSku: z.string().trim().min(1).max(255).optional(),
    quantity: z
      .number({ invalid_type_error: 'must be an integer between 1 and 9999' })
      .int('must be an integer between 1 and 9999')
      .min(1, 'must be an integer between 1 and 9999')
      .max(9999, 'must be an integer between 1 and 9999'),
  })
  .refine((item) => item.productId != null || item.channelSku != null, {
    message: 'each item requires productId or channelSku',
    path: ['productId'],
  });

export const orderIntakeBodySchema = z
  .object({
    channel: z.string().trim().min(1, 'is required').max(50),
    orderReference: z.string().trim().max(255).optional(),
    customerName: z.string().trim().max(255).optional(),
    email: emailSchema,
    status: z.string().trim().max(50).optional(),
    total: z.coerce.number().min(0).max(10_000_000).optional(),
    items: z.array(intakeItemSchema).min(1, 'at least one item is required').max(200, 'too many items'),
  })
  .strict();

export const orderCheckBodySchema = z
  .object({
    items: z
      .array(
        z.object({
          productId: positiveIntSchema,
          quantity: z
            .number()
            .int()
            .min(1)
            .max(9999)
            .optional()
            .default(1),
        })
      )
      .min(1, 'items are required')
      .max(200, 'too many items'),
  })
  .strict();

export const mockChannelOrderBodySchema = z
  .object({
    orderReference: z.string().trim().max(255).optional(),
    customerName: z.string().trim().max(255).optional(),
    email: emailSchema,
    status: z.string().trim().max(50).optional(),
    total: z.coerce.number().min(0).max(10_000_000).optional(),
    items: z.array(intakeItemSchema).min(1, 'items are required').max(200, 'too many items'),
  })
  .strict();

// ──────────────────────────────────────────────
// Inventory / channels
// ──────────────────────────────────────────────
export const thresholdBodySchema = z
  .object({
    threshold: z.number({ invalid_type_error: 'must be a number' }).min(0).max(1_000_000),
  })
  .strict();

export const safetyBufferBodySchema = z
  .object({
    bufferPercent: z
      .number({ invalid_type_error: 'must be a number' })
      .min(1, 'must be between 1 and 100')
      .max(100, 'must be between 1 and 100'),
  })
  .strict();

export const warehouseQuantityBodySchema = z
  .object({
    quantity: z
      .number({ invalid_type_error: 'must be a number' })
      .min(0)
      .max(1_000_000),
  })
  .strict();

export const mockQuantityBodySchema = z
  .object({
    productId: positiveIntSchema,
    quantity: z
      .number({ invalid_type_error: 'must be a number' })
      .min(0)
      .max(1_000_000),
  })
  .strict();

// ──────────────────────────────────────────────
// Descriptions / AI
// ──────────────────────────────────────────────
const toneEnum = z.enum(['professional', 'friendly', 'playful', 'expert']);

export const descriptionSettingsBodySchema = z
  .object({
    tone: toneEnum.optional().or(z.literal('').transform(() => undefined)),
    language: z.string().trim().max(100).optional(),
    brandPhrases: z.string().trim().max(2000).optional(),
    styleNotes: z.string().trim().max(2000).optional(),
  })
  .strict();

export const generateDescriptionBodySchema = z
  .object({
    tone: toneEnum.optional().or(z.literal('').transform(() => undefined)),
  })
  .strict();

export const approveDescriptionBodySchema = z
  .object({
    editedText: z.string().max(50_000).optional(),
    reviewNotes: z.string().max(2000).optional(),
  })
  .strict();

export const approveByIdBodySchema = z
  .object({
    editedText: z.string().max(50_000).optional(),
  })
  .strict();

// ──────────────────────────────────────────────
// Test emails
// ──────────────────────────────────────────────
export const testEmailOrderBodySchema = z
  .object({
    orderId: z.union([z.string().trim().max(64), positiveIntSchema]).optional(),
    customerName: z.string().trim().max(255).optional(),
    email: emailSchema,
    status: z.string().trim().max(50).optional(),
    total: z.coerce.number().min(0).max(1_000_000).optional(),
  })
  .strict();

export const testEmailLowStockBodySchema = z
  .object({
    productId: z.coerce.number().int().min(1).optional(),
    productTitle: z.string().trim().max(255).optional(),
    sku: z.string().trim().max(255).optional(),
    quantity: z.coerce.number().int().min(0).optional(),
    threshold: z.coerce.number().int().min(0).optional(),
    email: emailSchema,
  })
  .strict();

export { mockChannelEnum };
