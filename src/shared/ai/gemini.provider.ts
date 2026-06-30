import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env.schema';
import type { AiProvider, JsonGenerationRequest } from './ai-provider.interface';
import { postJson } from './ai.http';

interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}
interface GeminiEmbedResponse {
  embeddings?: Array<{ values: number[] }>;
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === 'additionalProperties' || k === '$schema') continue;
      out[k] = toGeminiSchema(v);
    }
    return out;
  }
  return schema;
}

@Injectable()
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  private get apiKey() { return this.config.get('GEMINI_API_KEY', { infer: true }); }
  private get timeout() { return this.config.get('AI_TIMEOUT_MS', { infer: true }); }

  async generateJson(req: JsonGenerationRequest): Promise<unknown> {
    const model = this.config.get('GEMINI_MODEL', { infer: true });
    const res = await postJson(
      `${BASE}/${model}:generateContent?key=${this.apiKey}`,
      {},
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(req.schema),
          maxOutputTokens: req.maxOutputTokens ?? 1500,
        },
      },
      this.timeout,
    ) as GeminiGenerateResponse;

    const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned an empty response');
    return JSON.parse(text);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const model = this.config.get('GEMINI_EMBEDDING_MODEL', { infer: true });
    const res = await postJson(
      `${BASE}/${model}:batchEmbedContents?key=${this.apiKey}`,
      {},
      {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      },
      this.timeout,
    ) as GeminiEmbedResponse;

    if (!res.embeddings?.length) throw new Error('Gemini returned no embeddings');
    return res.embeddings.map((e) => e.values);
  }
}
