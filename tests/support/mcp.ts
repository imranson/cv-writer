import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/** Connects a real MCP client to the in-process server, exercising the same protocol path the agent uses. */
export async function connectMcp(server: McpSdkServerConfigWithInstance) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = result.content[0]?.text ?? '';
    return { isError: result.isError ?? false, text, json: <T = any>() => JSON.parse(text) as T };
  };
  return { client, call, close: () => client.close() };
}
