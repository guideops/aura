import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Builds straight into the daemon's public dir so fastify-static serves the
// shell at /shell/ with zero extra wiring. Dev mode proxies API + WS to a
// locally running daemon (pnpm dev in packages/daemon, port 8311).
export default defineConfig({
  plugins: [react()],
  base: "/shell/",
  build: {
    outDir: path.resolve(__dirname, "../daemon/public/shell"),
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    proxy: {
      "/api": { target: "http://127.0.0.1:8311", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8311", ws: true },
      // Non-shell daemon pages embedded as iframes (office, CAD).
      "/office.html": { target: "http://127.0.0.1:8311", changeOrigin: true },
      "/assets": { target: "http://127.0.0.1:8311", changeOrigin: true },
    },
  },
});
