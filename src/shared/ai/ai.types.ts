import { z } from 'zod';

export interface PredictionFeatures {
  store: { currency: string; horizonDays: number };
  sales: {
    last30Revenue: number; prior30Revenue: number; revenueTrendPct: number;
    last30Orders: number; prior30Orders: number; avgOrderValue: number; historyDays: number;
  };
  topProducts: Array<{ title: string; revenue: number; unitsSold: number }>;
  customers: {
    newCustomers: number; returningCustomers: number; repeatRatePct: number;
    churnRiskCount: number; vipCustomerCount: number;
  } | null;
  inventory: { totalSkus: number; lowStockSkus: number };
}

export const aiInsightSchema = z.object({
  insightType: z.enum(['opportunity', 'risk', 'warning']),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  confidenceScore: z.number().transform((n) => Math.max(0, Math.min(1, n))),
  recommendedAction: z.string().min(1),
});
export type AiInsight = z.infer<typeof aiInsightSchema>;

export const predictionInsightsSchema = z.object({
  summary: z.string(),
  insights: z.array(aiInsightSchema).max(8),
});
export type PredictionInsightsOutput = z.infer<typeof predictionInsightsSchema>;

export const PREDICTION_INSIGHTS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          insightType: { type: 'string', enum: ['opportunity', 'risk', 'warning'] },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          confidenceScore: { type: 'number' },
          recommendedAction: { type: 'string' },
        },
        required: ['insightType', 'title', 'description', 'priority', 'confidenceScore', 'recommendedAction'],
      },
    },
  },
  required: ['summary', 'insights'],
};

export const PREDICTION_SYSTEM_PROMPT = [
  'You are a senior e-commerce business analyst.',
  "Analyze the store's recent performance data and return conservative, explainable insights.",
  'Rules:',
  '- Use ONLY the data provided. Never invent numbers or facts.',
  '- Do NOT forecast an exact future revenue figure.',
  '- Every insight must reference the data that supports it.',
  '- confidenceScore is 0..1 reflecting how strongly the data supports the insight.',
  '- Return at most 6 insights, ordered most important first.',
].join('\n');
