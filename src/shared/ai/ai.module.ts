import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { OpenAiProvider } from './openai.provider';
import { GeminiProvider } from './gemini.provider';

@Global()
@Module({
  providers: [OpenAiProvider, GeminiProvider, AiService],
  exports: [AiService],
})
export class AiModule {}
