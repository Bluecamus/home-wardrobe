import dns from "node:dns";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { wardrobeImportApi } from "./scripts/import-job-api.mjs";
import { responsiveImageApi } from "./scripts/responsive-image-api.mjs";
import { featuresApi } from "./scripts/features-api.mjs";

// 国内网络环境：IPv6 优先解析常导致 fetch 超时，强制 IPv4 优先
dns.setDefaultResultOrder("ipv4first");

// 手动解析 .env 文件（vite loadEnv 有时不能正确加载所有变量）
function parseEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const result = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (key) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}
const fileEnv = parseEnvFile(resolve(process.cwd(), ".env"));

export default defineConfig(({ mode }) => {
  const env = { ...fileEnv, ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      allowedHosts: ["localhost"],
    },
    plugins: [react(), responsiveImageApi(), wardrobeImportApi({ env }), featuresApi({ env })],
  };
});
