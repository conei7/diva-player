import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // 環境変数 VITE_API_TARGET があればそれを使い、無ければ localhost を使う
  const apiTarget = env.VITE_API_TARGET || "http://localhost:5000";

  return {
    plugins: [react(), tailwindcss()],
    base: env.VITE_BASE_PATH || "/diva-player/",
    server: {
      allowedHosts: true,
      proxy: {
        "/invidious-api": {
          target: "https://inv.nadeko.net",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/invidious-api/, ""),
        },
        "/backend-api": {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/backend-api/, ""),
        },
      },
    },
  };
});
