// Bundles the daemon CLI into resources/daemon for packaging.
// better-sqlite3 stays external (native .node binary) and is copied with its
// runtime deps, dereferencing pnpm symlinks so the output is self-contained.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.join(here, "..");
const repoRoot = path.join(desktopRoot, "..", "..");
const outDir = path.join(desktopRoot, "resources", "daemon");
const require = createRequire(import.meta.url);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, "packages", "daemon", "dist", "cli.js")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(outDir, "cli.cjs"),
  external: ["better-sqlite3"],
  logLevel: "info",
  // cjs output: give import.meta.url a real value (used by defaultPublicDir).
  define: { "import.meta.url": "__cjs_import_meta_url" },
  banner: {
    js: 'const __cjs_import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
});

// Native module + its runtime deps, dereferenced out of the pnpm store.
// pnpm isolates transitive deps, so resolve each from its dependent's dir.
const resolveFrom = (mod, fromDir) =>
  path.dirname(require.resolve(`${mod}/package.json`, { paths: [fromDir] }));
const sqlite = resolveFrom("better-sqlite3", path.join(repoRoot, "packages", "daemon"));
const bindings = resolveFrom("bindings", sqlite);
const fileUri = resolveFrom("file-uri-to-path", bindings);
for (const [mod, src] of [["better-sqlite3", sqlite], ["bindings", bindings], ["file-uri-to-path", fileUri]]) {
  fs.cpSync(src, path.join(outDir, "node_modules", mod), { recursive: true, dereference: true });
}

// Daemon UI (office/board/graph/console + assets).
fs.cpSync(
  path.join(repoRoot, "packages", "daemon", "public"),
  path.join(outDir, "public"),
  { recursive: true, dereference: true },
);

console.log(`daemon bundled → ${outDir}`);
