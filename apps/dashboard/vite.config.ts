import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dashboardEvidence } from "./evidence.ts";

const proxy = { "/api": "http://127.0.0.1:4000" };
export default defineConfig({
  plugins: [react(), dashboardEvidence()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { proxy },
});
