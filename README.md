# 智能衣橱（Wardrobe 国内版）

本地优先的 AI 智能衣橱 Demo：拍照 / 上传图片或粘贴商品链接，AI 自动逐件识别衣物、抠出透明背景单件图并入库，还支持按天气推荐整套穿搭、分析博主穿搭灵感并生成博主同款试穿图。所有数据保存在本地 `data/` 目录，无需云端账号。

> 本项目基于开源项目 [tandpfun/wardrobe](https://github.com/tandpfun/wardrobe) 做本地化改造：接入火山引擎方舟（豆包）模型、全中文界面、移动端优先（PWA），并新增电商链接导入、天气推荐、灵感库三大能力。当前定位为**最小可行 Demo**，用于验证链路可行性，后续再封装为安卓 / iOS 原生 App。

---

## 一、项目主要解决什么问题

- **衣服太多、早上不知道穿什么**：把散落在手机相册、电商收藏里的衣服集中成一份可筛选的电子衣橱，并按当天天气直接给出一整套搭配。
- **电商链接 / 穿搭照里的衣服难沉淀**：粘贴商品链接或上传真人穿搭照，AI 逐件识别并把**单件衣物抠图**入库，衣橱里只保留单件透明背景图，不保留含模特 / 多件衣物的原图。
- **国外方案在国内不好用**：把原本依赖 OpenAI 的能力替换为国内可直连的火山引擎方舟（豆包）模型，界面、品类、标签、季节全部中文本地化。
- **想要博主同款**：上传喜欢的博主穿搭图，分析其风格标签 / 配色 / 单品构成，再从自己的衣橱里选单品，生成穿上博主同款的试穿图。

## 二、主要功能

- **衣橱管理** — 网格展示、品类 × 季节筛选、单件详情查看与编辑、单件 / 批量删除。
- **AI 逐件识别与抠图** — 上传真人穿搭照或商品图，AI 逐件识别衣物（细分品类、颜色、中文标签、适用季节），本地用 `sharp` 去背景，只入库单件透明抠图。
- **链接导入** — 粘贴淘宝 / 京东 / 拼多多等商品链接或整段分享文本，服务端抓取商品主图并识别入库。
- **天气推荐** — 按实时天气（温度、体感、风力）与季节从衣橱挑出一整套穿搭并给出中文理由，可继续生成真人试穿图。
- **灵感库** — 上传博主穿搭图，AI 分析风格标签 / 主色 / 单品构成 / 中文总结；可点赞沉淀，并匹配衣橱单品生成博主同款试穿图。
- **移动端优先 PWA** — 界面与交互针对手机触摸优化，电脑与手机同一 WiFi 下即可访问。
- **内置 Agent Skill** — 仓库在 `.agents/skills/` 下附带 `import-clothes`、`generate-outfits` 两个 Skill，供 AI 代理批量导入衣物与生成整套搭配。

## 三、安装方法

### 环境要求

- Node.js 18+（推荐 20+）
- npm

### 步骤

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量模板并填写配置
cp .env.example .env

# 3. 启动开发服务器
npm run dev
```

启动后：

- 电脑访问 http://localhost:5173/
- 手机访问 `http://<电脑局域网IP>:5173/`（Demo 阶段需与电脑同一 WiFi）
- 生产构建：`npm run build`（等价于 `npm run check`），预览：`npm run preview`

### 配置（`.env`）

| 变量 | 说明 | 示例 / 默认值 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 火山引擎方舟 API Key（必填） | `ark-xxxxxxxx` |
| `OPENAI_API_BASE_URL` | 方舟接口地址 | `https://ark.cn-beijing.volces.com/api/v3` |
| `OPENAI_VISION_MODEL` | 视觉识别模型（衣物 / 灵感图分析） | `doubao-seed-character-260628` |
| `OPENAI_IMAGE_MODEL` | 通用图像生成模型 | `doubao-seedream-5-0-pro-260628` |
| `OPENAI_IMAGE_QUALITY` | 图像生成质量 | `high` |
| `OPENAI_GARMENT_MODEL` | 衣物抠图 / 生成模型 | `doubao-seedream-5-0-pro-260628` |
| `OPENAI_MODELED_MODEL` | 模特图生成模型 | `doubao-seedream-5-0-pro-260628` |
| `OPENAI_TRYON_MODEL` | 试穿图生成模型 | `doubao-seedream-5-0-pro-260628` |
| `OPENAI_API_MODE` | 使用 `chat/completions` 兼容模式 | `chat` |
| `WARDROBE_MODEL_REFERENCE` | 本人人像参考图路径（试穿用） | `data/model-reference.png` |
| `QWEATHER_KEY` | 和风天气 Key（可选，未配置时自动回退 Open-Meteo） | 空 |
| `QWEATHER_HOST` | 和风接口域名（免费版用 devapi） | `devapi.qweather.com` |
| `VITE_API_BASE_URL` | 前端 API 根地址（原生打包时指向远程服务；留空=同源） | 空 |

> 说明：`.env.example` 是通用模板（默认填写的是国际中转站模型名）；国内部署请按上表填写火山引擎方舟的 `OPENAI_API_BASE_URL` 与豆包模型名。AI 识别、链接导入、灵感分析仅需 `OPENAI_API_KEY` 与 `OPENAI_VISION_MODEL`。抠图 / 试穿 / 模特图依赖 Seedream 图像模型，需在 [方舟控制台](https://console.volces.com/ark) 开通并确认额度；未开通时识别与入库仍可用，只有图像生成类接口会报错。天气推荐在未配置 `QWEATHER_KEY` 时会自动使用免 Key 的 Open-Meteo。

## 四、使用方法

1. **导入衣物**
   - 打开「衣橱」标签页 →「导入」。
   - 拍照 / 从相册选择一张图片（真人穿搭照或商品图均可），等待 AI 逐件识别后确认入库；或粘贴商品链接 / 分享文本后确认抓取到的单件衣物。
2. **查看与管理衣橱**
   - 点击任意单品进入详情，可编辑名称 / 品类 / 标签 / 季节。
   - 点击右上角「管理」进入批量模式，勾选多件后批量删除；单件详情内也可单独删除。
3. **天气推荐**
   - 打开「天气」标签页，授权定位或手动选择城市。
   - 查看当前天气与推荐的一整套穿搭及理由；可继续生成真人试穿图（需先在衣橱页上传你的人像参考图）。
4. **灵感搭配**
   - 打开「灵感」标签页，上传一张博主穿搭图。
   - 查看 AI 分析出的风格标签 / 主色 / 单品构成 / 中文总结，点赞沉淀；点击「生成博主同款」从衣橱匹配单品并生成试穿图。
5. **上传人像参考图**（生成试穿 / 模特图前置步骤）
   - 在衣橱页上传一张本人清晰的正脸照片，保存到 `data/model-reference.png`，后续所有试穿图都会尽量保持该人像特征。

## 五、输入与输出示例

### 示例 1：拍照 / 相册导入单件衣物

- **输入（HTTP）**：`POST /api/import/jobs`，body 为 `{ "imageDataUrl": "data:image/png;base64,..." }`
- **输出**：返回识别出的任务列表；每个任务经「裁剪 → 抠图 → 模特图」流程确认后，最终写入 `data/library.json` 的单品记录与 `data/imported/` 下的透明抠图。

```json
{
  "id": "import-4bc06ced-336a-4447-9745-5e0b9de5403e",
  "name": "白色圆领短袖T恤",
  "part": "upperbody",
  "subtype": "T恤",
  "color": "#f5f5f5",
  "secondaryColor": null,
  "palette": ["#f5f5f5"],
  "tags": ["休闲", "简约"],
  "season": ["spring", "summer"],
  "image": "/api/import/library/import-4bc06ced-336a-4447-9745-5e0b9de5403e-garment.png",
  "thumbnail": "/api/import/library/import-4bc06ced-336a-4447-9745-5e0b9de5403e-garment.png",
  "modeledImage": "/api/import/library/import-4bc06ced-336a-4447-9745-5e0b9de5403e-modeled.png",
  "importJobId": "4bc06ced-336a-4447-9745-5e0b9de5403e"
}
```

> 字段说明：`part` 取值 `upperbody`（上装）/ `wholebody_up`（连体衣、外套、大衣）/ `lowerbody`（下装）/ `accessories_up`（配饰）/ `shoes`（鞋履）；`subtype` 从受控中文词表（T恤 / 衬衫 / 卫衣 / 毛衣 / 外套 / 大衣 / 连衣裙 / 半身裙 / 牛仔裤 / 休闲裤 / 短裤 / 运动鞋 / 皮鞋 / 靴子 / 帽子 / 围巾 / 包 / 其他）中选取；`season` 取值 `spring` / `summer` / `autumn` / `winter`。

### 示例 2：商品链接导入

- **输入（HTTP）**：`POST /api/wardrobe/link-analyze`，body 为 `{ "sourceUrl": "【淘宝】https://m.tb.cn/h.xxxx CZ0001 「白色衬衫」", "name": "白色衬衫"（可选） }`
- **输出**：服务端抓取商品主图并识别，返回预览图与识别草稿；用户确认后调用 `POST /api/wardrobe/link-commit` 完成裁剪 + 抠图入库。

```json
{
  "token": "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  "previewUrl": "/api/wardrobe/tmp/6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f.png",
  "draft": {
    "name": "白色细竖条纹翻领衬衫",
    "part": "upperbody",
    "subtype": "衬衫",
    "color": "#f8f5ed",
    "secondaryColor": null,
    "tags": ["通勤", "竖条纹"],
    "season": ["spring", "autumn"],
    "boundingBox": { "x": 120, "y": 80, "width": 640, "height": 820 }
  },
  "candidates": [
    { "name": "白色细竖条纹翻领衬衫", "part": "upperbody", "subtype": "衬衫", "color": "#f8f5ed", "secondaryColor": null, "tags": ["通勤", "竖条纹"], "season": ["spring", "autumn"], "boundingBox": { "x": 120, "y": 80, "width": 640, "height": 820 }, "index": 0 }
  ],
  "sourceUrl": "https://m.tb.cn/h.xxxx"
}
```

确认入库（`POST /api/wardrobe/link-commit`，body 传 `token` / `sourceUrl` / `metadata`）后返回：

```json
{
  "id": "link-6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  "name": "白色细竖条纹翻领衬衫",
  "part": "upperbody",
  "subtype": "衬衫",
  "color": "#f8f5ed",
  "secondaryColor": null,
  "palette": ["#f8f5ed"],
  "tags": ["通勤", "竖条纹"],
  "season": ["spring", "autumn"],
  "image": "/api/import/library/link-6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f.png",
  "thumbnail": "/api/import/library/link-6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f.png",
  "sourceUrl": "https://m.tb.cn/h.xxxx",
  "createdAt": "2026-10-12T16:09:20.281Z"
}
```

### 示例 3：灵感图分析

- **输入（HTTP）**：`POST /api/style/inspirations`，body 为 `{ "imageDataUrl": "data:image/png;base64,...", "note": ""（可选） }`
- **输出**：写入 `data/inspirations/` 的图片与记录（风格标签、主色、单品构成、中文总结）。

```json
{
  "id": "91fb6420-a292-44c5-aec5-7f5151b90d2c",
  "note": "",
  "styleTags": ["复古", "休闲", "工装"],
  "palette": ["#8b7d6b", "#f2f2f2", "#2c2c2c", "#d4af37", "#c0c0c0"],
  "garments": [
    { "part": "外套", "color": "#8b7d6b", "description": "卡其棕色灯芯绒立领短款夹克" },
    { "part": "内搭衬衫", "color": "#f2f2f2", "description": "米白色细竖条纹翻领衬衫" }
  ],
  "summary": "这套搭配走复古休闲工装风，兼具日常感与造型感，适合日常出行、轻通勤等场景。",
  "liked": false,
  "tags": [],
  "image": "/api/style/assets/91fb6420-a292-44c5-aec5-7f5151b90d2c.png",
  "createdAt": "2026-10-12T16:09:20.281Z"
}
```

> `styleTags` 来自受控词表（通勤 / 极简 / 街头 / 甜酷 / 法式 / 休闲 / 运动 / 复古 / 学院 / 日系 / 韩系 / 工装 / 度假）。

### 示例 4：天气推荐

- **输入（HTTP）**：`GET /api/weather?lat=39.90&lon=116.40`
- **输出**：当前天气（未配置 `QWEATHER_KEY` 时使用 Open-Meteo，`provider` 为 `open-meteo`；配置后为 `qweather` 并额外返回 `city`）。

```json
{
  "provider": "open-meteo",
  "temp": 22,
  "feelsLike": 21,
  "text": "晴",
  "windScale": "2",
  "windDir": "东南风",
  "tempMax": 26,
  "tempMin": 15,
  "precip": 0
}
```

前端据此从衣橱挑选整套穿搭并给出推荐理由。

### 示例 5：生成博主同款 / 试穿图

- **输入（HTTP）**：`POST /api/looks/generate`，body 为 `{ "type": "inspiration", "garmentIds": ["import-4bc06ced-336a-4447-9745-5e0b9de5403e"], "inspirationId": "91fb6420-a292-44c5-aec5-7f5151b90d2c", "prompt": "（可选）" }`
- **输出**：生成方形试穿图 PNG（保存于 `data/looks/`）并返回关联记录。

```json
{
  "id": "3b9a1c7e-0d2f-4a8b-9c1e-5f6a7b8c9d0e",
  "type": "inspiration",
  "garmentIds": ["import-4bc06ced-336a-4447-9745-5e0b9de5403e"],
  "inspirationId": "91fb6420-a292-44c5-aec5-7f5151b90d2c",
  "prompt": "……（服务端自动生成的中文图像提示词）",
  "image": "/api/looks/assets/3b9a1c7e-0d2f-4a8b-9c1e-5f6a7b8c9d0e.png",
  "createdAt": "2026-10-12T16:20:00.000Z"
}
```

> `type` 取值：`inspiration`（博主同款，前端灵感页使用）/ `daily`（天气推荐试穿，前端天气页使用）/ `editorial`（默认兜底，通用造型图）。生成前需：① 已在衣橱页上传人像参考图；② `OPENAI_TRYON_MODEL` 已配置且 Seedream 模型已在方舟控制台开通。

---

## 主要 API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/import/jobs` | 上传图片，创建逐件识别 / 抠图任务 |
| `GET` | `/api/import/jobs` | 查询进行中的识别任务 |
| `GET` | `/api/import/wardrobe` | 衣橱单品列表 |
| `DELETE` | `/api/import/wardrobe/import-<uuid>` | 删除单件衣物 |
| `POST` / `GET` | `/api/import/model-reference` | 上传 / 获取人像参考图 |
| `POST` | `/api/wardrobe/link-analyze` | 链接导入：抓取主图并识别 |
| `POST` | `/api/wardrobe/link-commit` | 链接导入：确认裁剪抠图入库 |
| `POST` | `/api/wardrobe/link-cancel` | 取消链接导入草稿 |
| `DELETE` | `/api/wardrobe/items/link-<uuid>` | 删除链接导入的单品 |
| `GET` | `/api/weather` | 查询实时天气（`lat`、`lon`） |
| `GET` / `POST` | `/api/style/inspirations` | 灵感列表 / 上传分析灵感图 |
| `PATCH` / `DELETE` | `/api/style/inspirations/<id>` | 点赞 / 备注 / 标签 / 删除灵感 |
| `GET` / `POST` | `/api/looks` / `/api/looks/generate` | 查询 / 生成试穿图 |
| `DELETE` | `/api/looks/<id>` | 删除试穿图 |

## 目录结构

```
.
├── src/                       # 前端（React + Vite，中文界面，三标签：衣橱 / 天气 / 灵感）
├── scripts/                   # 后端中间件与 AI 客户端（以 Vite middleware 插件形式挂载）
│   ├── ai-client.mjs          # 火山引擎识别 / 抠图 / 图像生成
│   ├── import-job-api.mjs     # 拍照导入任务 API
│   ├── features-api.mjs       # 链接 / 天气 / 灵感 / 试穿 API
│   ├── responsive-image-api.mjs
│   └── quick_validate.mjs     # Skill 结构校验
├── .agents/skills/            # import-clothes / generate-outfits 两个 Agent Skill
├── data/                      # 本地数据（不入库）
│   ├── library.json           # 衣橱单品记录
│   ├── imported/              # 单件透明抠图 / 模特图
│   ├── inspirations/          # 灵感图与记录
│   └── looks/                 # 试穿 / 博主同款成图
├── .env.example               # 环境变量模板
└── vite.config.mjs
```

## 内置 Skill

仓库在 `.agents/skills/` 下提供两个 Skill，供 AI 代理批量处理：

- `import-clothes` — 从照片拆解单件衣物、抠图并写入衣橱数据库
- `generate-outfits` — 从衣橱挑选成套搭配并生成方形模特图

校验 Skill 结构：

```bash
node scripts/quick_validate.mjs
```

## 许可

本项目基于 [tandpfun/wardrobe](https://github.com/tandpfun/wardrobe)（MIT）改造，遵循 [MIT](LICENSE) 许可。
