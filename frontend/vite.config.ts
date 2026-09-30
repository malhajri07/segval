import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `--mode demo` builds a single self-contained HTML file with an in-browser engine
// and a bundled sample dataset (see src/demo). No backend needed.
export default defineConfig(({ mode }) => ({
  plugins: mode === "demo" ? [react(), viteSingleFile()] : [react()],
  build: mode === "demo" ? { outDir: "dist-demo", chunkSizeWarningLimit: 6000 } : {},
  server: {
    port: 5173,
    proxy: { "/api": process.env.SEGVAL_API ?? "http://localhost:8000" },
  },
}));
