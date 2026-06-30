import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env.schema';
import type { AiProvider, JsonGenerationRequest } from './ai-provider.interface';
import { postJson } from './ai.http';

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}
interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
}

@Injectable()
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  private get apiKey() { return this.config.get('OPENAI_API_KEY', { infer: true }); }
  private get timeout() { return this.config.get('AI_TIMEOUT_MS', { infer: true }); }

  async generateJson(req: JsonGenerationRequest): Promise<unknown> {
    const res = await postJson(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.config.get('OPENAI_MODEL', { infer: true }),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: req.schemaName, strict: true, schema: req.schema },
        },
        max_completion_tokens: req.maxOutputTokens ?? 1500,
      },
      this.timeout,
    ) as OpenAiChatResponse;

    const content = res.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');
    return JSON.parse(content);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await postJson(
      'https://api.openai.com/v1/embeddings',
      { authorization: `Bearer ${this.apiKey}` },
      { model: this.config.get('OPENAI_EMBEDDING_MODEL', { infer: true }), input: texts },
      this.timeout,
    ) as OpenAiEmbeddingResponse;

    if (!res.data?.length) throw new Error('OpenAI returned no embeddings');
    return res.data.map((d) => d.embedding);
  }
}
