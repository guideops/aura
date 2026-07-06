#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptWatcher } from "@aura/adapter-claude-code";
import { createDaemon, defaultPublicDir } from "./server.js";

const PORT = Number(process.env["AURA_PORT"] ?? 8311);
const HOST = "127.0.0.1"; // local-only by design; never bind 0.0.0.0

const daemon = createDaemon({
  dbPath: process.env["AURA_DB"] ?? path.join(process.cwd(), "aura.db"),
  publicDir: defaultPublicDir(),
});

const permissionsPath = process.env["AURA_PERMISSIONS"] ?? path.join(process.cwd(), "permissions.yaml");
if (fs.existsSync(permissionsPath)) {
  daemon.guardrails.loadYaml(fs.readFileSync(permissionsPath, "utf8"));
  // eslint-disable-next-line no-console
  console.log(`[aura] guardrails loaded from ${permissionsPath}`);
}

// Transcript fallback: observes sessions without hooks + token usage for all.
const transcriptsRoot =
  process.env["AURA_TRANSCRIPTS"] ?? path.join(os.homedir(), ".claude", "projects");
if (process.env["AURA_WATCH"] !== "0" && fs.existsSync(transcriptsRoot)) {
  const watcher = new TranscriptWatcher({
    rootDir: transcriptsRoot,
    emit: (event) => daemon.bus.emit(event),
    ctx: daemon.store,
    isHookLive: (sessionId) => daemon.hookSessions.has(sessionId),
  });
  watcher.start();
  // eslint-disable-next-line no-console
  console.log(`[aura] transcript watcher on ${transcriptsRoot}`);
}

daemon.app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`[aura] daemon on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
