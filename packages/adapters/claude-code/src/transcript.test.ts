import { describe, expect, it } from "vitest";
import { parseTranscriptLine } from "./transcript.js";
import type { NormalizeContext } from "./normalize.js";

const ctx: NormalizeContext = {
  displayNameFor: () => "blue-agent",
};

describe("parseTranscriptLine", () => {
  it("extracts usage.tokens from assistant entries", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-06T01:00:00.000Z",
      message: {
        model: "claude-fable-5",
        usage: { input_tokens: 900, output_tokens: 210, cache_read_input_tokens: 4400 },
        content: [{ type: "text", text: "ok" }],
      },
    });
    const events = parseTranscriptLine(line, "sess-t1", ctx);
    expect(events).toHaveLength(1);
    const first = events[0]!;
    expect(first.type).toBe("usage.tokens");
    expect(first.data["model"]).toBe("claude-fable-5");
    expect(first.data["inputTokens"]).toBe(900);
    expect(first.data["cacheReadTokens"]).toBe(4400);
    expect(first.ts).toBe(Date.parse("2026-07-06T01:00:00.000Z"));
  });

  it("extracts tool.use blocks alongside usage", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-fable-5",
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", name: "Read", input: { file_path: "x" } },
        ],
      },
    });
    const events = parseTranscriptLine(line, "sess-t1", ctx);
    expect(events.map((e) => e.type)).toEqual(["usage.tokens", "tool.use", "tool.use"]);
    expect(events[1]!.data["tool"]).toBe("Bash");
  });

  it("emits session.start from first user entry with cwd", () => {
    const line = JSON.stringify({ type: "user", cwd: "C:\\work\\aura", message: {} });
    const events = parseTranscriptLine(line, "sess-t2", ctx);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("session.start");
    expect(events[0]!.data["cwd"]).toBe("C:\\work\\aura");
  });

  it("fail-soft on garbage lines", () => {
    expect(parseTranscriptLine("{not json", "s", ctx)).toEqual([]);
    expect(parseTranscriptLine(JSON.stringify({ type: "summary" }), "s", ctx)).toEqual([]);
  });
});
