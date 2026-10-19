// 统一 API 客户端 — 未来 Capacitor 打包时只需改 VITE_API_BASE_URL
const BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

export function assetUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path) || path.startsWith("data:")) return path;
  return BASE_URL + path;
}

async function request(path, options = {}) {
  const url = BASE_URL + path;
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(value.error || value.message || `请求失败 (${response.status})`);
  }
  return value;
}

export const api = {
  get: (path) => request(path, { method: "GET" }),
  post: (path, body) => request(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: (path, body) => request(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: (path) => request(path, { method: "DELETE" }),
};
