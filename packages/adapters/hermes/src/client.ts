/**
 * Minimal client for Nous Research Hermes models over the OpenAI-compatible
 * chat-completions API. Streaming SSE, no SDK dependency — one fetch call.
 *
 * Endpoint + key come from config (daemon reads AURA_HERMES_URL / AURA_HERMES_KEY);
 * `fetchFn` is injectable so tests never touch the network.
 */

export interface HermesConfig {
  baseUrl: string; // e.g. https://inference-api.nousresearch.com/v1
  apiKey: string;
  model?: string; // default model when a run doesn't specify one
  fetchFn?: typeof fetch; // test seam
}

export interface HermesUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface HermesResult {
  text: string;
  model: string;
  usage: HermesUsage;
}

export const DEFAULT_HERMES_MODEL = "Hermes-4-70B";

export class HermesError extends Error {}

export class HermesClient {
  constructor(private cfg: HermesConfig) {}

  get defaultModel(): string {
    return this.cfg.model ?? DEFAULT_HERMES_MODEL;
  }

  /**
   * Stream one completion. `onDelta` fires per content chunk; resolves with the
   * full text + usage (zeros when the API omits usage on stream).
   */
  async run(
    input: { prompt: string; system?: string; model?: string },
    onDelta?: (chunk: string) => void,
  ): Promise<HermesResult> {
    const doFetch = this.cfg.fetchFn ?? fetch;
    const model = input.model ?? this.defaultModel;
    const messages: Array<{ role: string; content: string }> = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    messages.push({ role: "user", content: input.prompt });

    const res = await doFetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new HermesError(`hermes ${res.status}: ${detail.slice(0, 300)}`);
    }
    if (!res.body) throw new HermesError("hermes: empty response body");

    let text = "";
    const usage: HermesUsage = { inputTokens: 0, outputTokens: 0 };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are newline-delimited "data: {json}" lines.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onDelta?.(delta);
          }
          if (json.usage) {
            usage.inputTokens = json.usage.prompt_tokens ?? 0;
            usage.outputTokens = json.usage.completion_tokens ?? 0;
          }
        } catch {
          // Malformed frame — skip; stream keeps flowing.
        }
      }
    }
    return { text, model, usage };
  }
}
