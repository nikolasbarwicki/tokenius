import Anthropic from "@anthropic-ai/sdk";

import type { Provider, ProviderConfig } from "./types.ts";
import type { AssistantContent, Message, StreamEvent, TokenUsage, ToolSchema } from "@/types.ts";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const client = new Anthropic({ apiKey: config.apiKey });

  return {
    id: "anthropic",
    async *stream(model, context, signal) {
      const stream = client.messages.stream(
        {
          model,
          system: context.systemPrompt,
          messages: convertMessages(context.messages),
          tools: convertTools(context.tools),
          max_tokens: context.maxTokens,
        },
        { signal },
      );

      // Anthropic splits usage across two events: message_start has input tokens,
      // message_delta has output tokens. We capture input usage here and merge
      // them into the message_end event so consumers see complete usage in one place.
      let inputUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

      for await (const event of stream) {
        if (event.type === "message_start") {
          const u = event.message.usage as unknown as Record<string, number>;
          const cacheRead = u.cache_read_input_tokens;
          const cacheWrite = u.cache_creation_input_tokens;
          inputUsage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: 0,
            ...(typeof cacheRead === "number" && { cacheReadTokens: cacheRead }),
            ...(typeof cacheWrite === "number" && { cacheWriteTokens: cacheWrite }),
          };
        }

        const mapped = mapToStreamEvent(event, inputUsage);
        if (mapped) {
          yield mapped;
        }
      }
    },
  };
}

// --- Message conversion ---
// Our format is nearly 1:1 with Anthropic's, but we need to map
// ToolResultMessage to the Anthropic "user" role with tool_result content blocks.

function convertMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        result.push({ role: "user", content: msg.content });
        break;
      case "assistant":
        result.push({
          role: "assistant",
          content: msg.content.map((block) => {
            switch (block.type) {
              case "text":
                return { type: "text" as const, text: block.text };
              case "thinking":
                return { type: "thinking" as const, thinking: block.thinking, signature: "" };
              case "tool_call":
                return {
                  type: "tool_use" as const,
                  id: block.id,
                  name: block.name,
                  input: block.arguments,
                };
              default: {
                const _exhaustive: never = block;
                throw new Error(`Unknown block type: ${(_exhaustive as AssistantContent).type}`);
              }
            }
          }),
        });
        break;
      case "tool_result":
        result.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId,
              content: msg.content,
              is_error: msg.isError ?? false,
            },
          ],
        });
        break;
    }
  }

  return result;
}

// --- Tool schema conversion ---

function convertTools(tools: ToolSchema[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

// --- Stream event mapping ---
// Maps Anthropic's raw stream events to our common StreamEvent type.
// Returns null for events we don't care about (message_stop, signature_delta, etc.)

function mapToStreamEvent(
  event: RawMessageStreamEvent,
  inputUsage: TokenUsage,
): StreamEvent | null {
  switch (event.type) {
    case "message_start":
      return { type: "message_start" };

    case "content_block_start":
      if (event.content_block.type === "tool_use") {
        return {
          type: "tool_call_start",
          id: event.content_block.id,
          name: event.content_block.name,
        };
      }
      // text and thinking blocks don't need a start event — deltas are enough
      return null;

    case "content_block_delta":
      switch (event.delta.type) {
        case "text_delta":
          return { type: "text_delta", text: event.delta.text };
        case "thinking_delta":
          return { type: "thinking_delta", thinking: event.delta.thinking };
        case "input_json_delta":
          return { type: "tool_call_delta", arguments: event.delta.partial_json };
        default:
          // signature_delta, citations_delta — we don't use these
          return null;
      }

    case "content_block_stop":
      // We only emit tool_call_end — but we don't know the block type from content_block_stop.
      // The stream accumulator (Sprint 3) will track which block is active and handle this.
      // For now, we always emit it and let the consumer decide.
      return { type: "tool_call_end" };

    case "message_delta": {
      const usage: TokenUsage = {
        inputTokens: inputUsage.inputTokens,
        outputTokens: event.usage.output_tokens,
        ...("cacheReadTokens" in inputUsage && { cacheReadTokens: inputUsage.cacheReadTokens }),
        ...("cacheWriteTokens" in inputUsage && { cacheWriteTokens: inputUsage.cacheWriteTokens }),
      };
      return {
        type: "message_end",
        usage,
        stopReason: event.delta.stop_reason ?? "stop",
      };
    }

    case "message_stop":
      return null;
  }
}
