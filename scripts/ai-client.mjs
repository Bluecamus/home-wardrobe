import sharp from "sharp";

const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const SEASONS = new Set(["spring", "summer", "autumn", "winter"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function setting(env, name, fallback = "") {
  const fromEnv = env?.[name];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromProcess = process.env[name];
  return fromProcess !== undefined && fromProcess !== "" ? fromProcess : fallback;
}

function apiBaseUrl(env) {
  return setting(env, "OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
}

async function normalizeImage(bytes) {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

// 本地背景去除（无需图像生成模型）：从边缘采样背景色，flood-fill 移除连通背景，输出透明 PNG 抠图
export async function removeBackgroundLocally(bytes, garmentColorHex) {
  try {
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height || width < 8 || height < 8) {
      return sharp(bytes).ensureAlpha().png().toBuffer();
    }

    // 限制处理尺寸（最大边 768px），避免大图 flood-fill 过慢
    const maxDim = 768;
    let procW = width;
    let procH = height;
    if (Math.max(width, height) > maxDim) {
      const ratio = maxDim / Math.max(width, height);
      procW = Math.max(1, Math.round(width * ratio));
      procH = Math.max(1, Math.round(height * ratio));
    }

    // 用 fit: "fill" 强制精确尺寸，确保 procW/procH 与 raw.info 一致
    const raw = await sharp(bytes, { failOn: "none" })
      .rotate()
      .toColorspace("srgb")
      .resize(procW, procH, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const data = raw.data;
    const channels = raw.info.channels;
    // 使用 raw.info 的实际尺寸做索引（fit:"fill" 下应与 procW/procH 一致）
    const W = raw.info.width;
    const H = raw.info.height;

    // 从衣物的 hex 颜色解析出 RGB（作为保护色，避免误删衣物像素）
    const garmentRGB = hexToRGB(garmentColorHex);

    // 采样四条边像素，统计背景色（出现最多的桶）
    const buckets = new Map();
    const sampleBorder = (x, y) => {
      const offset = (y * W + x) * channels;
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      const key = `${Math.round(r / 24)}-${Math.round(g / 24)}-${Math.round(b / 24)}`;
      const entry = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
      entry.r += r; entry.g += g; entry.b += b; entry.count += 1;
      buckets.set(key, entry);
    };
    for (let x = 0; x < W; x++) { sampleBorder(x, 0); sampleBorder(x, H - 1); }
    for (let y = 0; y < H; y++) { sampleBorder(0, y); sampleBorder(W - 1, y); }
    let bgEntry = null;
    for (const entry of buckets.values()) {
      if (!bgEntry || entry.count > bgEntry.count) bgEntry = entry;
    }
    if (!bgEntry) return sharp(bytes).ensureAlpha().png().toBuffer();
    const bgR = Math.round(bgEntry.r / bgEntry.count);
    const bgG = Math.round(bgEntry.g / bgEntry.count);
    const bgB = Math.round(bgEntry.b / bgEntry.count);

    // 容差：背景色相似度阈值（越大越激进）
    const tolerance = 52;
    // 如果保护色与背景色接近，减小容差避免误删衣物
    let effectiveTolerance = tolerance;
    if (garmentRGB) {
      const dist = colorDelta(bgR, bgG, bgB, garmentRGB.r, garmentRGB.g, garmentRGB.b);
      if (dist < 80) effectiveTolerance = Math.max(20, dist * 0.4);
    }

    // flood-fill from edges using typed-array stack
    const total = W * H;
    const visited = new Uint8Array(total);
    const stackX = new Int32Array(total);
    const stackY = new Int32Array(total);
    let sp = 0;

    const isBackground = (x, y) => {
      const offset = (y * W + x) * channels;
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      return colorDelta(r, g, b, bgR, bgG, bgB) < effectiveTolerance;
    };

    // seed: all border pixels that match background
    for (let x = 0; x < W; x++) {
      if (isBackground(x, 0)) { stackX[sp] = x; stackY[sp] = 0; sp++; }
      if (isBackground(x, H - 1)) { stackX[sp] = x; stackY[sp] = H - 1; sp++; }
    }
    for (let y = 0; y < H; y++) {
      if (isBackground(0, y)) { stackX[sp] = 0; stackY[sp] = y; sp++; }
      if (isBackground(W - 1, y)) { stackX[sp] = W - 1; stackY[sp] = y; sp++; }
    }

    // DFS flood-fill
    while (sp > 0) {
      sp--;
      const x = stackX[sp];
      const y = stackY[sp];
      const idx = y * W + x;
      if (visited[idx]) continue;
      visited[idx] = 1;
      if (!isBackground(x, y)) continue;
      // set alpha to 0
      data[idx * channels + 3] = 0;
      // push neighbors
      if (x > 0 && !visited[idx - 1]) { stackX[sp] = x - 1; stackY[sp] = y; sp++; }
      if (x < W - 1 && !visited[idx + 1]) { stackX[sp] = x + 1; stackY[sp] = y; sp++; }
      if (y > 0 && !visited[idx - W]) { stackX[sp] = x; stackY[sp] = y - 1; sp++; }
      if (y < H - 1 && !visited[idx + W]) { stackX[sp] = x; stackY[sp] = y + 1; sp++; }
    }

    // 第二轮：采样中心区域衣物色板（3 个主色），用于保护衣物像素不被误删
    const palette = sampleCenterPalette(data, W, H, channels, garmentRGB);

    // 第三轮：遍历所有剩余不透明像素，移除皮肤色和非衣物色
    // - 皮肤色检测（穿在人身上的衣物，需移除露出的皮肤）
    // - 非衣物色检测（裁剪框内可能包含的相邻衣物/杂物）
    const maxGarmentDist = 140;  // 衣物色板匹配容差（宽泛，保留花纹/纹理）
    const farDist = 190;         // 超过此距离视为非衣物像素（移除相邻衣物/杂物）
    for (let idx = 0; idx < total; idx++) {
      const offset = idx * channels;
      if (data[offset + 3] === 0) continue; // 已透明，跳过
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      // 是否匹配衣物色板
      const matchesPalette = palette.some((p) => colorDelta(r, g, b, p.r, p.g, p.b) < maxGarmentDist);
      if (matchesPalette) continue; // 衣物像素，保留
      // 皮肤色检测
      if (isSkinTone(r, g, b)) { data[offset + 3] = 0; continue; }
      // 距离衣物色极远 → 移除（相邻衣物、杂物）
      if (garmentRGB && colorDelta(r, g, b, garmentRGB.r, garmentRGB.g, garmentRGB.b) > farDist) {
        data[offset + 3] = 0; continue;
      }
    }

    // 第四轮：边缘羽化 — 对透明/不透明边界的像素做半透明过渡
    featherEdges(data, W, H, channels);

    // 重建抠图：直接输出透明背景 PNG（不 resize/trim，避免丢失 alpha 通道）
    const cutout = await sharp(data, { raw: { width: W, height: H, channels } })
      .png()
      .toBuffer();
    return cutout;
  } catch (error) {
    // 抠图失败时回退到原图（保证导入流程不中断）
    console.warn("[removeBackgroundLocally] failed, fallback to original:", error.message);
    return sharp(bytes).ensureAlpha().png().toBuffer();
  }
}

function hexToRGB(hex) {
  if (typeof hex !== "string") return null;
  const match = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const v = parseInt(match[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function colorDelta(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// 皮肤色检测：常见 RGB 肤值法，覆盖各肤色
function isSkinTone(r, g, b) {
  if (r < 50 || r > 250) return false;
  if (!(r > g && g > b)) {
    // 某些深肤色不满足 r>g>b，放宽条件
    if (!(r > g && g >= b - 15)) return false;
  }
  if (r - g < 8) return false;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) return false;
  if (r < 95 && g < 40 && b < 20) return false;
  // 排除纯白/灰白（衣物常见）
  if (r > 230 && g > 220 && b > 210) return false;
  // 排除纯黑
  if (r < 30 && g < 30 && b < 30) return false;
  return true;
}

// 采样中心区域衣物色板：取图像中心 50%×50% 区域，统计出现最多的 3 个颜色桶
function sampleCenterPalette(data, W, H, channels, fallback) {
  const x0 = Math.floor(W * 0.25);
  const x1 = Math.floor(W * 0.75);
  const y0 = Math.floor(H * 0.25);
  const y1 = Math.floor(H * 0.75);
  const buckets = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * W + x) * channels;
      if (data[offset + 3] === 0) continue; // 跳过透明像素
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      // 更粗的桶（32 级），合并相近颜色
      const key = `${Math.round(r / 32)}-${Math.round(g / 32)}-${Math.round(b / 32)}`;
      const entry = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
      entry.r += r; entry.g += g; entry.b += b; entry.count += 1;
      buckets.set(key, entry);
    }
  }
  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  const palette = ranked.map((e) => ({
    r: Math.round(e.r / e.count),
    g: Math.round(e.g / e.count),
    b: Math.round(e.b / e.count),
  }));
  // 加入 AI 检测色作为保底
  if (fallback && !palette.some((p) => colorDelta(p.r, p.g, p.b, fallback.r, fallback.g, fallback.b) < 60)) {
    palette.push(fallback);
  }
  return palette;
}

// 边缘羽化：对透明↔不透明边界的像素做半透明过渡，减少锯齿
function featherEdges(data, W, H, channels) {
  const isTransparent = (idx) => data[idx * channels + 3] === 0;
  const isOpaque = (idx) => data[idx * channels + 3] === 255;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!isOpaque(idx)) continue; // 只处理完全不透明像素
      // 检查 4 邻居是否有透明像素
      let hasTransparentNeighbor = false;
      if (x > 0 && isTransparent(idx - 1)) hasTransparentNeighbor = true;
      if (x < W - 1 && isTransparent(idx + 1)) hasTransparentNeighbor = true;
      if (y > 0 && isTransparent(idx - W)) hasTransparentNeighbor = true;
      if (y < H - 1 && isTransparent(idx + W)) hasTransparentNeighbor = true;
      if (hasTransparentNeighbor) {
        data[idx * channels + 3] = 128; // 半透明
      }
    }
  }
}



async function prepareAnalysisImage(bytes) {
  const image = sharp(bytes, { failOn: "none" }).rotate();
  const meta = await image.metadata();
  const maxDim = 1280;
  let width = meta.width || 0;
  let height = meta.height || 0;
  if (width > maxDim || height > maxDim) {
    const ratio = Math.min(maxDim / width, maxDim / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }
  return image
    .resize(width || undefined, height || undefined, { fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

const WARDROBE_ANALYZE_PROMPT =
  "识别图片中每一件可穿着的衣物。图片可能是以下任一情况：1）单件衣物平铺图或商品图；2）真人穿着多件衣物的穿搭照（用户自己拍的实物照）；3）模特穿搭图。无论哪种情况，都必须逐件识别图中所有可穿戴的衣物。对于真人穿搭照，衣服穿在人身上也要识别——边界框应紧贴该衣物的可见区域（不必是整件平铺），例如上装的框从领口到下摆、袖口到袖口，下装的框从腰头到裤脚。每件应进入衣橱的实际单品返回一条记录，忽略人物身体本身和不可穿戴的背景物品。每件单品给出紧贴该物品可见区域的边界框，坐标为 1000x1000 归一化整数：x、y 为左上角，随后是宽和高。衣物重叠时边界框可重叠，但每个框只聚焦一件单品。品类 id 只能使用：upperbody（上装，包含T恤/衬衫/卫衣/毛衣等）、wholebody_up（连体衣/外套/大衣）、lowerbody（下装）、accessories_up（配饰）、shoes（鞋履）。subtype 字段必须使用中文细分品类，从以下词表中选择最贴切的一个：T恤、衬衫、卫衣、毛衣、外套、大衣、连衣裙、半身裙、牛仔裤、休闲裤、短裤、运动鞋、皮鞋、靴子、帽子、围巾、包、其他。name 字段必须使用简洁具体的中文名称（如\u201C白色棉质短袖衬衫\u201D），严禁使用英文名称，如果图片上有英文标签请忽略，必须用中文描述。tags 必须使用中文标签（如\u201C通勤\u201D\u201C纯棉\u201D\u201C短袖\u201D），给出主色 hex、可选的明显不同的辅色 hex、1-4 个中文标签，以及适合的季节（spring/summer/autumn/winter，可多选）。";

const WARDROBE_ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] },
          subtype: { type: "string" },
          color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] },
          tags: { type: "array", items: { type: "string" }, maxItems: 4 },
          season: {
            type: "array",
            items: { type: "string", enum: ["spring", "summer", "autumn", "winter"] },
            maxItems: 4,
            uniqueItems: true,
          },
          boundingBox: {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "integer", minimum: 0, maximum: 999 },
              y: { type: "integer", minimum: 0, maximum: 999 },
              width: { type: "integer", minimum: 1, maximum: 1000 },
              height: { type: "integer", minimum: 1, maximum: 1000 },
            },
            required: ["x", "y", "width", "height"],
          },
        },
        required: ["name", "part", "subtype", "color", "secondaryColor", "tags", "season", "boundingBox"],
      },
    },
  },
  required: ["items"],
};

function toImageDataUrl(imageDataUrl, fallbackMime = "image/png") {
  if (Buffer.isBuffer(imageDataUrl)) {
    return { mime: fallbackMime, base64: imageDataUrl.toString("base64") };
  }
  if (typeof imageDataUrl !== "string" || !imageDataUrl.trim()) {
    throw Object.assign(new Error("imageDataUrl is required"), { status: 400 });
  }
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) return { mime: match[1], base64: match[2] };
  return { mime: fallbackMime, base64: imageDataUrl.trim() };
}

// 检测是否为火山引擎 Ark（或其他 chat/completions 兼容平台）
function isArkProvider(env) {
  const url = apiBaseUrl(env);
  return /volces\.com|ark|aliyuncs\.com|deepseek/i.test(url) || setting(env, "OPENAI_API_MODE") === "chat";
}

// Ark 常见错误中文化
function arkErrorMessage(result, status, model) {
  const message = result?.error?.message || `请求失败 (${status})`;
  const code = result?.error?.code || "";
  if (code === "ModelNotOpen" || /ModelNotOpen/i.test(message)) {
    return `模型 ${model} 未开通，请到火山引擎 Ark 控制台开通后重试`;
  }
  if (code === "SetLimitExceeded" || /SetLimitExceeded/i.test(message)) {
    return `模型 ${model} 调用限额已暂停，请到 Ark 控制台调整限额后重试`;
  }
  if (/ModelNotExist|NotFound|does not exist/i.test(code + message)) {
    return `模型 ${model} 不存在，请检查模型名称配置`;
  }
  return message;
}

// Ark seedream 尺寸要求：各边需在 [1280, 4096] 内，按比例缩放映射
function arkImageSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size || ""));
  if (!match) return "2048x2048";
  let width = Number(match[1]);
  let height = Number(match[2]);
  const upscale = Math.max(1, 1280 / width, 1280 / height);
  width *= upscale;
  height *= upscale;
  const downscale = Math.min(1, 4096 / width, 4096 / height);
  width = Math.round((width * downscale) / 8) * 8;
  height = Math.round((height * downscale) / 8) * 8;
  return `${width}x${height}`;
}

// 按 1000 归一化 boundingBox 裁剪单件衣物（带边距）
// 调用方应传入已 normalizeImage 过的 PNG Buffer（避免每次裁剪都重新编码）
export async function cropDetectedItem(bytes, boundingBox) {
  const meta = await sharp(bytes, { failOn: "none" }).metadata();
  let width = meta.width || 0;
  let height = meta.height || 0;
  let source = bytes;
  if (!width || !height) {
    // 元数据缺失时退回 normalizeImage 重读
    source = await normalizeImage(bytes);
    const remeta = await sharp(source).metadata();
    width = remeta.width || 0;
    height = remeta.height || 0;
  }
  if (!width || !height) throw new Error("无法读取图片尺寸");
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  return sharp(source).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

// 从模型输出中稳健提取 JSON（兼容 markdown 包裹、前后解释文字等）
function parseModelJson(outputText) {
  let cleaned = String(outputText).trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // 尝试截取第一个 { 到最后一个 } 之间的内容
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // fallthrough
      }
    }
    throw new Error(`视觉识别返回的内容不是有效 JSON：${cleaned.slice(0, 200)}`);
  }
}

export async function openAIAnalyze(env, imageDataUrl, options = {}) {
  const key = setting(env, "OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY 未配置");
  const baseUrl = apiBaseUrl(env);
  const model = options.model || setting(env, "OPENAI_VISION_MODEL", "gpt-5.4-mini");
  const prompt = typeof options.prompt === "string" && options.prompt.trim()
    ? options.prompt
    : WARDROBE_ANALYZE_PROMPT;
  const schemaName = options.schemaName || "wardrobe_items";
  const schema = options.schema || WARDROBE_ANALYZE_SCHEMA;
  const { mime: srcMime, base64: srcBase64 } = toImageDataUrl(imageDataUrl, options.mime);
  if (!srcBase64) throw Object.assign(new Error("图片数据为空"), { status: 400 });

  // 压缩图片再发 AI：长边 1280px + JPEG q85，base64 体积约为原图 1/4~1/6，明显加快响应
  let mime = srcMime;
  let base64 = srcBase64;
  try {
    const rawBytes = Buffer.from(srcBase64, "base64");
    const compressed = await prepareAnalysisImage(rawBytes);
    mime = "image/jpeg";
    base64 = compressed.toString("base64");
  } catch (error) {
    // 压缩失败时退回原图，保证识别可用
    console.warn("[ai-client] prepareAnalysisImage failed, fallback to original:", error.message);
  }

  const useChatMode = isArkProvider(env);

  if (useChatMode) {
    // 火山引擎 Ark / OpenAI chat/completions 模式
    const instructPrompt = `${prompt}\n\n请严格按照以下 JSON Schema 返回结果，不要输出任何其他内容：\n${JSON.stringify(schema)}`;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "你是一个专业的服装识别助手。你的所有输出必须使用简体中文。衣物名称、标签、细分品类等所有文本字段严禁使用英文，必须翻译为中文。例如：不要输出\"cream pleated button-up shirt\"，必须输出\"奶油色褶皱纽扣衬衫\"；不要输出\"pleated\"，必须输出\"褶皱\"；不要输出\"lightweight\"，必须输出\"轻薄\"。只要图片中有人物或穿着衣物的场景，你都必须至少识别出 1 件可穿戴的衣物——即使是真人穿搭照、手机随手拍的实物照，也要逐件识别上衣、裤子、外套、鞋等。严禁返回空数组。只输出 JSON，不要输出任何解释文字。",
          },
          {
            role: "user",
            content: [
              { type: "text", text: instructPrompt },
              { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 4096,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(arkErrorMessage(result, response.status, model));
    const outputText = result.choices?.[0]?.message?.content;
    if (!outputText) throw new Error("视觉识别返回了空结果");
    return parseModelJson(outputText);
  }

  // OpenAI Responses API 模式
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: `data:${mime};base64,${base64}` },
          ],
        },
      ],
      text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI analysis failed (${response.status})`);
  const outputText =
    result.output_text ||
    result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI 返回了空结果");
  return JSON.parse(outputText);
}

export async function openAIEdit(env, options = {}) {
  const key = setting(env, "OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY 未配置");
  const baseUrl = apiBaseUrl(env);
  const model = options.model || setting(env, "OPENAI_IMAGE_MODEL", "gpt-image-2");
  const prompt = options.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw Object.assign(new Error("请输入图像生成提示词"), { status: 400 });
  }
  const images = Array.isArray(options.images) ? options.images : [];
  if (!images.length) throw Object.assign(new Error("至少需要一张参考图"), { status: 400 });

  // 火山引擎 Ark：seedream 图像生成走 /images/generations（JSON body，参考图用 image 字段）
  if (isArkProvider(env)) {
    const imageUrls = [];
    for (const image of images) {
      if (!image?.data) throw Object.assign(new Error("每张图必须包含数据"), { status: 400 });
      const normalized = await normalizeImage(image.data);
      imageUrls.push(`data:image/png;base64,${normalized.toString("base64")}`);
    }
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        image: imageUrls.length > 1 ? imageUrls : imageUrls[0],
        size: arkImageSize(options.size),
        response_format: "url",
        watermark: false,
        stream: false,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(arkErrorMessage(result, response.status, model));
    // 兼容 b64_json 和 url 两种响应格式
    const data = result.data?.[0];
    if (data?.b64_json) return Buffer.from(data.b64_json, "base64");
    if (data?.url) {
      const imgResp = await fetch(data.url);
      if (!imgResp.ok) throw new Error(`下载生成图片失败 (${imgResp.status})`);
      return Buffer.from(await imgResp.arrayBuffer());
    }
    throw new Error("图像生成返回了空结果");
  }

  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", options.size || "1024x1024");
  form.set("quality", options.quality || setting(env, "OPENAI_IMAGE_QUALITY", "high"));
  form.set("output_format", "png");
  if (options.background) form.set("background", options.background);
  for (const [index, image] of images.entries()) {
    if (!image?.data) throw Object.assign(new Error("Each image must include a data buffer"), { status: 400 });
    const normalized = await normalizeImage(image.data);
    const name = (image.name || `image-${index + 1}`).replace(/\.[^.]+$/, ".png");
    form.append("image[]", new Blob([normalized], { type: "image/png" }), name);
  }

  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("图像生成返回了空结果");
  return Buffer.from(encoded, "base64");
}

// 常见英文服装词汇 → 中文映射，用于兜底翻译 AI 残留的英文名称和标签
const EN_ZH_CLOTHING = {
  shirt: "衬衫", tshirt: "T恤", tee: "T恤", blouse: "衬衫", sweater: "毛衣",
  hoodie: "卫衣", jacket: "外套", coat: "大衣", blazer: "西装外套",
  pants: "长裤", trousers: "长裤", jeans: "牛仔裤", shorts: "短裤",
  skirt: "半身裙", dress: "连衣裙", suit: "套装",
  shoes: "鞋子", sneakers: "运动鞋", boots: "靴子", heels: "高跟鞋",
  hat: "帽子", cap: "帽子", scarf: "围巾", bag: "包", belt: "腰带",
  white: "白色", black: "黑色", gray: "灰色", grey: "灰色",
  red: "红色", blue: "蓝色", green: "绿色", yellow: "黄色",
  brown: "棕色", pink: "粉色", orange: "橙色", purple: "紫色",
  cream: "奶油色", beige: "米色", navy: "藏青色", khaki: "卡其色",
  olive: "橄榄色", burgundy: "酒红色", tan: "棕褐色", ivory: "象牙白",
  long: "长款", short: "短款", sleeve: "袖", collar: "领",
  cotton: "棉质", linen: "亚麻", wool: "羊毛", silk: "丝绸",
  leather: "皮", denim: "牛仔", knit: "针织", pleated: "褶皱",
  button: "纽扣", zip: "拉链", hooded: "连帽", vneck: "V领",
  round: "圆领", striped: "条纹", solid: "纯色", casual: "休闲",
  formal: "正装", slim: "修身", loose: "宽松", oversized: "廓形",
  lightweight: "轻薄", breathable: "透气", stretchy: "弹力", wrinkle: "抗皱",
  "button-up": "纽扣", "v-neck": "V领", "t-shirt": "T恤", "long-sleeve": "长袖",
  "short-sleeve": "短袖", "sleeveless": "无袖", "high-waist": "高腰",
  "low-waist": "低腰", "straight": "直筒", "flared": "喇叭", "cropped": "短款",
  fleece: "摇粒绒", polyester: "聚酯纤维", canvas: "帆布", suede: "反绒皮",
  ribbed: "罗纹", quilted: "绗缝", distressed: "做旧", vintage: "复古",
  minimalist: "极简", elegant: "优雅", sporty: "运动风", streetwear: "街头风",
  sandals: "凉鞋", flats: "平底鞋", loafers: "乐福鞋",
  mesh: "网眼", lace: "蕾丝", sheer: "透视",
};

// 检测并翻译英文名称为中文
function ensureChineseName(name) {
  if (typeof name !== "string") return "未命名单品";
  const trimmed = name.trim();
  if (!trimmed) return "未命名单品";
  // 如果已经是中文名称，直接返回
  if (/[\u4e00-\u9fff]/.test(trimmed)) return trimmed.slice(0, 120);
  // 尝试翻译英文
  const lower = trimmed.toLowerCase().replace(/[^a-z\s-]/g, " ").trim();
  if (!lower) return "未命名单品";
  const words = lower.split(/[\s-]+/).filter(Boolean);
  const translated = words.map((word) => EN_ZH_CLOTHING[word] || word).join("");
  if (/[\u4e00-\u9fff]/.test(translated)) return translated.slice(0, 120);
  return "未命名单品";
}

// 翻译单个标签为中文（用于细节标签）
function ensureChineseTag(tag) {
  if (typeof tag !== "string") return "";
  const trimmed = tag.trim();
  if (!trimmed) return "";
  // 已包含中文，直接返回
  if (/[\u4e00-\u9fff]/.test(trimmed)) return trimmed.slice(0, 40);
  // 先尝试整个短语匹配（如 "button-up"）
  const lowerFull = trimmed.toLowerCase();
  if (EN_ZH_CLOTHING[lowerFull]) return EN_ZH_CLOTHING[lowerFull];
  // 逐词翻译
  const lower = lowerFull.replace(/[^a-z\s-]/g, " ").trim();
  if (!lower) return "";
  const words = lower.split(/[\s-]+/).filter(Boolean);
  const translated = words.map((word) => EN_ZH_CLOTHING[word] || "").filter(Boolean).join("");
  return translated || trimmed.slice(0, 40);
}

export function normalizeMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color =
    typeof metadata.color === "string" && HEX_COLOR.test(metadata.color)
      ? metadata.color.toLowerCase()
      : "#d8d0c2";
  const secondaryColor =
    typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor)
      ? metadata.secondaryColor.toLowerCase()
      : null;
  const season = Array.isArray(metadata.season)
    ? metadata.season
        .filter((entry) => typeof entry === "string" && SEASONS.has(entry.toLowerCase()))
        .map((entry) => entry.toLowerCase())
        .filter((entry, index, array) => array.indexOf(entry) === index)
    : [];
  return {
    name: ensureChineseName(metadata.name),
    part: PARTS.has(metadata.part) ? metadata.part : "upperbody",
    subtype: typeof metadata.subtype === "string" ? metadata.subtype.trim().slice(0, 20) : "",
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags)
      ? metadata.tags
          .filter((tag) => typeof tag === "string")
          .map((tag) => ensureChineseTag(tag))
          .filter(Boolean)
          .slice(0, 12)
      : [],
    season,
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}
