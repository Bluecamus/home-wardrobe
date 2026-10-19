// 推荐引擎 — 纯函数，基于天气/季节/配色的规则匹配
import { T } from "./i18n.js";

// hex 转 RGB
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

function colorDistance(a, b) {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return 999;
  return Math.sqrt((ra.r - rb.r) ** 2 + (ra.g - rb.g) ** 2 + (ra.b - rb.b) ** 2);
}

// 温度分带策略
function tempStrategy(temp) {
  if (temp <= 5) return { layers: "thick_outer", sleeveStrategy: "long", thickness: "thick", hint: "严寒，建议厚外套加保暖内搭" };
  if (temp <= 14) return { layers: "outer", sleeveStrategy: "long", thickness: "medium", hint: "微凉，建议外套加长袖" };
  if (temp <= 21) return { layers: "light", sleeveStrategy: "long", thickness: "light", hint: "凉爽，建议薄长袖或轻薄外套" };
  if (temp <= 27) return { layers: "none", sleeveStrategy: "short", thickness: "light", hint: "温暖，短袖即可" };
  return { layers: "none", sleeveStrategy: "short", thickness: "minimal", hint: "炎热，建议轻薄透气" };
}

// 雨雪策略
function precipStrategy(text = "") {
  const lower = text.toLowerCase();
  const isRain = /rain|drizzle|shower|雨/.test(lower);
  const isSnow = /snow|sleet|雪/.test(lower);
  if (isSnow) return { needWaterproof: true, priorityShoes: true, hint: "降雪天气，建议防滑雪地靴" };
  if (isRain) return { needWaterproof: true, priorityShoes: true, hint: "降雨天气，建议防水外套和雨具" };
  return { needWaterproof: false, priorityShoes: false, hint: "" };
}

// 季节匹配
function seasonMatch(itemSeasons, currentSeason) {
  if (!itemSeasons || !itemSeasons.length) return 0.5; // 未标注降权
  return itemSeasons.includes(currentSeason) ? 1 : 0;
}

// 为单个槽位打分选件
function scoreItem(item, part, strategy, currentSeason, preferredColors = []) {
  if (item.part !== part) return -1;
  let score = 0;
  // 季节匹配
  score += seasonMatch(item.season, currentSeason) * 40;
  // 温度策略
  if (strategy.layers === "thick_outer" && part === "wholebody_up") score += 30;
  if (strategy.layers === "none" && part === "wholebody_up") score -= 20;
  if (strategy.sleeveStrategy === "short" && part === "upperbody") {
    const tags = (item.tags || []).join("").toLowerCase();
    if (/tshirt|短袖|tee|无袖/.test(tags)) score += 20;
    if (/长袖|longsleeve|sweater|针织|卫衣/.test(tags)) score -= 15;
  }
  if (strategy.sleeveStrategy === "long" && part === "upperbody") {
    const tags = (item.tags || []).join("").toLowerCase();
    if (/长袖|longsleeve|sweater|针织|卫衣/.test(tags)) score += 20;
  }
  // 防水优先
  if (strategy.needWaterproof) {
    const tags = (item.tags || []).join("").toLowerCase();
    if (part === "wholebody_up" && /防水|waterproof|风衣|冲锋/.test(tags)) score += 25;
    if (part === "shoes" && /防水|waterproof|靴|boots/.test(tags)) score += 25;
  }
  // 配色偏好
  if (preferredColors.length && item.color) {
    const dist = colorDistance(item.color, preferredColors[0]);
    if (dist < 60) score += 15;
    else if (dist < 120) score += 8;
  }
  // 随机扰动（用于"换一套"）
  score += Math.random() * 10;
  return score;
}

// 生成推荐
export function recommendOutfit(items, weather, rotation = 0) {
  if (!items.length) return { slots: {}, complete: false, missing: ["upperbody", "lowerbody"], reasons: [] };

  const temp = weather?.temp ?? 20;
  const strategy = tempStrategy(temp);
  const precip = precipStrategy(weather?.text);
  const currentSeason = temp <= 5 ? "winter" : temp <= 14 ? "autumn" : temp <= 21 ? "spring" : temp <= 27 ? "spring" : "summer";

  const slots = ["upperbody", "lowerbody", "wholebody_up", "shoes", "accessories_up"];
  const result = {};
  const usedIds = new Set();
  const reasons = [];

  // 根据温度决定是否需要外套
  const needOuter = temp <= 18;
  const slotOrder = needOuter
    ? ["upperbody", "lowerbody", "wholebody_up", "shoes", "accessories_up"]
    : ["upperbody", "lowerbody", "shoes", "accessories_up"];

  for (const part of slotOrder) {
    const candidates = items
      .filter((item) => !usedIds.has(item.id))
      .map((item) => ({ item, score: scoreItem(item, part, strategy, currentSeason, []) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      // 外套和配饰/鞋履可选
      if (part === "wholebody_up" || part === "accessories_up" || part === "shoes") continue;
      result[part] = null;
      continue;
    }

    // rotation 用于"换一套"
    const pick = candidates[Math.min(rotation, candidates.length - 1)] || candidates[0];
    result[part] = pick.item;
    usedIds.add(pick.item.id);
  }

  // 完整性检查
  const required = ["upperbody", "lowerbody"];
  const missing = required.filter((part) => !result[part]);
  const complete = missing.length === 0;

  // 生成理由
  reasons.push(strategy.hint);
  if (precip.hint) reasons.push(precip.hint);
  if (weather?.tempMax != null && weather?.tempMin != null) {
    reasons.push(`今日 ${weather.tempMin}°C ~ ${weather.tempMax}°C`);
  }
  // 配色协调
  const upper = result.upperbody;
  const lower = result.lowerbody;
  if (upper?.color && lower?.color) {
    const dist = colorDistance(upper.color, lower.color);
    if (dist < 80) reasons.push("上下装色调接近，整体统一");
    else if (dist > 180) reasons.push("上下装对比鲜明，层次分明");
    else reasons.push("上下装配色协调");
  }

  return { slots: result, complete, missing, reasons, strategy, precip };
}

// 博主灵感 → 衣橱匹配
export function matchInspiration(inspiration, items, rotation = 0) {
  if (!items.length) return { slots: {}, complete: false, missing: [], reasons: [] };

  const preferredColors = (inspiration?.palette || []).slice(0, 3);
  const styleTags = inspiration?.styleTags || [];
  const inspGarments = inspiration?.garments || [];

  const slots = ["upperbody", "lowerbody", "wholebody_up", "shoes", "accessories_up"];
  const result = {};
  const usedIds = new Set();
  const reasons = [];

  for (const part of slots) {
    // 检查灵感图中是否有这个品类的单品
    const inspItem = inspGarments.find((g) => g.part === part);
    const inspColor = inspItem?.color;

    const candidates = items
      .filter((item) => !usedIds.has(item.id) && item.part === part)
      .map((item) => {
        let score = 30; // 基础分
        // 配色距离
        if (inspColor && item.color) {
          const dist = colorDistance(item.color, inspColor);
          score += Math.max(0, 50 - dist * 0.3);
        }
        // 风格标签命中
        if (styleTags.length && item.tags) {
          const hits = item.tags.filter((t) => styleTags.some((s) => t.includes(s) || s.includes(t)));
          score += hits.length * 12;
        }
        // 季节匹配（灵感图无季节时用当前季节兜底）
        score += seasonMatch(item.season, "spring") * 15;
        // 随机扰动
        score += Math.random() * 8;
        return { item, score };
      })
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) continue;
    const pick = candidates[Math.min(rotation, candidates.length - 1)] || candidates[0];
    result[part] = pick.item;
    usedIds.add(pick.item.id);
  }

  const required = ["upperbody", "lowerbody"];
  const missing = required.filter((part) => !result[part]);
  const complete = missing.length === 0;

  if (styleTags.length) reasons.push(`匹配风格：${styleTags.slice(0, 3).join("、")}`);
  if (preferredColors.length) reasons.push(`偏好配色：${preferredColors.join("、")}`);

  return { slots: result, complete, missing, reasons };
}
