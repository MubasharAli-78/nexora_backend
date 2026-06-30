import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env.schema';
import type { AiProvider } from './ai-provider.interface';
import { OpenAiProvider } from './openai.provider';
import { GeminiProvider } from './gemini.provider';
import { withRetry } from './ai.http';
import {
  PREDICTION_INSIGHTS_JSON_SCHEMA,
  PREDICTION_SYSTEM_PROMPT,
  predictionInsightsSchema,
  type PredictionFeatures,
  type PredictionInsightsOutput,
} from './ai.types';

/**
 * Single entry-point for AI features. Picks the active provider from env;
 * returns null on failure so callers degrade gracefully. Never throws to callers.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly openai: OpenAiProvider,
    private readonly gemini: GeminiProvider,
  ) {}

  private provider(): AiProvider | null {
    const choice = this.config.get('AI_PROVIDER', { infer: true });
    if (choice === 'openai' && this.config.get('OPENAI_API_KEY', { infer: true })) return this.openai;
    if (choice === 'gemini' && this.config.get('GEMINI_API_KEY', { infer: true })) return this.gemini;
    return null;
  }

  get enabled(): boolean { return this.provider() !== null; }
  get providerName(): string | null { return this.provider()?.name ?? null; }

  async generatePredictionInsights(features: PredictionFeatures): Promise<PredictionInsightsOutput | null> {
    const provider = this.provider();
    if (!provider) return null;
    try {
      const raw = await withRetry(
        () => provider.generateJson({
          system: PREDICTION_SYSTEM_PROMPT,
          user: `Analyze this store and return prediction insights as JSON.\n\n${JSON.stringify(features)}`,
          schemaName: 'prediction_insights',
          schema: PREDICTION_INSIGHTS_JSON_SCHEMA,
        }),
        2,
        (err, attempt) => this.logger.warn(`AI insights retry ${attempt} (${provider.name}): ${err.message}`),
      );
      return predictionInsightsSchema.parse(raw);
    } catch (err) {
      this.logger.error(`AI prediction insights failed (${provider.name}): ${(err as Error).message}`);
      return null;
    }
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    const provider = this.provider();
    if (!provider || texts.length === 0) return null;
    try {
      return await withRetry(() => provider.embed(texts), 2);
    } catch (err) {
      this.logger.error(`AI embed failed: ${(err as Error).message}`);
      return null;
    }
  }
}
