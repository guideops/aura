import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesClient } from "@aura/adapter-hermes";
import { createDaemon, type Daemon } from "./server.js";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}
const chunk = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const usageFrame = (p: number, c: number) =>
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: p, completion_tokens: c } })}\n\n`;

function mockClient(frames: string[]): HermesClient {
  return new HermesClient({
    baseUrl: "https://mock/v1",
    apiKey: "test",
    fetchFn: async () => sseResponse(frames),
  });
}

let dir: string;
let daemon: Daemon;

async function boot(client: HermesClient | null) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-hermes-"));
  daemon = createDaemon({
    dbPath: ":memory:",
    vaultDir: path.join(dir, "vault"),
    skillsDir: path.join(dir, "skills"),
    spaceFile: path.join(dir, "office.space.json"),
    hermesClient: client,
  });
  await daemon.app.ready();
}
afterEach(async () => {
  await daemon.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("hermes sessions", () => {
  it("runs a hermes session end-to-end: output, status, events, usage", async () => {
    await boot(mockClient([chunk("Line one\nLine "), chunk("two"), usageFrame(50, 9), "data: [DONE]\n\n"]));
    const res = await daemon.app.inject({
      method: "POST", url: "/api/sessions",
      payload: { provider: "hermes", prompt: "summarize the vault" },
    });
    expect(res.statusCode).toBe(200);
    const { session } = res.json();
    expect(session.provider).toBe("hermes");
    expect(session.status).toBe("running");

    await vi.waitFor(async () => {
      const list = (await daemon.app.inject({ url: "/api/sessions" })).json().sessions;
      expect(list.find((s: { id: string }) => s.id === session.id).status).toBe("exited");
    });

    const { lines } = (await daemon.app.inject({ url: `/api/sessions/${session.id}/output` })).json();
    expect(lines).toEqual(["Line one", "Line two"]);

    // Events landed on the bus → hermes-agent exists with token usage.
    const { agents } = (await daemon.app.inject({ url: "/api/agents" })).json();
    const hermesAgent = agents.find((a: { agentId: string }) => a.agentId === "hermes-agent");
    expect(hermesAgent).toBeDefined();
    expect(hermesAgent.provider).toBe("hermes");

    const usage = (await daemon.app.inject({ url: "/api/usage" })).json();
    const row = usage.models.find((m: { model: string }) => m.model === "Hermes-4-70B");
    expect(row.tokens).toBe(59);
  });

  it("marks the session failed and buffers the error on API failure", async () => {
    const failing = new HermesClient({
      baseUrl: "https://mock/v1", apiKey: "bad",
      fetchFn: async () => new Response("nope", { status: 401 }),
    });
    await boot(failing);
    const { session } = (await daemon.app.inject({
      method: "POST", url: "/api/sessions", payload: { provider: "hermes", prompt: "x" },
    })).json();
    await vi.waitFor(async () => {
      const list = (await daemon.app.inject({ url: "/api/sessions" })).json().sessions;
      expect(list.find((s: { id: string }) => s.id === session.id).status).toBe("failed");
    });
    const { lines } = (await daemon.app.inject({ url: `/api/sessions/${session.id}/output` })).json();
    expect(lines[0]).toContain("[stderr]");
  });

  it("409s when hermes is not configured", async () => {
    await boot(null);
    const res = await daemon.app.inject({
      method: "POST", url: "/api/sessions", payload: { provider: "hermes", prompt: "x" },
    });
    expect(res.statusCode).toBe(409);
    expect((await daemon.app.inject({ url: "/api/hermes/status" })).json()).toEqual({ enabled: false });
  });
});
