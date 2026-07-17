import { describe, expect, it } from "vitest";
import { HermesClient, HermesError } from "./client.js";

function sseResponse(frames: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status });
}

const chunk = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const usageFrame = (p: number, c: number) =>
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: p, completion_tokens: c } })}\n\n`;

describe("HermesClient", () => {
  it("streams deltas and accumulates text + usage", async () => {
    let captured: RequestInit | undefined;
    const client = new HermesClient({
      baseUrl: "https://api.example/v1/",
      apiKey: "k",
      fetchFn: async (_url, init) => {
        captured = init;
        return sseResponse([chunk("Hel"), chunk("lo"), usageFrame(12, 4), "data: [DONE]\n\n"]);
      },
    });
    const deltas: string[] = [];
    const out = await client.run({ prompt: "hi", system: "be brief" }, (d) => deltas.push(d));
    expect(out.text).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(out.model).toBe("Hermes-4-70B");
    const body = JSON.parse(String(captured!.body));
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(body.stream).toBe(true);
  });

  it("handles frames split across network reads", async () => {
    const full = chunk("split-frame");
    const client = new HermesClient({
      baseUrl: "https://api.example/v1",
      apiKey: "k",
      fetchFn: async () => sseResponse([full.slice(0, 12), full.slice(12)]),
    });
    const out = await client.run({ prompt: "x" });
    expect(out.text).toBe("split-frame");
  });

  it("throws HermesError with status detail on failure", async () => {
    const client = new HermesClient({
      baseUrl: "https://api.example/v1",
      apiKey: "bad",
      fetchFn: async () => new Response("unauthorized", { status: 401 }),
    });
    await expect(client.run({ prompt: "x" })).rejects.toThrow(HermesError);
  });

  it("respects per-run model override and config default", async () => {
    let body: { model?: string } = {};
    const client = new HermesClient({
      baseUrl: "https://api.example/v1",
      apiKey: "k",
      model: "Hermes-4-405B",
      fetchFn: async (_u, init) => {
        body = JSON.parse(String(init!.body));
        return sseResponse(["data: [DONE]\n\n"]);
      },
    });
    await client.run({ prompt: "x" });
    expect(body.model).toBe("Hermes-4-405B");
    await client.run({ prompt: "x", model: "Hermes-4-14B" });
    expect(body.model).toBe("Hermes-4-14B");
  });
});
