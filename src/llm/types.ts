import type { Message, Tool } from 'ollama';
import type { ThinkSetting } from '../config';

export type { Message, Tool };

export interface ChatDelta {
  content?: string;
  thinking?: string;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: Tool[];
  think?: ThinkSetting;
  signal?: AbortSignal;
  onDelta?: (delta: ChatDelta) => void;
}

export interface ChatResult {
  message: Message;
  promptTokens: number;
  outputTokens: number;
}

/** The chat model abstraction the agents run on (Ollama in production, scripted fakes in tests). */
export interface LLM {
  chat(request: ChatRequest): Promise<ChatResult>;
  contextWindow(model: string): Promise<number>;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebPage {
  title: string;
  url: string;
  content: string;
  links: string[];
}

export interface WebClient {
  search(query: string, maxResults: number): Promise<WebSearchResult[]>;
  fetch(url: string): Promise<WebPage>;
}
