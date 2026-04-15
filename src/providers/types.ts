import type { Message, ProviderId, StreamEvent, ToolSchema } from "@/types.ts";

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface LLMContext {
  systemPrompt: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens: number;
}

export interface Provider {
  id: ProviderId;
  stream(model: string, context: LLMContext, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
