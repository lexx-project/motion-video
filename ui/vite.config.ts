import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/renders": "http://localhost:8787",
      "/previews": "http://localhost:8787",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "..", "dist-ui"),
    emptyOutDir: true,
  },
});
