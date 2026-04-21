// OpenAI (and OpenAI-compatible) provider.
//
// Works with OpenAI proper and every API that speaks the chat-completions
// dialect — xAI, DeepSeek, GLM, Kimi, etc. The `baseUrl` in ProviderConfig
// is how you point it at a different endpoint.
//
// The interesting work is in the two translation tables:
//   1. Message conversion — our Anthropic-native canonical format (content
//      blocks on assistant messages, a separate tool_result role) must
//      collapse into OpenAI's flat shape (tool_calls array on the assistant
//      message; a role:"tool" message for each result).
//   2. Stream mapping — OpenAI correlates streaming tool calls by `index`
//      rather than id. The id only arrives on the first delta for each index.
//      We track the current index and synthesize `tool_call_start` /
//      `tool_call_end` to match the Anthropic-shaped StreamEvent the
//      accumulator expects.
//
// Things we deliberately drop on this path:
//   * Thinking blocks — chat completions has no equivalent concept. Reasoning
//     models expose reasoning deltas only via the /v1/responses API, and
//     supporting both dialects for the sake of a nicer UI isn't worth the
//     complexity in a portfolio project.
//   * Cache-write tokens — OpenAI's prompt caching is automatic and only
//     reports `cached_tokens` (reads). We leave cacheWriteTokens undefined.

import OpenAI from "openai";

import type { Provider, ProviderConfig } from "./types.ts";
import type { AssistantContent, Message, StreamEvent, TokenUsage, ToolSchema } from "@/types.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined && { baseURL: config.baseUrl }),
  });

  return {
    id: "openai",
    async *stream(model, context, signal) {
      const tools = convertTools(context.tools);
      const stream = await client.chat.completions.create(
        {
          model,
          messages: convertMessages(context.systemPrompt, context.messages),
          ...(tools && { tools }),
          max_completion_tokens: context.maxTokens,
          stream: true,
          // Required to receive a final chunk carrying usage statistics;
          // without it we'd have no inputTokens/outputTokens to emit.
          stream_options: { include_usage: true },
        },
        { signal },
      );

      yield { type: "message_start" };
      yield* mapChunks(stream);
    },
  };
}

// --- Message conversion ---

function convertMessages(systemPrompt: string, messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        out.push({ role: "user", content: msg.content });
        break;
      case "assistant":
        out.push(convertAssistantMessage(msg.content));
        break;
      case "tool_result":
        // Truncate is the caller's job — tools already return bounded output.
        out.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.isError ? `ERROR: ${msg.content}` : msg.content,
        });
        break;
    }
  }

  return out;
}

function convertAssistantMessage(
  blocks: AssistantContent[],
): ChatCompletionMessageParam & { role: "assistant" } {
  // OpenAI's assistant message carries at most one text content string and a
  // parallel array of tool_calls. Merge consecutive text runs; thinking is
  // unsupported on this dialect, so we drop it (the model never sees its own
  // prior thinking — acceptable since reasoning is opaque on chat completions).
  const textParts: string[] = [];
  const toolCalls: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "thinking":
        // Intentional drop — see module-level comment.
        break;
      case "tool_call":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          },
        });
        break;
    }
  }

  const text = textParts.join("");
  // When there are tool calls, OpenAI accepts an empty-string content.
  // When there are no tool calls and no text, something is off upstream
  // (assistant messages can't be empty) — pass an empty string anyway so
  // the SDK doesn't throw on validation.
  if (toolCalls.length > 0) {
    return { role: "assistant", content: text, tool_calls: toolCalls };
  }
  return { role: "assistant", content: text };
}

// --- Tool schema conversion ---

function convertTools(tools: ToolSchema[]): ChatCompletionTool[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

// --- Stream mapping ---

async function* mapChunks(chunks: AsyncIterable<ChatCompletionChunk>): AsyncGenerator<StreamEvent> {
  // OpenAI streams tool calls keyed by `index`. The `id` + `name` arrive on
  // the first delta for each index; subsequent deltas only carry argument
  // fragments. We track the currently-open index to synthesize start/end
  // events matching the Anthropic-shaped StreamEvent contract.
  let openIndex: number | null = null;
  let usage: TokenUsage | null = null;
  let finishReason: string | null = null;

  for await (const chunk of chunks) {
    // The final chunk with include_usage carries an empty choices array and
    // a `usage` field. Grab it and keep going — don't return until the loop
    // exhausts.
    if (chunk.usage) {
      // Explicit undefined check so a reported 0 (confirmed cache miss) stays
      // on the usage object rather than being silently dropped — useful for
      // telemetry even though it's equivalent to "absent" for cost math.
      const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(cachedTokens !== undefined && { cacheReadTokens: cachedTokens }),
      };
    }

    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    const { delta } = choice;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text_delta", text: delta.content };
    }

    for (const tc of delta.tool_calls ?? []) {
      if (openIndex !== null && tc.index !== openIndex) {
        // A new tool call started while another was still "open" — the
        // previous one is implicitly complete.
        yield { type: "tool_call_end" };
        openIndex = null;
      }
      if (openIndex === null) {
        // First delta for this index must carry id + name. Guard anyway so
        // an off-spec provider can't crash us mid-stream.
        if (!tc.id || !tc.function?.name) {
          continue;
        }
        yield { type: "tool_call_start", id: tc.id, name: tc.function.name };
        openIndex = tc.index;
      }
      const args = tc.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        yield { type: "tool_call_delta", arguments: args };
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  if (openIndex !== null) {
    yield { type: "tool_call_end" };
  }

  yield {
    type: "message_end",
    usage: usage ?? { inputTokens: 0, outputTokens: 0 },
    stopReason: normalizeStopReason(finishReason),
  };
}

/** Exported for testing only. */
export const __testables = { mapChunks, convertMessages, convertTools, normalizeStopReason };

function normalizeStopReason(raw: string | null): "stop" | "tool_use" | "length" | "error" {
  switch (raw) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "length";
    case "content_filter":
      return "error";
    // "stop", "function_call" (deprecated), null, unknown → "stop"
    default:
      return "stop";
  }
}
