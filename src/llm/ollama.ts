import { Ollama, type Message } from 'ollama';
import { AbortError, type ChatRequest, type ChatResult, type Delta, type LLM, type ToolCall } from './types.js';

export interface OllamaOptions {
  host: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

function isOllamaCom(host: string): boolean {
  try {
    return new URL(host).hostname === 'ollama.com';
  } catch {
    return false;
  }
}

/** Chat backend for Ollama: a local daemon serving `*:cloud` models, or ollama.com directly with an API key. */
export class OllamaLLM implements LLM {
  private readonly client: Ollama;
  private readonly windows = new Map<string, Promise<number | undefined>>();

  constructor(options: OllamaOptions) {
    this.client = new Ollama({
      host: options.host,
      fetch: options.fetch,
      // Only send the key to ollama.com, never to an arbitrary host.
      headers: options.apiKey && isOllamaCom(options.host) ? { Authorization: `Bearer ${options.apiKey}` } : undefined,
    });
  }

  async chat(request: ChatRequest, onDelta?: (delta: Delta) => void): Promise<ChatResult> {
    if (request.signal?.aborted) throw new AbortError();
    const stream = await this.client.chat({
      model: request.model,
      messages: request.messages as Message[],
      tools: request.tools,
      stream: true,
      ...(request.think !== undefined ? { think: request.think } : {}),
    });
    const onAbort = () => stream.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    let usage: ChatResult['usage'];
    try {
      for await (const chunk of stream) {
        const m = chunk.message;
        if (m?.content) {
          content += m.content;
          onDelta?.({ content: m.content });
        }
        if (m?.thinking) {
          thinking += m.thinking;
          onDelta?.({ thinking: m.thinking });
        }
        if (m?.tool_calls?.length) toolCalls.push(...(m.tool_calls as ToolCall[]));
        if (chunk.done) {
          usage = { promptTokens: chunk.prompt_eval_count ?? 0, completionTokens: chunk.eval_count ?? 0 };
        }
      }
    } catch (err) {
      if (request.signal?.aborted || (err as Error).name === 'AbortError') throw new AbortError();
      throw err;
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }

    return {
      message: {
        role: 'assistant',
        content,
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      usage,
    };
  }

  contextWindow(model: string): Promise<number | undefined> {
    let pending = this.windows.get(model);
    if (!pending) {
      pending = this.client
        .show({ model })
        .then((info) => {
          const entries = Object.entries((info.model_info ?? {}) as unknown as Record<string, unknown>);
          const hit = entries.find(([k, v]) => k.endsWith('.context_length') && typeof v === 'number');
          return hit ? (hit[1] as number) : undefined;
        })
        .catch(() => undefined)
        .then((size) => {
          if (size === undefined) this.windows.delete(model); // retry next time (daemon may be down)
          return size;
        });
      this.windows.set(model, pending);
    }
    return pending;
  }
}
