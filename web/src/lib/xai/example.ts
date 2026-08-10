/**
 * xAI (Grok) API 各能力的最小用法示例。
 *
 * 这不是运行入口，而是新项目接入 Grok 时的速查样例。
 * 复制本文件到目标项目时，只需替换 apiKey 来源（环境变量 / 后端代发 / localStorage）。
 *
 * 运行环境要求：浏览器原生 fetch（或 Node 18+）。流式依赖 ReadableStream / TextDecoderStream。
 */

import { XAI_DEFAULT_MODELS, type ChatMessage, type ToolDefinition } from "./types";
import { XaiClient } from "./client";

// 实际接入时，apiKey 应来自可信来源：环境变量、后端代发或用户在设置页填入。
const client = new XaiClient({ apiKey: process.env.XAI_API_KEY ?? "YOUR_XAI_API_KEY" });

// ---------------------------------------------------------------------------
// 1. 基础对话（非流式）
// ---------------------------------------------------------------------------
async function basicChat() {
  const res = await client.chat({
    model: XAI_DEFAULT_MODELS.chat,
    messages: [{ role: "user", content: "用一句话介绍影策这个项目" }],
  });
  console.log(res.choices[0]?.message.content);
}

// ---------------------------------------------------------------------------
// 2. 流式对话（SSE）
// ---------------------------------------------------------------------------
async function streamChat() {
  // 方式 A：逐片段处理，适合自定义渲染（打字机、token 计数）。
  for await (const ev of client.chatStream({
    model: XAI_DEFAULT_MODELS.chat,
    messages: [{ role: "user", content: "讲一个三行的科幻短句" }],
  })) {
    process.stdout.write(ev.delta.content ?? "");
  }

  // 方式 B：直接拿完整文本。
  const text = await client.chatText({ model: XAI_DEFAULT_MODELS.chat, messages: [] });
  console.log(text);
}

// ---------------------------------------------------------------------------
// 3. 多模态视觉：图片理解
// ---------------------------------------------------------------------------
async function visionChat() {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "这张图里是什么？用中文描述。" },
        // 两种图片来源：公网 url 或 data URL（base64）。
        { type: "image_url", image_url: { url: "https://example.com/photo.jpg", detail: "high" } },
      ],
    },
  ];
  const res = await client.chat({ model: XAI_DEFAULT_MODELS.vision, messages });
  console.log(res.choices[0]?.message.content);
}

// ---------------------------------------------------------------------------
// 4. 结构化输出：强制返回符合 JSON Schema 的对象
// ---------------------------------------------------------------------------
async function structuredOutput() {
  const res = await client.chat({
    model: XAI_DEFAULT_MODELS.chat,
    messages: [{ role: "user", content: "抽取这句话的角色：张三愤怒地摔门而出" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "character",
        strict: true,
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            emotion: { type: "string" },
          },
          required: ["name", "emotion"],
          additionalProperties: false,
        },
      },
    },
  });
  // response_format 保证返回可解析的 JSON 字符串。
  const character = JSON.parse(res.choices[0].message.content as string);
  console.log(character); // { name: "张三", emotion: "愤怒" }
}

// ---------------------------------------------------------------------------
// 5. 工具 / 函数调用：模型自主决定调用，多轮往返
// ---------------------------------------------------------------------------
async function toolCalling() {
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "查询指定城市的实时天气",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    },
  ];

  const finalMessage = await client.chatWithTools({
    messages: [{ role: "user", content: "北京今天天气怎么样？" }],
    tools,
    model: XAI_DEFAULT_MODELS.chat,
    async onToolCall(name, argsJson) {
      // 真实场景：这里调用你的天气 API。返回值原样回填给模型。
      const { city } = JSON.parse(argsJson);
      return `${city}：晴，25℃`;
    },
  });
  console.log(finalMessage.content); // "北京今天晴，气温 25 摄氏度..."
}

// ---------------------------------------------------------------------------
// 6. Embeddings：文本向量化（语义检索、聚类）
// ---------------------------------------------------------------------------
async function embedding() {
  const res = await client.embed({
    model: XAI_DEFAULT_MODELS.embedding,
    input: ["影策", "AI 影视创作工作台"],
  });
  // res.data[0].embedding 是 3072 维浮点数组，可用余弦相似度做检索。
  console.log(res.data[0].embedding.length); // 3072
}

// ---------------------------------------------------------------------------
// 7. 文生图
// ---------------------------------------------------------------------------
async function imageGeneration() {
  const res = await client.generateImage({
    model: XAI_DEFAULT_MODELS.image,
    prompt: "赛博朋克风格的城市夜景，霓虹灯，电影感构图",
    n: 2,
    // b64_json 直接可嵌入 <img src="data:image/png;base64,...">，免去外网回源。
    response_format: "b64_json",
  });
  for (const img of res.data) {
    console.log(`data:image/png;base64,${img.b64_json}`.slice(0, 60) + "...");
  }
}

// ---------------------------------------------------------------------------
// 8. 图片编辑
// ---------------------------------------------------------------------------
async function imageEdit() {
  const res = await client.editImage({
    model: XAI_DEFAULT_MODELS.imageEdit,
    prompt: "把背景改成黄昏",
    image: "https://example.com/original.jpg",
    n: 1,
    response_format: "b64_json",
  });
  console.log("编辑完成，共", res.data.length, "张");
}

// 仅供文档展示，不会自动执行。
export { basicChat, streamChat, visionChat, structuredOutput, toolCalling, embedding, imageGeneration, imageEdit };
