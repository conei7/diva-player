import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/diva-player/",
  server: {
    allowedHosts: true,
    proxy: {
      "/invidious-api": {
        target: "https://inv.nadeko.net",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/invidious-api/, ""),
      },
      "/backend-api": {
        target: "http://100.75.253.56:5000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/backend-api/, ""),
      },
    },
  },
});
