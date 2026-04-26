import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite config:
//  - alias @/ → src/
//  - dev-server proxies /api, /oauth, /healthz to backend (api:8080 in compose,
//    or VITE_API_TARGET env override for local-only).
export default defineConfig(({ mode }) => {
  const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:8080";
  return {
    plugins: [react()],
    resolve: {
      alias: { "@": path.resolve(__dirname, "src") },
    },
    server: {
      port: 5173,
      host: true,
      proxy: {
        "/api":     { target: apiTarget, changeOrigin: true, ws: true },
        "/oauth":   { target: apiTarget, changeOrigin: true },
        "/healthz": { target: apiTarget, changeOrigin: true },
        "/version": { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: mode !== "production",
    },
  };
});
