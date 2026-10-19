import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { openAIAnalyze, openAIEdit, normalizeMetadata, cropDetectedItem, removeBackgroundLocally } from "./ai-client.mjs";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const TOKEN_FILE = /^[a-f0-9-]{36}\.(png|jpg|jpeg|webp)$/i;
const LINK_ID = /^link-[a-f0-9-]{36}$/i;
const HTTP_URL = /^https?:\/\/.+/i;
const QWEATHER_BASE = "https://devapi.qweather.com";
const QWEATHER_GEO_BASE = "https://geoapi.qweather.com";
const OPEN_METEO_BASE = "https://api.open-meteo.com";
const WEATHER_CACHE_TTL = 10 * 60 * 1000;
const TMP_TTL = 24 * 60 * 60 * 1000;
const LIBRARY_ASSET_ROOT = "/api/import/library";

const STYLE_TAGS = [
  "通勤",
  "极简",
  "街头",
  "甜酷",
  "法式",
  "休闲",
  "运动",
  "复古",
  "学院",
  "日系",
  "韩系",
  "工装",
  "度假",
];

const STYLE_ANALYZE_PROMPT =
  "分析这张穿搭灵感图的整体风格。从给定风格词表中挑选最多5个最贴切的标签，提取最多5个主色（hex），识别图中可见的单品（每件包含部位、颜色hex、简短中文描述），并用一句中文总结这套搭配的核心风格与场景。所有文本字段必须使用简体中文，严禁使用英文。只返回结构化结果。";

const STYLE_ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    styleTags: {
      type: "array",
      items: { type: "string", enum: STYLE_TAGS },
      maxItems: 5,
      uniqueItems: true,
    },
    palette: {
      type: "array",
      items: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
      maxItems: 5,
    },
    garments: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          part: { type: "string" },
          color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          description: { type: "string" },
        },
        required: ["part", "color", "description"],
      },
    },
    summary: { type: "string" },
  },
  required: ["styleTags", "palette", "garments", "summary"],
};

function setting(env, name, fallback = "") {
  const fromEnv = env?.[name];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromProcess = process.env[name];
  return fromProcess !== undefined && fromProcess !== "" ? fromProcess : fallback;
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error("请求体过大"), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请发送 JSON 格式的请求体"), { status: 400 });
  }
}

function decodeImage(input) {
  const raw = input?.imageDataUrl;
  if (!raw || typeof raw !== "string") {
    throw Object.assign(new Error("imageDataUrl is required"), { status: 400 });
  }
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match?.[1] || "image/png";
  const data = Buffer.from(match?.[2] || raw, "base64");
  if (!data.length) throw Object.assign(new Error("图片数据为空"), { status: 400 });
  return { data, mime };
}

async function normalizeImage(bytes) {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

function safeBaseName(file) {
  const base = path.basename(file || "");
  if (!TOKEN_FILE.test(base)) {
    throw Object.assign(new Error("无效的文件名"), { status: 400 });
  }
  return base;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function serveImage(res, file) {
  try {
    await stat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.end(await readFile(file));
  return true;
}

function beaufortScale(windSpeedKmh) {
  const thresholds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  for (let index = 0; index < thresholds.length; index += 1) {
    if (windSpeedKmh < thresholds[index]) return index;
  }
  return 12;
}

function windDirectionChinese(degrees) {
  const deg = ((Number(degrees) % 360) + 360) % 360;
  const compass = [
    [22.5, "北"],
    [67.5, "东北"],
    [112.5, "东"],
    [157.5, "东南"],
    [202.5, "南"],
    [247.5, "西南"],
    [292.5, "西"],
    [337.5, "西北"],
    [360, "北"],
  ];
  for (const [boundary, label] of compass) {
    if (deg < boundary) return label;
  }
  return "北";
}

function wmoWeatherText(code) {
  const table = {
    0: "晴",
    1: "多云",
    2: "局部多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "小毛雨",
    53: "毛雨",
    55: "中毛雨",
    56: "冻毛雨",
    57: "冻雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "小阵雨",
    81: "阵雨",
    82: "强阵雨",
    85: "小阵雪",
    86: "强阵雪",
    95: "雷暴",
    96: "雷暴伴冰雹",
    99: "强雷暴伴冰雹",
  };
  return table[code] || "未知";
}

function roundTemp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number);
}

async function fetchQWeather(key, lat, lon) {
  const location = `${lon},${lat}`;
  const nowUrl = `${QWEATHER_BASE}/v7/weather/now?key=${encodeURIComponent(key)}&location=${encodeURIComponent(location)}`;
  const dailyUrl = `${QWEATHER_BASE}/v7/weather/3d?key=${encodeURIComponent(key)}&location=${encodeURIComponent(location)}`;
  const geoUrl = `${QWEATHER_GEO_BASE}/v2/city/lookup?key=${encodeURIComponent(key)}&location=${encodeURIComponent(location)}`;

  const [nowResponse, dailyResponse, geoResponse] = await Promise.all([
    fetch(nowUrl).then((r) => r.json().catch(() => ({}))).catch(() => ({})),
    fetch(dailyUrl).then((r) => r.json().catch(() => ({}))).catch(() => ({})),
    fetch(geoUrl).then((r) => r.json().catch(() => ({}))).catch(() => ({})),
  ]);

  if (String(nowResponse.code || "") !== "200" || !nowResponse.now) {
    throw new Error(nowResponse.message || "QWeather current request failed");
  }
  const now = nowResponse.now;
  const today = Array.isArray(dailyResponse.daily) ? dailyResponse.daily[0] : null;
  const city = Array.isArray(geoResponse.location) ? geoResponse.location[0]?.name : undefined;

  return {
    provider: "qweather",
    city: city || undefined,
    temp: roundTemp(now.temp),
    feelsLike: roundTemp(now.feelsLike),
    text: now.text || "",
    windScale: String(now.windScale || ""),
    windDir: now.windDir || "",
    tempMax: today ? roundTemp(today.tempMax) : null,
    tempMin: today ? roundTemp(today.tempMin) : null,
    precip: now.precip !== undefined ? roundTemp(now.precip) : undefined,
  };
}

async function fetchOpenMeteo(lat, lon) {
  const url =
    `${OPEN_METEO_BASE}/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m" +
    "&daily=temperature_2m_max,temperature_2m_min&timezone=auto";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo request failed (${response.status})`);
  const data = await response.json();
  const current = data.current || {};
  const daily = data.daily || {};
  const dailyMax = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
  const dailyMin = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;
  return {
    provider: "open-meteo",
    city: undefined,
    temp: roundTemp(current.temperature_2m),
    feelsLike: roundTemp(current.apparent_temperature),
    text: wmoWeatherText(current.weather_code),
    windScale: String(beaufortScale(Number(current.wind_speed_10m) || 0)),
    windDir: windDirectionChinese(current.wind_direction_10m),
    tempMax: roundTemp(dailyMax),
    tempMin: roundTemp(dailyMin),
    precip: current.precipitation !== undefined ? roundTemp(current.precipitation) : undefined,
  };
}

async function cleanupTmpDir(tmpDir) {
  const files = await readdir(tmpDir).catch(() => []);
  const now = Date.now();
  for (const file of files) {
    if (!TOKEN_FILE.test(file)) continue;
    const filePath = path.join(tmpDir, file);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) continue;
    if (now - fileStat.mtimeMs > TMP_TTL) await rm(filePath, { force: true });
  }
}

function extractProductImage(html, pageUrl) {
  const resolve = (src) => {
    if (!src || typeof src !== "string") return null;
    let value = src.trim().replace(/&amp;/g, "&");
    if (!value) return null;
    if (value.startsWith("//")) value = `https:${value}`;
    if (!/^https?:\/\//i.test(value)) {
      try { value = new URL(value, pageUrl).href; } catch { return null; }
    }
    return value;
  };
  // 1) og:image / twitter:image / image_src / itemprop=image
  const metaPatterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const pattern of metaPatterns) {
    const match = html.match(pattern);
    const resolved = match && resolve(match[1]);
    if (resolved) return resolved;
  }
  // 2) 常见电商图片 CDN（淘宝/天猫/京东/拼多多）— 从 HTML 中提取第一张商品大图
  const cdnPatterns = [
    /["']((?:https?:)?\/\/[^"']*?alicdn\.com\/[^"']+?\.(?:jpg|jpeg|png|webp))["']/i,
    /["']((?:https?:)?\/\/[^"']*?360buyimg\.com\/[^"']+?\.(?:jpg|jpeg|png|webp))["']/i,
    /["']((?:https?:)?\/\/[^"']*?yangkeduo\.com\/[^"']+?\.(?:jpg|jpeg|png|webp))["']/i,
    /["']((?:https?:)?\/\/[^"']*?cf\.cs\.cm\.econompic\.com\/[^"']+?\.(?:jpg|jpeg|png|webp))["']/i,
  ];
  for (const pattern of cdnPatterns) {
    const matches = html.match(new RegExp(pattern.source, "gi"));
    if (matches) {
      for (const m of matches) {
        const extracted = m.match(pattern);
        const resolved = extracted && resolve(extracted[1]);
      // 跳过太小的图标（通常 URL 含 _60x60q90 或类似尺寸标记）
        if (resolved && !/_\d+x\d+/.test(resolved)) return resolved;
      }
    }
  }
  return null;
}

// 检测是否为淘宝/天猫等中间页（提示"用浏览器打开"）
function isInterstitialPage(html) {
  return /用浏览器打开|手机淘宝|请在.*浏览器中打开|打开.*App/i.test(html);
}

// 从中间页 HTML 中提取真实商品页 URL（meta refresh / JS 跳转 / 链接）
function extractRealUrl(html, pageUrl) {
  // 1) <meta http-equiv="refresh" content="0; url=...">
  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']\d+;\s*url=([^"']+)["']/i);
  if (metaRefresh) {
    try { return new URL(metaRefresh[1].trim(), pageUrl).href; } catch { /* fallthrough */ }
  }
  // 2) JavaScript location.href / location.replace
  const jsRedirect = html.match(/(?:location\.href|location\.replace)\s*=\s*["']([^"']+)["']/i)
    || html.match(/window\.location\s*=\s*["']([^"']+)["']/i);
  if (jsRedirect) {
    try { return new URL(jsRedirect[1].trim(), pageUrl).href; } catch { /* fallthrough */ }
  }
  // 3) <a href="真实URL"> 标签中的链接（淘宝中间页常有"继续访问"链接）
  const continueLink = html.match(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/i);
  if (continueLink) return continueLink[1];
  return null;
}

export function featuresApi(options = {}) {
  let root;
  let dataDir;
  let tmpDir;
  let importedDir;
  let inspirationsDir;
  let looksDir;
  let libraryFile;
  let inspirationsFile;
  let looksFile;
  let modelReferencePath;
  const weatherCache = new Map();

  async function loadLibrary() {
    return readJson(libraryFile, []);
  }

  async function loadInspirations() {
    return readJson(inspirationsFile, []);
  }

  async function loadLooks() {
    return readJson(looksFile, []);
  }

  function lookPrompt(type, inspiration, userPrompt) {
    const typeLabel = typeof type === "string" && type.trim() ? type.trim() : "editorial";
    let prompt =
      `Create a professional horizontal 3:2 editorial fashion photograph of the person in the first image wearing the exact garments provided in the following images. ` +
      `Preserve the person's recognizable identity, face, hair, age and proportions. ` +
      `Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. ` +
      `Style the complete look coherently for a "${typeLabel}" context, using understated neutral supporting pieces where needed, realistic anatomy, natural light, authentic fabric, and a tasteful real-world setting with environmental space around the model. ` +
      `No text, watermark, product mockup, or synthetic appearance.`;
    if (inspiration) {
      const tags = Array.isArray(inspiration.styleTags) ? inspiration.styleTags.join("、") : "";
      const palette = Array.isArray(inspiration.palette) ? inspiration.palette.join(", ") : "";
      const summary = inspiration.summary ? `风格概要：${inspiration.summary}。` : "";
      prompt += `\n参考灵感：${[tags ? `风格标签 ${tags}` : "", palette ? `配色 ${palette}` : "", summary].filter(Boolean).join("；")}。`;
    }
    if (typeof userPrompt === "string" && userPrompt.trim()) {
      prompt += `\n用户补充方向：${userPrompt.trim().slice(0, 800)}`;
    }
    return prompt;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    if (
      !pathname.startsWith("/api/wardrobe/") &&
      !pathname.startsWith("/api/weather") &&
      !pathname.startsWith("/api/style/") &&
      !pathname.startsWith("/api/looks")
    ) {
      return next();
    }

    try {
      // ---- Weather ----
      if (pathname === "/api/weather/config" && req.method === "GET") {
        return json(res, 200, { qweather: Boolean(setting(options.env, "QWEATHER_KEY")) });
      }

      if (pathname === "/api/weather/cities" && req.method === "GET") {
        const key = setting(options.env, "QWEATHER_KEY");
        if (!key) return json(res, 200, { available: false });
        const q = url.searchParams.get("q") || "";
        if (!q.trim()) return json(res, 200, { available: true, cities: [] });
        const geoUrl = `${QWEATHER_GEO_BASE}/v2/city/lookup?key=${encodeURIComponent(key)}&location=${encodeURIComponent(q.trim())}`;
        const response = await fetch(geoUrl);
        const data = await response.json().catch(() => ({}));
        if (String(data.code || "") !== "200" || !Array.isArray(data.location)) {
          return json(res, 200, { available: true, cities: [] });
        }
        const cities = data.location.map((entry) => ({
          id: entry.id,
          name: entry.name,
          lat: entry.lat,
          lon: entry.lon,
          adm1: entry.adm1,
          adm2: entry.adm2,
          country: entry.country,
        }));
        return json(res, 200, { available: true, cities });
      }

      if (pathname === "/api/weather" && req.method === "GET") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return json(res, 400, { error: "lat and lon query parameters are required" });
        }
        const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
        const cached = weatherCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < WEATHER_CACHE_TTL) {
          return json(res, 200, cached.data);
        }
        const qweatherKey = setting(options.env, "QWEATHER_KEY");
        const data = qweatherKey
          ? await fetchQWeather(qweatherKey, lat, lon)
          : await fetchOpenMeteo(lat, lon);
        weatherCache.set(cacheKey, { ts: Date.now(), data });
        return json(res, 200, data);
      }

      // ---- Inspirations ----
      if (pathname === "/api/style/inspirations" && req.method === "POST") {
        const input = await body(req);
        const image = decodeImage(input);
        const normalized = await normalizeImage(image.data);
        const id = randomUUID();
        await mkdir(inspirationsDir, { recursive: true });
        await writeFile(path.join(inspirationsDir, `${id}.png`), normalized);
        const analysis = await openAIAnalyze(options.env, normalized, {
          prompt: STYLE_ANALYZE_PROMPT,
          schemaName: "style_inspiration",
          schema: STYLE_ANALYZE_SCHEMA,
        });
        const record = {
          id,
          note: typeof input.note === "string" ? input.note.trim().slice(0, 500) : "",
          styleTags: Array.isArray(analysis.styleTags) ? analysis.styleTags.slice(0, 5) : [],
          palette: Array.isArray(analysis.palette)
            ? analysis.palette.filter((hex) => typeof hex === "string" && HEX_COLOR.test(hex)).map((hex) => hex.toLowerCase()).slice(0, 5)
            : [],
          garments: Array.isArray(analysis.garments)
            ? analysis.garments.slice(0, 10).map((garment) => ({
                part: typeof garment.part === "string" ? garment.part.slice(0, 40) : "",
                color: typeof garment.color === "string" && HEX_COLOR.test(garment.color) ? garment.color.toLowerCase() : "#808080",
                description: typeof garment.description === "string" ? garment.description.slice(0, 200) : "",
              }))
            : [],
          summary: typeof analysis.summary === "string" ? analysis.summary.slice(0, 600) : "",
          liked: false,
          tags: [],
          image: `/api/style/assets/${id}.png`,
          createdAt: new Date().toISOString(),
        };
        const records = await loadInspirations();
        await atomicJson(inspirationsFile, [...records.filter((entry) => entry.id !== id), record]);
        return json(res, 201, record);
      }

      if (pathname === "/api/style/inspirations" && req.method === "GET") {
        const records = await loadInspirations();
        return json(res, 200, records);
      }

      const inspirationMatch = pathname.match(/^\/api\/style\/inspirations\/([a-f0-9-]{36})$/i);
      if (inspirationMatch) {
        const id = inspirationMatch[1];
        const records = await loadInspirations();
        const record = records.find((entry) => entry.id === id);
        if (!record) return json(res, 404, { error: "灵感图不存在" });
        if (req.method === "PATCH" || req.method === "PUT") {
          const input = await body(req);
          if (input.liked !== undefined) record.liked = Boolean(input.liked);
          if (typeof input.note === "string") record.note = input.note.trim().slice(0, 500);
          if (Array.isArray(input.tags)) {
            record.tags = input.tags
              .filter((tag) => typeof tag === "string")
              .map((tag) => tag.trim().slice(0, 40))
              .filter(Boolean)
              .slice(0, 12);
          }
          record.updatedAt = new Date().toISOString();
          await atomicJson(inspirationsFile, [...records.filter((entry) => entry.id !== id), record]);
          return json(res, 200, record);
        }
        if (req.method === "DELETE") {
          await atomicJson(inspirationsFile, records.filter((entry) => entry.id !== id));
          await rm(path.join(inspirationsDir, `${id}.png`), { force: true });
          return json(res, 200, { deleted: true, id });
        }
      }

      const styleAssetMatch = pathname.match(/^\/api\/style\/assets\/([\w.-]+)$/i);
      if (styleAssetMatch && req.method === "GET") {
        const file = path.join(inspirationsDir, safeBaseName(styleAssetMatch[1]));
        if (await serveImage(res, file)) return;
        return json(res, 404, { error: "图片不存在" });
      }

      // ---- Looks ----
      if (pathname === "/api/looks" && req.method === "GET") {
        const type = url.searchParams.get("type");
        const inspirationId = url.searchParams.get("inspirationId");
        let records = await loadLooks();
        if (type) records = records.filter((record) => record.type === type);
        if (inspirationId) records = records.filter((record) => record.inspirationId === inspirationId);
        return json(res, 200, records);
      }

      if (pathname === "/api/looks/generate" && req.method === "POST") {
        const input = await body(req);
        const type = typeof input.type === "string" ? input.type : "editorial";
        const garmentIds = Array.isArray(input.garmentIds)
          ? input.garmentIds.filter((id) => typeof id === "string").slice(0, 8)
          : [];
        if (!garmentIds.length) return json(res, 400, { error: "请选择至少一件衣物" });

        const tryonModel = setting(options.env, "OPENAI_TRYON_MODEL", "") || setting(options.env, "OPENAI_IMAGE_MODEL", "");
        if (!tryonModel) {
          return json(res, 503, { error: "试穿图生成模型未配置：请在 .env 中设置 OPENAI_TRYON_MODEL（如 doubao-seedream-5-0-flash-260915）并在 Ark 控制台开通" });
        }

        let modelData;
        try {
          modelData = await readFile(modelReferencePath);
        } catch (error) {
          if (error.code === "ENOENT") {
            return json(res, 503, { error: "请先在衣橱页上传你的人像参考照片，再生成试穿图" });
          }
          throw error;
        }
        const library = await loadLibrary();
        const garments = [];
        const missing = [];
        for (const garmentId of garmentIds) {
          const record = library.find((entry) => entry.id === garmentId);
          if (!record) return json(res, 404, { error: `衣橱中未找到该衣物: ${garmentId}` });
          const fileName = path.basename(new URL(record.image, "http://localhost").pathname);
          const filePath = path.join(importedDir, fileName);
          let garmentData;
          try {
            garmentData = await readFile(filePath);
          } catch (error) {
            if (error.code === "ENOENT") { missing.push(garmentId); continue; }
            throw error;
          }
          garments.push({ data: garmentData, mime: "image/png", name: `${garmentId}.png` });
        }
        if (missing.length) return json(res, 404, { error: `${missing.length} 件衣物图片文件缺失，请重新导入: ${missing.join(", ")}` });
        if (!garments.length) return json(res, 400, { error: "没有可用的衣物图片" });

        let inspiration = null;
        if (typeof input.inspirationId === "string" && input.inspirationId) {
          const inspirations = await loadInspirations();
          inspiration = inspirations.find((entry) => entry.id === input.inspirationId) || null;
          if (!inspiration) return json(res, 404, { error: "灵感图不存在" });
        }

        const prompt = lookPrompt(type, inspiration, input.prompt);
        const bytes = await openAIEdit(options.env, {
          model: tryonModel,
          prompt,
          images: [{ data: modelData, mime: "image/png", name: "model.png" }, ...garments],
          size: "1536x1024",
        });
        const id = randomUUID();
        await mkdir(looksDir, { recursive: true });
        await writeFile(path.join(looksDir, `${id}.png`), bytes);
        const record = {
          id,
          type,
          garmentIds,
          inspirationId: inspiration ? inspiration.id : null,
          prompt,
          image: `/api/looks/assets/${id}.png`,
          createdAt: new Date().toISOString(),
        };
        const records = await loadLooks();
        await atomicJson(looksFile, [...records, record]);
        return json(res, 201, record);
      }

      const looksAssetMatch = pathname.match(/^\/api\/looks\/assets\/([\w.-]+)$/i);
      if (looksAssetMatch && req.method === "GET") {
        const file = path.join(looksDir, safeBaseName(looksAssetMatch[1]));
        if (await serveImage(res, file)) return;
        return json(res, 404, { error: "图片不存在" });
      }

      const lookMatch = pathname.match(/^\/api\/looks\/([a-f0-9-]{36})$/i);
      if (lookMatch && req.method === "DELETE") {
        const id = lookMatch[1];
        const records = await loadLooks();
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "Look not found" });
        await atomicJson(looksFile, next);
        await rm(path.join(looksDir, `${id}.png`), { force: true });
        return json(res, 200, { deleted: true, id });
      }

      // ---- Link import ----
      if (pathname === "/api/wardrobe/link-analyze" && req.method === "POST") {
        const input = await body(req);
        const rawInput = typeof input.sourceUrl === "string" ? input.sourceUrl
          : typeof input.url === "string" ? input.url : "";
        // 从分享文本中提取 URL（支持"【淘宝】https://m.tb.cn/h.xxx CZ0001 「标题」"等格式）
        let urlMatch = rawInput.match(/https?:\/\/[^\s"'<>\[\]【】「」、，。；！？]+/i);
        // 兜底：用户可能粘贴不带 https:// 的域名（如 m.tb.cn/h.xxx）
        if (!urlMatch) {
          const bareMatch = rawInput.match(/(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s"'<>\[\]【】「」、，。；！？]+/i);
          if (bareMatch) urlMatch = [`https://${bareMatch[0]}`];
        }
        const sourceUrl = urlMatch ? urlMatch[0].replace(/[),.;!?，。；！？）」』】]+$/, "") : "";
        if (!HTTP_URL.test(sourceUrl)) {
          return json(res, 400, { error: "未识别到有效链接，请粘贴商品链接或分享文本（需以 http:// 或 https:// 开头）" });
        }
        let imageData;
        if (input.imageDataUrl && typeof input.imageDataUrl === "string") {
          imageData = decodeImage(input);
        } else {
          // 服务端从 URL 抓取图片（避免浏览器 CORS 限制）
          try {
            // 使用桌面端 UA，避免淘宝等返回"用浏览器打开"中间页
            const desktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
            const pageResp = await fetch(sourceUrl, {
              redirect: "follow",
              headers: {
                "User-Agent": desktopUA,
                "Accept": "text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9",
              },
            });
            if (!pageResp.ok) return json(res, 400, { error: `链接无法访问（HTTP ${pageResp.status}），部分电商页面需要登录，请直接上传商品图片` });
            const contentType = pageResp.headers.get("content-type") || "";
            if (contentType.includes("text/html")) {
              let html = (await pageResp.text()).slice(0, 1024 * 1024);
              let finalUrl = pageResp.url || sourceUrl;
              // 检测淘宝/天猫中间页，尝试提取真实 URL 并二次抓取
              if (isInterstitialPage(html)) {
                const realUrl = extractRealUrl(html, finalUrl);
                if (realUrl && realUrl !== finalUrl) {
                  const retryResp = await fetch(realUrl, {
                    redirect: "follow",
                    headers: {
                      "User-Agent": desktopUA,
                      "Accept": "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
                      "Accept-Language": "zh-CN,zh;q=0.9",
                    },
                  });
                  if (retryResp.ok && (retryResp.headers.get("content-type") || "").includes("text/html")) {
                    html = (await retryResp.text()).slice(0, 1024 * 1024);
                    finalUrl = retryResp.url || realUrl;
                  }
                }
              }
              // 从 HTML 提取商品主图
              const imageUrl = extractProductImage(html, finalUrl);
              if (!imageUrl) {
                return json(res, 422, { error: "未能从商品页提取主图（淘宝/天猫等页面需登录或 JavaScript 渲染），请直接上传商品图片" });
              }
              const imgResp = await fetch(imageUrl, {
                redirect: "follow",
                headers: { "User-Agent": desktopUA, "Referer": finalUrl },
              });
              if (!imgResp.ok) return json(res, 400, { error: `商品主图下载失败（${imgResp.status}），请直接上传商品图片` });
              const buf = Buffer.from(await imgResp.arrayBuffer());
              imageData = { data: buf, mime: imgResp.headers.get("content-type") || "image/jpeg" };
            } else if (contentType.startsWith("image/")) {
              // 直接是图片 URL
              const buf = Buffer.from(await pageResp.arrayBuffer());
              imageData = { data: buf, mime: contentType || "image/jpeg" };
            } else {
              return json(res, 422, { error: "链接内容不是图片或商品页，请直接上传商品图片" });
            }
          } catch (fetchErr) {
            return json(res, 400, { error: `无法访问链接：${fetchErr.message}，请直接上传商品图片` });
          }
        }
        const normalized = await normalizeImage(imageData.data);
        const token = randomUUID();
        await mkdir(tmpDir, { recursive: true });
        await writeFile(path.join(tmpDir, `${token}.png`), normalized);
        const previewUrl = `/api/wardrobe/tmp/${token}.png`;
        const analysis = await openAIAnalyze(options.env, normalized);
        const items = Array.isArray(analysis.items) ? analysis.items : [];
        if (!items.length) {
          // 返回抓取到的预览图，让用户看到后手动上传或换链接
          return json(res, 200, { noClothingDetected: true, token, previewUrl, sourceUrl, message: "从链接抓取的图片中未识别到衣物（可能是页面图标、登录页或非衣物图），请直接上传商品图片" });
        }
        const normalizedItems = items.map((item) => normalizeMetadata(item));
        const first = normalizedItems[0];
        const draft = {
          ...first,
          name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : first.name,
        };
        return json(res, 200, {
          token,
          previewUrl: `/api/wardrobe/tmp/${token}.png`,
          draft: {
            name: draft.name,
            part: draft.part,
            subtype: draft.subtype,
            color: draft.color,
            secondaryColor: draft.secondaryColor,
            tags: draft.tags,
            season: draft.season,
            boundingBox: draft.boundingBox,
          },
          candidates: normalizedItems.map((item, index) => ({ ...item, index })),
          sourceUrl,
        });
      }

      if (pathname === "/api/wardrobe/link-commit" && req.method === "POST") {
        const input = await body(req);
        const token = typeof input.token === "string" ? input.token : "";
        if (!/^[a-f0-9-]{36}$/i.test(token)) return json(res, 400, { error: "无效的令牌" });
        const sourceUrl = typeof input.sourceUrl === "string" ? input.sourceUrl.trim() : "";
        const meta = normalizeMetadata(input.metadata || {});
        const tmpFile = path.join(tmpDir, `${token}.png`);
        try {
          await stat(tmpFile);
        } catch (error) {
          if (error.code === "ENOENT") return json(res, 404, { error: "令牌已过期或不存在" });
          throw error;
        }
        const id = `link-${randomUUID()}`;
        await mkdir(importedDir, { recursive: true });
        const targetFile = path.join(importedDir, `${id}.png`);
        // 按用户确认的 boundingBox 裁剪出单件衣物并去除背景，衣橱只保留单件衣物抠图
        const cropped = await cropDetectedItem(await readFile(tmpFile), meta.boundingBox);
        const cutout = await removeBackgroundLocally(cropped, meta.color);
        await writeFile(targetFile, cutout);
        const record = {
          id,
          name: meta.name,
          part: meta.part,
          subtype: meta.subtype,
          color: meta.color,
          secondaryColor: meta.secondaryColor,
          palette: [meta.color, meta.secondaryColor].filter(Boolean),
          tags: meta.tags,
          season: meta.season,
          image: `${LIBRARY_ASSET_ROOT}/${id}.png`,
          thumbnail: `${LIBRARY_ASSET_ROOT}/${id}.png`,
          sourceUrl: sourceUrl || null,
          createdAt: new Date().toISOString(),
        };
        const records = await loadLibrary();
        const next = [...records.filter((entry) => entry.id !== id), record];
        await atomicJson(libraryFile, next);
        await rm(tmpFile, { force: true });
        return json(res, 201, record);
      }

      if (pathname === "/api/wardrobe/link-cancel" && req.method === "POST") {
        const input = await body(req);
        const token = typeof input.token === "string" ? input.token : "";
        if (!/^[a-f0-9-]{36}$/i.test(token)) return json(res, 400, { error: "无效的令牌" });
        await rm(path.join(tmpDir, `${token}.png`), { force: true });
        return json(res, 200, { canceled: true, token });
      }

      const tmpAssetMatch = pathname.match(/^\/api\/wardrobe\/tmp\/([\w.-]+)$/i);
      if (tmpAssetMatch && req.method === "GET") {
        const file = path.join(tmpDir, safeBaseName(tmpAssetMatch[1]));
        if (await serveImage(res, file)) return;
        return json(res, 404, { error: "Temporary asset not found" });
      }

      const linkItemMatch = pathname.match(/^\/api\/wardrobe\/items\/(link-[a-f0-9-]{36})$/i);
      if (linkItemMatch && req.method === "DELETE") {
        const id = linkItemMatch[1];
        if (!LINK_ID.test(id)) return json(res, 400, { error: "无效的商品 ID" });
        const records = await loadLibrary();
        const next = records.filter((entry) => entry.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "衣物不存在" });
        await atomicJson(libraryFile, next);
        await rm(path.join(importedDir, `${id}.png`), { force: true });
        return json(res, 200, { deleted: true, id });
      }

      return json(res, 404, { error: "未找到" });
    } catch (error) {
      console.error("[features-api] error:", error);
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, statusCode, {
        error: statusCode === 500 ? `服务错误: ${error.message}` : error.message,
      });
    }
  }

  return {
    name: "wardrobe-features-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting(options.env, "WARDROBE_DATA_DIR", "data"));
      tmpDir = path.join(dataDir, "tmp");
      importedDir = path.join(dataDir, "imported");
      inspirationsDir = path.join(dataDir, "inspirations");
      looksDir = path.join(dataDir, "looks");
      libraryFile = path.join(dataDir, "library.json");
      inspirationsFile = path.join(inspirationsDir, "library.json");
      looksFile = path.join(dataDir, "looks.json");
      modelReferencePath = path.resolve(root, setting(options.env, "WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
      await Promise.all([
        mkdir(tmpDir, { recursive: true }),
        mkdir(importedDir, { recursive: true }),
        mkdir(inspirationsDir, { recursive: true }),
        mkdir(looksDir, { recursive: true }),
      ]);
      await cleanupTmpDir(tmpDir);
    },
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
