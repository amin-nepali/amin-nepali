import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        amin: fileURLToPath(new URL("./amin.html", import.meta.url)),
        certificateViewer: fileURLToPath(new URL("./certificate-viewer.html", import.meta.url)),
        networkLab: fileURLToPath(new URL("./network-lab.html", import.meta.url)),
      },
    },
  },
});
