import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer-plugin"), base: "/_daisy/", plugins: [react()],
  build: { outDir: path.resolve(__dirname, "dist/renderer-plugin"), emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, "src/renderer-plugin/panel.html") } },
});
