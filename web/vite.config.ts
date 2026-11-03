import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Inside Docker the API is reachable at http://api:3001 (the compose service name).
// Running outside Docker, it's http://localhost:3001.
const apiTarget = process.env.API_URL ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on 0.0.0.0 so Docker can expose it
    port: 5173,
    // Any request to /api/* from the browser is forwarded to the Express API.
    // This avoids CORS issues and means the React code just calls "/api/...".
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
    watch: {
      // Polling makes file-change detection reliable through Docker bind mounts.
      usePolling: process.env.VITE_POLL === "true",
    },
  },
});
