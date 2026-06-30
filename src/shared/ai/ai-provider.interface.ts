export interface JsonGenerationRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface AiProvider {
  readonly name: 'openai' | 'gemini';
  generateJson(req: JsonGenerationRequest): Promise<unknown>;
  embed(texts: string[]): Promise<number[][]>;
}
