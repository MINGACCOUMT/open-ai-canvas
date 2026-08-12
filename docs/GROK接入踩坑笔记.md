# Grok（xAI 协议）接入踩坑笔记

> 本文档整理接入自建 OpenAI 兼容网关上的 grok 视频生成与图像编辑时遇到的问题、根因和解决方案，并提炼出可迁移到其他项目的通用要点。
>
> 适用场景：任何「OpenAI 兼容」聚合网关 / 自建 API，底层走 xAI grok 系列模型（`grok-imagine-image`、`grok-imagine-video` 等）。

---

## 一、422 错误（字段不被上游接受）

### 现象
自建网关返回 `422 Unprocessable Entity`。

### 根因
早期为了「避免 422」，**过度裁剪了 grok 请求字段**——把 `duration` / `aspect_ratio` / `resolution` 全删了，结果反而因为缺字段或类型不对被拒。

### 解决方案
查官方文档（https://docs.x.ai/docs/guides/video-generations）确认 grok 实际支持这些字段，**保留字段 + 加取值校验**：

| 字段 | 允许值 |
|---|---|
| `duration` | 1–15（秒），int |
| `aspect_ratio` | `16:9 / 4:3 / 1:1 / 9:16 / 3:4 / 3:2 / 2:3` |
| `resolution` | `720p / 480p` |

**砍掉** xAI 不支持的：`watermark / size / seed / camerafixed / generate_audio`。

### 可迁移要点
> 不要靠「猜哪些字段安全」来防 422。**对着官方文档逐字段对**，保留支持的、按白名单校验值、删掉不支持的。一次性把 body 对齐到协议，比反复试错省得多。

---

## 二、xAI 视频协议三连坑（任务标识 / 轮询路径 / 下载方式）

### 现象
视频任务提交后：拿不到 task_id、轮询 404、或拿到了 URL 但下不下来。

### 根因 + 解决方案

| 坑 | 根因 | 解决方案 |
|---|---|---|
| 拿不到 task_id | xAI 返回 `request_id`，旧代码只认 `task_id/id` | `extract_task_id` 增加 `request_id/requestId` 识别 |
| 轮询 404 | 通用分支拼 `/v1/videos/generations/{id}`，xAI 实际是 `/v1/videos/{id}` | 检测到 `/v1/videos` 根提交时，走 `/v1/videos/{id}` 轮询 |
| 状态 done 但拿不到视频 | xAI 视频**不在 JSON 里**，是 `/v1/videos/{id}/content` 二进制流 | 单独走 `download_*_content` 下载 bytes 落盘 |
| 状态字段名不同 | xAI 用 `state` 而非 `status` | 取 status 时同时认 `status / task_status / state` |

### 可迁移要点
> 接一个「OpenAI 兼容」网关 ≠ 真的标准 OpenAI 协议。**抓一次真实响应**，确认：① 任务标识字段名 ② 轮询路径 ③ 结果载体（JSON url vs 二进制流）④ 状态字段名。这四点对齐了，视频任务才跑得通。

---

## 三、参考图与生成结果「毫无关联」（最高频、最坑）

这是最有价值的一段。分图生视频 / 图生图两种，但**根因是同一个**。

### 核心根因（一句话）
> **xAI 的参考图字段要求「上游可下载的公网 http(s) URL」。本地图被转成 data URL 后，会被上游静默忽略 —— 不报错，但参考图等于没传。**

---

### 3.1 图生视频：字段名错误 + data URL

#### 现象
连一张本地图生成视频，视频和图完全没关系。

#### 根因（两层）
1. **字段名传错**：用了 `reference_image_urls`（多图语义引导，不强制首帧），单图图生视频应该用 **`image: {url, type:"image_url"}`**（强制首帧）
2. **data URL 被忽略**：本地图被转成 284K 字符的 data URL，上游静默丢弃

#### 解决方案
```
单图 → image: {url} + image_url（首帧）
多图 → 第一张作首帧 + 全部进 reference_image_urls
```
本地图先经 `reference_to_public_url` 传 OSS 换公网 URL 再发。

---

### 3.2 图生图：OSS URL 被静默丢弃

#### 现象
图生图结果和提示词/参考图毫无关联。

#### 根因（两层）
1. 旧逻辑走 OpenAI `multipart /images/edits`，用 `output_file_from_url` 解析本地路径。**OSS https URL 解析失败 → `if not path: continue` 静默丢图**
2. edits 失败后**自动回退到纯文生图 `/images/generations`**，没带参考图 → 出一张和参考图无关的图

#### 解决方案
- 新增 `generate_xai_grok_image`：参考图转公网 URL → `image:{url,type}` JSON edits
- edits 失败重试 → 再试 multipart 文件
- **有参考图时禁止回退纯文生图**（宁可明确报错，也不出无关图）

### 可迁移要点（重要）
1. **任何「参考图」字段，先确认它要 URL 还是文件、要公网还是 data**。xAI 系（grok、可能还有别的）要**公网 URL**，data URL 会被**静默吞掉**。
2. **本地图 / data URL 必须先传对象存储（OSS/S3）换公网 URL** 再发给上游。这是这类 API 的通用前置。
3. **丢图要报错，不能 `continue` 静默跳过**。参考图为空却仍发请求，等于让模型瞎猜。
4. **有参考图时禁止回退纯文生图**。回退会掩盖问题，用户看到「出了图但不对」最难排查。
5. **字段名要按官方文档逐个对**：`image` / `image_url` / `images` / `reference_image_urls` 含义各不同，传错 = 静默忽略。

---

## 四、速度优化（视频要等 1 分钟 vs 平台 7 秒）

### 现象
自建平台后台 7 秒显示成功，项目里要等约 1 分钟。

### 根因（轮询 + 下载 + OSS 串行）
旧轮询逻辑：**提交后先 sleep 2s 才第一次查**，再**指数退避到 12s**。上游 7 秒完成时，可能要等到第 3～4 次轮询才发现，白白多等十几秒。

实测分段：轮询 25–40s + 下载 10–25s + OSS 1–2s。

### 解决方案
1. **轮询**：grok 专用 —— 0.3s 后立即查、固定 ~1s 间隔、上限 2s（不再退避到 12s）
2. **OSS 异步**：视频落盘后**立刻返回本地 `/assets/...mp4`**，画布马上能播；OSS 后台 `asyncio.create_task` 上传，不堵接口
3. 加 `[VIDEO-TIMING]` 分段日志，定位瓶颈

### 可迁移要点
1. **轮询不要「先 sleep 再查」**。提交后立即探测，固定短间隔，别退避到十几秒。
2. **本地缓存 + 公网存储分离**：先返回本地 URL 让前端能用，公网存储后台异步传。
3. **「平台后台耗时 ≠ 用户看到结果的耗时」**。后台只算任务完成，你还要算下载/转存。给用户设预期时讲清楚。
4. 加分段计时日志，省得每次靠猜。

---

## 五、临时性错误（502 Upstream service temporarily unavailable）

### 现象
偶发 `502 Upstream service temporarily unavailable`，多图图生图尤其容易撞上。

### 根因
上游网关瞬时不可用（负载/限流/抖动），**不是本地代码逻辑问题**。

### 解决方案
- JSON edits 失败后等 1.5s 重试 1 次
- 再不行试 multipart 文件兜底
- 全部失败时**明确报错**（带上游原始错误），不偷偷回退文生图

### 可迁移要点
> 对 5xx 瞬时错误，加「短延迟 + 1～2 次重试」能显著提高成功率；但**不要**把重试伪装成成功（比如回退到不带参考图的请求）。

---

## 六、通用可迁移清单（给其他项目）

迁移到另一个项目时，按这个 checklist 过一遍：

### 协议对齐
- [ ] 抓一次真实 submit/poll/result 响应，确认 task_id 字段名
- [ ] 确认轮询 URL 路径（generations/{id} vs {id}）
- [ ] 确认结果载体（JSON url vs 二进制流 vs base64）
- [ ] 确认状态字段名（status / task_status / state）

### 参考图
- [ ] 确认参考图字段要 **URL / 文件 / data URL** 中的哪种
- [ ] 若要公网 URL：本地图 / data URL **必须先传对象存储**
- [ ] 参考图解析失败要**报错**，不能静默丢
- [ ] 有参考图时**禁止回退纯文生图**
- [ ] 字段名按官方文档对（image / image_url / images / reference_image_urls）

### 防护 & 体验
- [ ] 422 时**对齐字段白名单**，不要靠猜裁字段
- [ ] 502/503 瞬时错误加重试（1.5s 后再试 1–2 次）
- [ ] 轮询提交后立即查、短间隔、别退避太狠
- [ ] 结果先返回本地可播，公网存储后台异步
- [ ] 全链路加 `[TIMING]` 分段日志

---

## 附：本项目关键代码位置（main.py）

| 功能 | 函数 | 大致行号 |
|---|---|---|
| 参考图转公网 URL | `reference_to_public_url` | ~458 |
| task_id 提取（含 request_id） | `extract_task_id` | ~4505 |
| grok 视频模型判定 | `is_tudou_grok_video_model` | ~5095 |
| 视频轮询（grok 短间隔） | `wait_for_video_task` | ~15133 |
| grok 视频内容下载 | `download_tudou_grok_video_content` | ~15727 |
| grok 图生图（xAI 协议） | `generate_xai_grok_image` | ~15522 |
| 本地优先 + OSS 后台 | `output_url_for_local_first` | ~7131 |

---

*最后更新：2026-08-07*
