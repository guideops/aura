#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createDaemon, defaultPublicDir } from "./server.js";

const PORT = Number(process.env["BULLPEN_PORT"] ?? 8311);
const HOST = "127.0.0.1"; // local-only by design; never bind 0.0.0.0

const daemon = createDaemon({
  dbPath: process.env["BULLPEN_DB"] ?? path.join(process.cwd(), "bullpen.db"),
  publicDir: defaultPublicDir(),
});

const permissionsPath = process.env["BULLPEN_PERMISSIONS"] ?? path.join(process.cwd(), "permissions.yaml");
if (fs.existsSync(permissionsPath)) {
  daemon.guardrails.loadYaml(fs.readFileSync(permissionsPath, "utf8"));
  // eslint-disable-next-line no-console
  console.log(`[bullpen] guardrails loaded from ${permissionsPath}`);
}

daemon.app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`[bullpen] daemon on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
