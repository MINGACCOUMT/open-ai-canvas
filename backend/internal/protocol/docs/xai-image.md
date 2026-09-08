# xAI 官方图片生成

xAI 官方图片插件只发送 xAI 认的字段，绕开聚合网关对 `output_format`、`quality` 等未声明字段的 422 拒收。文生图走 `/images/generations`，带参考图的编辑走 `/images/edits`；固定 `response_format=b64_json`，避免二次下载与同源鉴权问题。

## 接口与鉴权

{{OPERATIONS}}

```http
POST {channel_base_url}/v1/images/generations
POST {channel_base_url}/v1/images/edits
Authorization: Bearer <XAI_API_KEY>
Content-Type: application/json
```

## 模型与当前支持

模型 ID（如 `grok-imagine-image`、`grok-imagine-image-quality`）、单次张数上限、参考图数量与计费以 xAI 控制台及官方文档为准。当前 adapter 编辑路径最多 3 张参考图；蒙版编辑、透明背景、输出格式选择均未实现，不能因上游可能支持就展示为已支持。

## 参数与字段映射

{{PARAMETERS}}

实际构造为：`model`、`prompt` 直传；无参考图时附带 `n`、`response_format` 与可选 `size`；单张参考图映射为顶层 `image_url` 字符串；多张参考图映射为顶层 `images:[{type,url}]` 并改用 `aspect_ratio` 表达画幅，此时 `n`、`response_format`、`size` 会被剔除（官方多图编辑合同拒收这些字段）。`quality`、`imageCount` 不会发送。

参考图必须是上游可拉取的公网 http(s) URL；data URI 会被网关静默忽略（返回 200 但输出与参考图无关），平台已在提交前把本地图转存对象存储并签发公网地址。

## 请求示例

```bash
curl "{channel_base_url}/v1/images/edits" \
  -H "Authorization: Bearer <XAI_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"grok-imagine-image",
    "prompt":"把这张图转成水彩画风格",
    "n":1,
    "response_format":"b64_json",
    "image_url":"https://example.com/character.png"
  }'
```

多图编辑（≤3 张）时：

```bash
curl "{channel_base_url}/v1/images/edits" \
  -H "Authorization: Bearer <XAI_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"grok-imagine-image",
    "prompt":"融合两张参考图的风格",
    "images":[{"type":"image_url","url":"https://example.com/a.png"},{"type":"image_url","url":"https://example.com/b.png"}],
    "aspect_ratio":"1:1"
  }'
```

## 错误处理

模型权限、无效尺寸、参考素材不可访问、内容审核、速率或余额限制必须作为真实失败展示；有参考图时禁止回退纯文生图，宁可明确报错也不产出与参考图无关的结果。若官方响应结构与通用解析器不一致，应补 xAI 专属 parser 和 fixture 测试，而不是继续堆叠模糊字段猜测。

## 官方资料

- [xAI Image Generation guide](https://docs.x.ai/docs/guides/image-generations)
- [xAI API Reference](https://docs.x.ai/docs/api-reference)

{{CONTRACT}}
