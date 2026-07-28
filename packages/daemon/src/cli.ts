#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptWatcher } from "@aura/adapter-claude-code";
import { createDaemon, defaultIgnoreProjects, defaultPublicDir } from "./server.js";
import { writeBrief } from "./brief.js";

const PORT = Number(process.env["AURA_PORT"] ?? 8311);
const HOST = "127.0.0.1"; // local-only by design; never bind 0.0.0.0

const daemonOptions: Parameters<typeof createDaemon>[0] = {
  dbPath: process.env["AURA_DB"] ?? path.join(process.cwd(), "aura.db"),
  // AURA_PUBLIC lets a bundled build point at its copied public dir.
  publicDir: process.env["AURA_PUBLIC"] ?? defaultPublicDir(),
};
if (process.env["AURA_VAULT"]) daemonOptions.vaultDir = process.env["AURA_VAULT"];
if (process.env["AURA_SKILLS"]) daemonOptions.skillsDir = process.env["AURA_SKILLS"];
const daemon = createDaemon(daemonOptions);

const permissionsPath = process.env["AURA_PERMISSIONS"] ?? path.join(process.cwd(), "permissions.yaml");
const loadGuardrails = () => {
  daemon.guardrails.loadYaml(fs.readFileSync(permissionsPath, "utf8"));
  // eslint-disable-next-line no-console
  console.log(`[aura] guardrails loaded from ${permissionsPath}`);
};
if (fs.existsSync(permissionsPath)) {
  loadGuardrails();
  // Hot-reload on edit; debounce collapses editor write bursts.
  let reloadTimer: NodeJS.Timeout | null = null;
  fs.watch(permissionsPath, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      try { loadGuardrails(); } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[aura] guardrail reload failed (keeping previous rules):`, err);
      }
    }, 300);
    reloadTimer.unref?.();
  });
}

// Transcript fallback: observes sessions without hooks + token usage for all.
// AURA_TRANSCRIPTS takes a comma-separated list because a machine commonly has
// more than one Claude Code account, and watching only one silently hides every
// session run under the others.
const transcriptRoots = (
  process.env["AURA_TRANSCRIPTS"] ?? path.join(os.homedir(), ".claude", "projects")
)
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const ignoreProjects = defaultIgnoreProjects();
if (process.env["AURA_WATCH"] !== "0") {
  for (const rootDir of transcriptRoots) {
    if (!fs.existsSync(rootDir)) {
      // eslint-disable-next-line no-console
      console.warn(`[aura] transcript root missing, skipped: ${rootDir}`);
      continue;
    }
    const watcher = new TranscriptWatcher({
      rootDir,
      emit: (event) => daemon.bus.emit(event),
      ctx: daemon.store,
      isHookLive: (sessionId) => daemon.hookSessions.has(sessionId),
      ignore: ignoreProjects,
    });
    watcher.start();
    // eslint-disable-next-line no-console
    console.log(`[aura] transcript watcher on ${rootDir}`);
  }
  if (ignoreProjects.length) {
    // eslint-disable-next-line no-console
    console.log(`[aura] ignoring sessions matching: ${ignoreProjects.join(", ")}`);
  }
}

// Morning brief: write once on boot, then daily. Memory compounds.
try {
  writeBrief(daemon.vault, daemon.log);
} catch { /* empty history on first boot is fine */ }
const briefTimer = setInterval(() => {
  try { writeBrief(daemon.vault, daemon.log); } catch { /* noop */ }
}, 24 * 3_600_000);
briefTimer.unref?.();

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
