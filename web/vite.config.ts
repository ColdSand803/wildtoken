import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  /* 后端把 /console 整个挂在这个目录上，资源路径必须跟着前缀走，
     否则构建产物里的 /assets/... 会打到站点根。 */
  base: "/console/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // 开发时让 vite 把 API 转给 Go 后端，省得跑两份数据源。
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/theme-packs": "http://127.0.0.1:3100",
    },
  },
});
