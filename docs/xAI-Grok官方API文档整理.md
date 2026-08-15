# xAI Grok 官方 API 文档整理（图像 & 视频生成）

> 整理自官方文档：https://docs.x.ai/docs/guides/image-generations 与 https://docs.x.ai/docs/guides/video-generations
>
> 用途：快速对照「字段名、端点、参数取值」，避免接入时传错字段导致参考图被静默忽略等问题。
>
> ⚠️ 官方文档对部分枚举值（如 aspect_ratio/resolution 的完整列表）未在 guides 页面明确列出，下文标注「官方文档未明确」处以实际网关返回为准。

---

## 一、模型清单

| 模型 ID | 用途 | 说明 |
|---|---|---|
| `grok-imagine-image` | 文生图 / 图生图 | 基础版（本网关使用） |
| `grok-imagine-image-quality` | 文生图 / 图生图 | 高质量版（官方示例常用） |
| `grok-imagine-video` | 视频生成 | 基础版（本网关使用） |
| `grok-imagine-video-1.5` | 视频生成 | 1.5 版（官方示例常用，支持多图参考） |

> 官方示例统一用 `-quality` / `-1.5` 后缀版本，但网关通常也接受无后缀的基础 ID。

---

## 二、图像生成 API

### 2.1 端点

| 操作 | 方法 | URL |
|---|---|---|
| 文生图 | `POST` | `https://api.x.ai/v1/images/generations` |
| 图像编辑 / 图生图 | `POST` | `https://api.x.ai/v1/images/edits` |

### 2.2 请求参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | 必填，如 `grok-imagine-image-quality` |
| `prompt` | string | 必填，自然语言描述 |
| `n` | int | 输出数量，**最多 10 张/请求** |
| `size` | string | 尺寸（官方文档未列出完整枚举） |
| `response_format` | string | `url` 或 `b64_json` |
| `image` | object | **图生图/编辑**：单图，`{url, type:"image_url"}` |
| `image_url` | string | SDK 风格：URL 或 `data:image/...;base64,...` |
| `images` | array | **多图编辑**：最多 **3 张**源图 |

### 2.3 文生图示例

**cURL**
```bash
curl -X POST https://api.x.ai/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-imagine-image-quality",
    "prompt": "A collage of London landmarks in a stenciled street-art style"
  }'
```

**Python（OpenAI SDK 兼容）**
```python
from openai import OpenAI

client = OpenAI(base_url="https://api.x.ai/v1", api_key="YOUR_API_KEY")
response = client.images.generate(
    model="grok-imagine-image-quality",
    prompt="A collage of London landmarks in a stenciled street-art style",
)
print(response.data[0].url)
```

### 2.4 图像编辑 / 图生图示例

**单图（cURL，公网 URL）**
```bash
curl -X POST https://api.x.ai/v1/images/edits \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-imagine-image-quality",
    "prompt": "Render this as a pencil sketch with detailed shading",
    "image": {
      "url": "https://docs.x.ai/assets/api-examples/images/style-realistic.png",
      "type": "image_url"
    }
  }'
```

**单图（Python SDK，base64 data URI）**
```python
import base64
import xai_sdk

client = xai_sdk.Client()
with open("photo.png", "rb") as f:
    image_data = base64.b64encode(f.read()).decode("utf-8")

response = client.image.sample(
    prompt="Render this as a pencil sketch with detailed shading",
    model="grok-imagine-image-quality",
    image_url=f"data:image/png;base64,{image_data}",
)
print(response.url)
```

**多图编辑（最多 3 张）** — JavaScript SDK 风格：
```javascript
// prompt 对象含 text + images 数组
prompt: { text: "...", images: [url1, url2, url3] }
```

### 2.5 计费

- **生成**：按张固定计费，与 prompt 长度无关
- **编辑**：输入图 + 输出图都计费
- 生成内容**不用于训练**

---

## 三、视频生成 API

### 3.1 端点（异步流程）

| 操作 | 方法 | URL |
|---|---|---|
| 提交视频生成 | `POST` | `https://api.x.ai/v1/videos/generations` |
| 轮询任务状态 | `GET` | `https://api.x.ai/v1/videos/{REQUEST_ID}` |
| 下载视频内容 | `GET` | `https://api.x.ai/v1/videos/{REQUEST_ID}/content` |

> ⚠️ 视频是**异步**的：提交后拿 `request_id`，轮询直到 `status:"done"`，再从 `video.url` 或 `/content` 取视频。

### 3.2 请求参数（POST /v1/videos/generations）

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | 必填，如 `grok-imagine-video-1.5` |
| `prompt` | string | 必填 |
| `duration` | int | 时长，**最长 15 秒** |
| `aspect_ratio` | string | 宽高比（官方文档未列完整枚举；实测支持 `16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 3:2 / 2:3`） |
| `resolution` | string | 分辨率（实测支持 `480p / 720p`） |
| `image` | object | **图生视频（首帧）**：`{url, type:"image_url"}` |
| `image_url` | string | SDK 风格别名 |
| `reference_image_urls` | array | **多图语义参考**（不强制首帧，仅引导风格/主体） |

### 3.3 三种视频模式（关键区分）

| 模式 | 字段 | 作用 |
|---|---|---|
| 文生视频 | 无图字段 | 纯 prompt 生成 |
| **图生视频（首帧）** | `image: {url, type}` | 参考图**强制成为第一帧**，再按 prompt 动起来 |
| 多图语义参考 | `reference_image_urls: [url,...]` | 只影响风格/主体/构图，**不强制首帧** |

> 🚨 **这是最容易踩的坑**：单图图生视频必须用 `image:{url,type}` 当首帧；只传 `reference_image_urls` 时上游当语义引导甚至忽略，导致「视频和参考图毫无关联」。

### 3.4 异步流程示例（图生视频）

**cURL（提交 + 轮询）**
```bash
# 1) 提交
REQUEST_ID=$(curl -s -X POST https://api.x.ai/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-imagine-video-1.5",
    "prompt": "Make the water crash down and slowly pan out the camera",
    "image": {"url": "https://docs.x.ai/assets/api-examples/video/waterfall-still.png"},
    "duration": 12
  }' | jq -r '.request_id')

# 2) 轮询直到完成
while true; do
  RESULT=$(curl -s https://api.x.ai/v1/videos/$REQUEST_ID \
    -H "Authorization: Bearer $XAI_API_KEY")
  STATUS=$(echo "$RESULT" | jq -r '.status')
  if [ "$STATUS" = "done" ]; then
    echo "$RESULT" | jq -r '.video.url'   # 视频地址在 video.url
    break
  elif [ "$STATUS" = "failed" ] || [ "$STATUS" = "expired" ]; then
    echo "Request $STATUS"; echo "$RESULT" | jq .
    break
  fi
  sleep 5
done
```

**Python SDK**
```python
import os
import xai_sdk

client = xai_sdk.Client(api_key=os.getenv("XAI_API_KEY"))
response = client.video.generate(
    prompt="Make the water crash down and slowly pan out the camera",
    model="grok-imagine-video-1.5",
    image_url="https://docs.x.ai/assets/api-examples/video/waterfall-still.png",
    duration=12,
)
print(response.url)
```

### 3.5 状态值

| status | 含义 |
|---|---|
| `pending` / `in_progress`（推断） | 处理中 |
| `done` | 成功，可取视频 |
| `failed` | 失败 |
| `expired` | 过期 |

### 3.6 取视频结果（两种方式）

| 方式 | 说明 |
|---|---|
| `response.video.url` | JSON 里的相对路径，通常是 `/v1/videos/{id}/content` |
| `GET /v1/videos/{id}/content` | **二进制流**，直接下载 mp4（需带鉴权 header） |

> 🚨 官方 curl 用 `.video.url` 拿到的是相对路径，实际下载要走 `/content` 二进制端点。

### 3.7 计费

- 按**秒**计费，duration + resolution 都影响总价
- 生成内容**不用于训练**

---

## 四、参考图传递规则（核心总结）

| 场景 | REST 字段 | SDK 字段 | 内容形式 |
|---|---|---|---|
| 图生视频（首帧） | `image: {url, type:"image_url"}` | `image_url=` | 公网 URL 或 base64 data URI |
| 视频多图语义参考 | `reference_image_urls: [url,...]` | — | 公网 URL 数组 |
| 图像编辑（单图） | `image: {url, type:"image_url"}` | `image_url=` | 公网 URL 或 base64 data URI |
| 图像编辑（多图） | `images: [{type:"image_url",url},...]` + `aspect_ratio` | 同 REST（`prompt` 保持字符串） | 最多 **3 张**；实测多发 `n`/`response_format`/`size` 会被聚合网关上游 400 |

### 参考图可用形式
- ✅ 公网 http(s) URL（推荐，xAI 自己去下载）
- ✅ base64 data URI：`data:image/png;base64,...`（SDK 示例确认支持）
- ⚠️ 本地文件路径：**不能直接传**，必须先转成上面两种之一

> 经验：**聚合网关对 data URI 的兼容性不如官方直连**。本地图最稳妥的做法是先传 OSS/S3 换公网 URL 再传。

---

## 五、限制汇总

| 项目 | 限制 |
|---|---|
| 图像单次输出 | 最多 **10 张** |
| 图像编辑源图 | 最多 **3 张** |
| 视频时长 | 最长 **15 秒** |
| 视频分辨率 | `480p` / `720p`（1080p 未在 guides 明确） |
| 视频宽高比 | `16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 3:2 / 2:3`（实测） |

---

## 六、认证

所有请求带 Header：
```
Authorization: Bearer $XAI_API_KEY
```

OpenAI SDK 兼容写法：
```python
client = OpenAI(base_url="https://api.x.ai/v1", api_key="YOUR_API_KEY")
```

---

## 七、与本项目（自建网关）的差异提示

本项目走自建网关 `https://sub2.koramkoin.cn:9999`，协议声称 OpenAI 兼容，但与官方有几处实测差异：

| 点 | 官方 | 本网关实测 |
|---|---|---|
| 任务标识 | `request_id` | 同（已兼容识别） |
| 轮询路径 | `/v1/videos/{id}` | 同 |
| 视频下载 | `/v1/videos/{id}/content` 二进制 | 同 |
| data URI 兼容性 | 支持 | ⚠️ 偶发被忽略，**优先用 OSS 公网 URL** |
| 瞬时 502 | — | 偶发，需重试 |

---

*整理自官方文档，最后核对：2026-08-07*
*官方源：https://docs.x.ai/docs/guides/image-generations 、https://docs.x.ai/docs/guides/video-generations*
