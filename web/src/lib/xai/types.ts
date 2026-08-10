/**
 * xAI (Grok) API 类型定义。
 *
 * 严格对齐 https://docs.x.ai/docs/api-reference，覆盖：
 * - Chat Completions（文本 + 多模态视觉 + 工具调用 + 结构化输出 + 流式）
 * - Embeddings
 * - Images（文生图 + 图片编辑）
 *
 * 设计原则：所有字段与官方文档同名同义，不引入 any，方便后续随官方迭代平移。
 */

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/** xAI 官方 Base URL。所有请求路径会拼接在其后。 */
export const XAI_BASE_URL = "https://api.x.ai" as const;

/** Chat / Embedding / Image 各端点的默认推荐模型，调用方可覆盖。 */
export const XAI_DEFAULT_MODELS = {
  /** 对话主力模型，平衡质量与速度。 */
  chat: "grok-4-fast",
  /** 视觉理解模型，处理图片输入。 */
  vision: "grok-2-vision-1212",
  /** 文本嵌入模型，3072 维。 */
  embedding: "embedding-1",
  /** 文生图模型。 */
  image: "grok-2-image",
  /** 图片编辑模型。 */
  imageEdit: "grok-2-image-edit",
} as const;

// ---------------------------------------------------------------------------
// Chat Completions
// ---------------------------------------------------------------------------

/** Chat 角色枚举。tool 角色用于回传函数调用结果。 */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 文本内容块。 */
export interface TextContent {
  type: "text";
  text: string;
}

/**
 * 图片内容块。xAI 视觉模型接受两种来源：
 * - url：公网可访问图片地址
 * - base64：data URL，格式 "data:image/png;base64,...."，避免外网回源
 */
export interface ImageContent {
  type: "image_url";
  image_url: { url: string; detail?: "high" | "low" | "auto" };
}

/** 单条消息的内容可以是纯文本，也可以是多模态内容块数组。 */
export type MessageContent = string | Array<TextContent | ImageContent>;

export interface ChatMessage {
  role: ChatRole;
  content: MessageContent;
  /** tool 角色消息必须带上对应的工具调用 id。 */
  tool_call_id?: string;
  /** assistant 消息发起工具调用时携带的调用描述。 */
  tool_calls?: ToolCall[];
  /** 可选的说话者名字，影响人格表现。 */
  name?: string;
}

/** 函数工具定义，让模型可以发起工具调用。 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema 对象，描述参数结构。直接传 JS 对象即可，无需 JSON.stringify。 */
    parameters: Record<string, unknown>;
  };
}

/** 模型发起的一次工具调用。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * 结构化输出约束。
 * 设为 { type: "json_schema", json_schema: {...} } 时，模型输出严格符合给定 JSON Schema。
 */
export interface ResponseFormatJsonSchema {
  type: "json_schema";
  json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
}

export interface ResponseFormatJsonObject {
  type: "json_object";
}

export type ResponseFormat = ResponseFormatJsonSchema | ResponseFormatJsonObject;

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** 是否流式返回。true 时调用方拿到 AsyncIterable。 */
  stream?: boolean;
  /** 采样温度，0~2，越高越发散。 */
  temperature?: number;
  /** 核采样概率，0~1，限制候选词集合。 */
  top_p?: number;
  /** 最大生成 token 数。 */
  max_tokens?: number;
  /** 可控的工具定义列表。 */
  tools?: ToolDefinition[];
  /** 强制模型调用指定工具，或禁止调用。 */
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /** 结构化输出约束。 */
  response_format?: ResponseFormat;
  /** 控制是否返回对 prompt token 的对数概率。 */
  logprobs?: boolean;
  top_logprobs?: number;
  /** 0~1，降低模型输出指定 token 的概率，用于内容安全。 */
  frequency_penalty?: number;
  presence_penalty?: number;
  /** 截断策略：当上下文超限时如何处理。xAI 支持 "auto" / "none"。 */
  truncation?: "auto" | "none";
  /** 终止序列，模型生成到任一值时停止。 */
  stop?: string | string[];
  /** 透传字段，用于追踪。 */
  user?: string;
  seed?: number;
}

/** token 用量统计。 */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** 开启 prompt caching 命中时的统计。 */
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  /** 仅在设置了 logprobs 时返回。 */
  logprobs?: unknown;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: Usage;
  system_fingerprint?: string;
}

/** 流式增量片段。delta 仅包含本次新增字段。 */
export interface ChatChunkDelta {
  role?: ChatRole;
  content?: string;
  tool_calls?: ToolCall[];
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatChunkDelta;
    finish_reason: ChatChoice["finish_reason"];
  }>;
  usage?: Usage;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingRequest {
  model: string;
  /** 单条文本或批量文本。批量时按顺序返回向量。 */
  input: string | string[];
  /** 输出编码格式。xAI 默认 float。 */
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

export interface EmbeddingData {
  object: "embedding";
  index: number;
  embedding: number[];
}

export interface EmbeddingResponse {
  object: "list";
  model: string;
  data: EmbeddingData[];
  usage: { prompt_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  /** 生成数量，1~8。 */
  n?: number;
  /** 输出格式。b64_json 便于前端直接 <img src> 展示，免去额外下载。 */
  response_format?: "url" | "b64_json";
  /** 透传字段。 */
  user?: string;
}

export interface ImageEditRequest extends ImageGenerationRequest {
  /** 待编辑的原图，公网 url 或 data URL。 */
  image: string;
  /** 可选掩码图，标记允许修改的区域。 */
  mask?: string;
}

export interface ImageData {
  /** response_format 为 url 时有值。 */
  url?: string;
  /** response_format 为 b64_json 时有值，已含 "data:image/...;base64," 前缀以外的裸 base64。 */
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageResponse {
  created: number;
  data: ImageData[];
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export interface XaiApiErrorBody {
  error: {
    message: string;
    type?: string;
    param?: string | null;
    code?: string | null;
  };
}
