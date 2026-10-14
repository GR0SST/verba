import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const API_URL = process.env.VERBA_API_URL ?? "http://localhost:8787"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // Listen on the LAN so a phone on the same Wi-Fi can open the dev server.
  server: { host: true, proxy: { "/api": API_URL } },
  preview: { host: true, proxy: { "/api": API_URL } },
  // onnxruntime-web loads its own .wasm/.mjs siblings; pre-bundling breaks those paths.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  build: { target: "es2022" },
})
