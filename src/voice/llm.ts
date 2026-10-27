// llm.ts — one OpenAI-compatible chat client with tools: OpenRouter, Ollama (/v1), or
// any server that speaks the chat completions API. The voice lane is its only user: no
// tool it is given switches anything (loop.ts).

export interface ToolCall {
  id: string;
  name: string;
  /** The arguments as the model wrote them (JSON text). */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments (an object). */
  parameters: Record<string, unknown>;
}

export interface Completion {
  text: string | null;
  calls: ToolCall[];
  model: string;
  usage: { input: number; output: number; /** USD, when the server says (OpenRouter). */ cost?: number };
}

export interface ChatClient {
  readonly model: string;
  complete(req: { messages: ChatMessage[]; tools: ToolDef[]; temperature?: number }): Promise<Completion>;
}

export interface ChatClientOptions {
  /** e.g. https://openrouter.ai/api/v1 or http://ollama.lan:11434/v1 */
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** OpenRouter: ask for the cost in the usage. */
  openrouter?: boolean;
}

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export function createChatClient(o: ChatClientOptions): ChatClient {
  const f = o.fetchImpl ?? fetch;
  const url = `${o.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    model: o.model,
    async complete(req) {
      const body = {
        model: o.model,
        messages: req.messages,
        tools: req.tools.map((t) => ({ type: "function", function: t })),
        // Every answer is a tool call: a command, or one of the ways to say no (loop.ts).
        tool_choice: "required",
        temperature: req.temperature ?? 0,
        ...(o.openrouter ? { usage: { include: true } } : {}),
      };
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
      // The key never appears in an error: only the status and the server's words.
      if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      const msg = data.choices?.[0]?.message;
      if (msg === undefined) throw new Error("model: no choice in the answer");
      const calls = (msg.tool_calls ?? []).flatMap((c, i) =>
        c.function?.name ? [{ id: c.id ?? `call_${i}`, name: c.function.name, arguments: c.function.arguments ?? "{}" }] : [],
      );
      return {
        text: msg.content ?? null,
        calls,
        model: data.model ?? o.model,
        usage: {
          input: data.usage?.prompt_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
          ...(typeof data.usage?.cost === "number" ? { cost: data.usage.cost } : {}),
        },
      };
    },
  };
}
