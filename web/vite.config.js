import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API + gateway calls to the control-plane server so the
// dashboard can use same-origin relative paths (/api, /v1).
const API_TARGET = process.env.VITE_API_TARGET || "http://localhost:4100";
const PORT = Number(process.env.WEB_PORT) || 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/v1": { target: API_TARGET, changeOrigin: true },
    },
  },
});
