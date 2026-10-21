import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Studio runs the add-on's own rule runtime and simulator (../src/kernel) in the
// browser. Their one runtime import from teob-ts is the pure state normalizer; point
// it at that file so the HA client (Node only) stays out of the bundle.
const normalize = fileURLToPath(
  new URL("../node_modules/@lambda-house/teob-ts/dist/ha/normalize.js", import.meta.url),
);

// base "./" is MANDATORY: HA ingress serves the panel under a dynamic path
// prefix, so every asset URL must be relative to index.html.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: { alias: [{ find: /^@lambda-house\/teob-ts\/ha$/, replacement: normalize }] },
  worker: { format: "es" },
  build: {
    outDir: "../panel-dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
  },
  server: {
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://localhost:8099",
      "/health": "http://localhost:8099",
    },
  },
});
