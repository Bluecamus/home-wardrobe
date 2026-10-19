---
name: import-clothes
description: 从真人穿搭照或商品图中拆解出单件衣物、重建透明背景抠图，并把通过审核的单品写入本地衣橱数据库。当用户要求把照片里的衣服导入衣橱、生成抠图或模特图时使用。不用于衣橱浏览、搭配推荐或试穿图生成。
---

# 导入衣物

把「穿在身上的衣物照片」转成忠于原图的透明背景单品 PNG 与模特图，再把通过审核的结果写入本地衣橱数据库。

## 输入

- 获取源图文件夹；相对路径一律以仓库根目录解析。
- 确认是本 Wardrobe 仓库：存在 `package.json`、`scripts/import-job-api.mjs`，且 `.gitignore` 含 `data/`。
- 身份参考图位于 `data/model-reference.png`，或由 `WARDROBE_MODEL_REFERENCE` 指定的本地路径。两者都不存在时先问用户：`请提供一张本人清晰正脸 PNG 用于生成模特图，并给出本地路径。` 未提供前不要开始生成模特图。参考图只存本地，绝不加入 Git。
- 默认直接写入数据库；若用户只要抠图，请其给出新的输出文件夹名并跳过写库步骤。

## 规则

- 生成或编辑图片前，先阅读并遵循内置的 `imagegen` 技能。
- 保留全部源图不变。
- 每件单品输出一张 PNG（本身成对的鞋靴除外）。
- 去除穿着者、皮肤、头发、模特、衣架、道具、其他叠穿层与场景。
- 只保留源图能支撑的颜色、材质、廓形、结构、图案与可辨认标记。
- 宁可省略，也不要臆造 logo、文字、口袋、缝线、紧固件、五金或镶边。
- 只有当源照片能证明两次出现是同一件实物时才去重。
- 若某件单品的决定性结构无法在不大量臆造的前提下复原，则暂扣（hold），不要强行生成。
- 绝不在 `data/` 放置临时裁剪、提示词、清单或 QA 文件。

### 品类与中文字段（本项目为国内版，必须遵守）

- `part` 只能取以下值：
  - `upperbody` — 上装
  - `wholebody_up` — 外套 / 连体衣
  - `lowerbody` — 下装
  - `accessories_up` — 配饰
  - `shoes` — 鞋履
- `name` 用简洁具体的中文，例如「白色棉质短袖衬衫」；禁止英文名，图片上的英文标签一律忽略。
- `subtype` 从以下受控中文词表中取最贴切的一个：T恤、衬衫、卫衣、毛衣、外套、大衣、连衣裙、半身裙、牛仔裤、休闲裤、短裤、运动鞋、皮鞋、靴子、帽子、围巾、包、其他。
- `tags` 用中文（如「通勤」「纯棉」「短袖」），最多 12 个。
- `season` 从 `spring` / `summer` / `autumn` / `winter` 中多选，最多 4 个。

## 并行

源图很多或生成单品超过 8 件且当前环境支持子代理时，使用子代理。给每个 worker 不相交的源文件或 manifest slug，并要求其返回 slug、提示词、参考图路径、色键图路径、模特图路径与视觉复核记录。

始终由主代理负责全局单品盘点、实物同一性去重、清单汇总、数据库写入与最终拼版 QA。绝不允许两个 worker 生成或写入同一个 slug。并发受限时分批推进，只重跑缺失或失败的 slug。

## 临时工作区

在仓库数据目录之外工作：

```bash
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wardrobe-import.XXXXXX")"
mkdir -p "$WORK"/{source-jpg,crops,chroma,items,modeled,qa}
```

所有中间文件都放在 `$WORK`，仅在交付成功后才删除。

## 工作流

### 1. 盘点源图

先用 `rg --files`。包含 JPEG、PNG、WebP、HEIC/HEIF、TIFF、BMP、AVIF，排除 `data/`、`dist/`、`node_modules/`、`.git/`。

生成直立方向、sRGB 的 JPEG 工作副本（质量 95 或更高），不要放大。每张拼版最多放 12 张照片并逐一检查。逐件盘点刻意穿着的上装、外套、下装、配饰与成对鞋靴。

### 2. 构建清单

写出 `$WORK/manifest.json`，采用以下最终结构：

```json
{
  "items": [
    {
      "slug": "navy-fair-isle-cardigan",
      "file": "navy-fair-isle-cardigan.png",
      "modeledFile": "navy-fair-isle-cardigan.png",
      "name": "藏青费尔岛提花开衫",
      "part": "wholebody_up",
      "subtype": "毛衣",
      "color": "#172033",
      "secondaryColor": "#f2efe6",
      "tags": ["针织", "提花", "拉链"],
      "season": ["autumn", "winter"],
      "status": "accepted",
      "sourceRefs": ["IMG_1284.jpg", "IMG_1289.jpg"],
      "unknowns": []
    }
  ]
}
```

slug 用小写连字符，颜色用六位 hex，`secondaryColor` 在没有真正明显区分的辅色时为 `null`。工作记录保持 `status: "generate"` 或 `status: "hold"`，只有在最终 QA 通过后才改为 `accepted`。导入脚本会忽略所有非 `accepted` 的记录。

### 3. 准备聚焦参考图

对每件待生成单品，裁剪最强视角并留约 12% 边距，保留足够上下文以区分目标与内搭。当某张互补裁剪能提供主视角缺失的重要结构时，最多再加一张。生成前先检查带标注的裁剪拼版。

### 4. 生成有依据的抠图

用 Imagegen，仅传入主裁剪（必要时加一张互补裁剪）。要求产出「完整、居中、纯色色键背景、留足边距、无阴影」的空置单品图，并说明必须保留的源图结构，以及所有需要省略的不确定细节。

默认色键用 `#00ff00`；绿色衣物改用 `#ff00ff`，除非洋红在衣物上很显眼。否则挑选与衣物饱和度差异最大的 RGB 色键。绝不要使用衣物本身存在的颜色作色键。

把生成的色键图保存到 `$WORK/chroma/SLUG.png`。接受前逐张与源图比对。

### 5. 去除色键背景

优先使用内置 Imagegen 技能附带的脚本：

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/scripts/remove_chroma_key.py" \
  --input "$WORK/chroma/SLUG.png" \
  --out "$WORK/items/SLUG.png" \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill \
  --force
```

若去背后损伤了单品，改用更远的色键重新生成，而不是强行套用遮罩。若当前环境没有该 Python 脚本，可改用仓库自带的本地抠图实现（见 `scripts/ai-client.mjs` 的 `removeBackgroundLocally`），它用 sharp 做边缘色采样 + flood-fill + 皮肤/色板保护。

### 6. 校验

对每张成品 PNG 校验：

- PNG 格式且含 RGBA alpha 通道
- 四角与边框透明
- 内容可见、有边距、无被裁切的末端
- 无身体部位、内搭、相邻衣物、道具、阴影或色键残边
- 品类、比例、颜色、材质、结构、图案与标记忠于源图
- 每个 `accepted` 记录恰好对应一张输出

抽查最多 12 件的棋盘格拼版，敏感结果与源裁剪逐张对比。关键或重大失败要重生成。只有通过后才标记 `accepted`。

### 7. 生成模特图

以 `data/model-reference.png` 为身份参考，除非 `WARDROBE_MODEL_REFERENCE` 指向别的本地 PNG。两者都不存在时先向用户索取清晰参考照再继续。绝不要把该照片加入 Git。

对每件 `accepted` 抠图，用 Imagegen：先传身份图，再传精确的衣物 PNG。存为 3:2 横版 PNG 到 `$WORK/modeled/SLUG.png`，并在清单中把 `modeledFile` 设为 `SLUG.png`。

使用以下生成简报：

```text
Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact clothing item from Image 2.

Preserve the person's recognizable face, hair, age, build, skin texture, and body proportions. Preserve the featured garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, closure, and distinctive details. Do not redesign, simplify, replace, or reinterpret it.

Use understated neutral supporting clothes that complete the outfit without covering or competing with the featured item. Keep the full featured item and every important detail visible. Use a natural pose with arms and accessories away from it.

Place the person in a tasteful real-world setting with warm professional natural light, realistic shadows, authentic skin and fabric texture, and restrained editorial color grading. Leave environmental breathing room for flexible cropping.

Avoid hidden garment details, invented closures, fake text or logos, extra statement pieces, crossed arms, bags or scarves covering the item, cropped item extremities, extra people, text overlays, watermarks, product-mockup styling, or synthetic AI polish.
```

同一批次中变换低调场景，同时保持身份与编辑风格统一。逐张与两份参考比对。身份漂移、衣物被改款、细节被遮挡、人体结构错误或取景错误都要重生成。

### 8. 写入衣橱

当用户的原始请求未明确授权直接导入时，写入前先向用户展示通过审核的单品数量与名称。若已明确要求直接导入，QA 通过后直接进行。

从仓库根目录运行自带确定性导入脚本：

```bash
node .agents/skills/import-clothes/scripts/import-to-wardrobe.mjs \
  --items "$WORK/items" \
  --modeled "$WORK/modeled" \
  --manifest "$WORK/manifest.json"
```

脚本会校验抠图与模特图 PNG，把它们复制进 `data/imported/`，并原子更新 `data/library.json`，同时写入中文字段 `subtype` 与 `season`。它按抠图内容派生稳定 UUID，因此重复导入相同内容只会更新元数据与模特图，不会产生重复记录。

只有运行中的应用未自动感知数据库变化时才重启 dev server，然后在 `/api/import/wardrobe` 校验新增单品数量，并目视检查画廊。

只交付抠图时，在仓库根目录下创建用户指定的新子文件夹，只复制通过的 PNG，不写数据库。

## 完成

返回导入数量、跳过或暂扣的单品、数据库绝对路径与画廊校验结果。在对话中最多展示 12 张成品抠图。简要说明任何无法恢复的碎片。
