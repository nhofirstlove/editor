import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number(process.env.API_PORT ?? 5174);

export default defineConfig({
  root: "app",
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
