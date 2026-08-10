/**
 * xAI (Grok) API 客户端。
 *
 * 这是一个纯 fetch 实现的薄封装，刻意做到零业务依赖：
 * - 不耦合项目的 store / api / axios 实例，复制到任何 TS 项目即可用；
 * - API Key 由调用方传入，由调用方决定存 localStorage 还是经后端代发；
 * - 流式接口返回 AsyncIterable，前端可直接 for await；
 * - 错误统一为 XaiError，区分网络错误 / HTTP 错误 / 业务错误，便于重试与展示。
 *
 * 官方参考：https://docs.x.ai/docs/api-reference
 */

import {
  XAI_BASE_URL,
  XAI_DEFAULT_MODELS,
  type ChatChunkDelta,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ImageEditRequest,
  type ImageGenerationRequest,
  type ImageResponse,
  type ToolDefinition,
  type XaiApiErrorBody,
} from "./types";

/** 客户端配置。baseUrl 和 apiKey 都可在单次调用时被 options 覆盖。 */
export interface XaiClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** 自定义 fetch，默认用全局 fetch。便于测试或注入超时拦截。 */
  fetchImpl?: typeof fetch;
  /** 默认请求头（如额外的追踪 id）。 */
  defaultHeaders?: Record<string, string>;
  /** 单请求超时毫秒数。流式请求不适用。 */
  timeoutMs?: number;
}

/** 统一错误类型，保留 HTTP 状态与响应体，方便上层做重试或提示。 */
export class XaiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "XaiError";
  }
}

/**
 * 单次调用的可选覆盖项。
 * model / apiKey / baseUrl 任一不传则回退到客户端默认值。
 */
export interface RequestOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** 流式 chat 返回的迭代单元：累积到当前的 delta 片段，含 content 与 tool_calls 增量。 */
export interface StreamEvent {
  delta: ChatChunkDelta;
  raw: ChatCompletionChunk;
}

export class XaiClient {
  constructor(private readonly options: XaiClientOptions) {}

  // -------------------------------------------------------------------------
  // Chat Completions
  // -------------------------------------------------------------------------

  /** 非流式对话。返回完整 choices 与 usage。 */
  async chat(
    request: Omit<ChatCompletionRequest, "stream"> & { stream?: false },
    options: RequestOptions = {},
  ): Promise<ChatCompletionResponse> {
    const { url, init } = this.buildRequest("POST", "/v1/chat/completions", request, options, false);
    const data = await this.sendJson<ChatCompletionResponse>(url, init, options.signal);
    return data;
  }

  /**
   * 流式对话。返回 AsyncIterable，逐片段产出 delta。
   *
   * 用法：
   *   for await (const ev of client.chatStream({ model, messages })) {
   *     process.stdout.write(ev.delta.content ?? "");
   *   }
   *
   * 内部解析 SSE：以 "data: " 开头的行是 JSON 片段，"data: [DONE]" 标记结束。
   */
  async *chatStream(
    request: Omit<ChatCompletionRequest, "stream">,
    options: RequestOptions = {},
  ): AsyncIterable<StreamEvent> {
    const { url, init } = this.buildRequest("POST", "/v1/chat/completions", { ...request, stream: true }, options, true);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, init);
    if (!response.ok || !response.body) {
      await this.throwFromResponse(response);
    }
    // 按 SSE 行协议解析。TextDecoderStream 处理 UTF-8 多字节边界。
    const reader = (response.body as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream())
      .getReader();

    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        // SSE 事件以空行分隔；逐事件处理避免半行 JSON。
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n\n")) >= 0) {
          const rawEvent = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 2);
          const event = this.parseSseEvent(rawEvent);
          if (!event) continue;
          if (event === "[DONE]") return;
          const chunk = event as ChatCompletionChunk;
          const delta = chunk.choices?.[0]?.delta ?? {};
          yield { delta, raw: chunk };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** 便捷方法：流式收集为完整文本字符串。丢弃 tool_calls 等其它增量。 */
  async chatText(request: Omit<ChatCompletionRequest, "stream">, options: RequestOptions = {}): Promise<string> {
    let text = "";
    for await (const ev of this.chatStream(request, options)) {
      if (ev.delta.content) text += ev.delta.content;
    }
    return text;
  }

  // -------------------------------------------------------------------------
  // Tools / Function Calling
  // -------------------------------------------------------------------------

  /**
   * 带工具调用的单轮便捷封装。
   * - 模型若返回 tool_calls，调用 onToolCall 执行并把结果作为 tool 消息回填；
   * - 多轮执行直到模型给出正常 content 或达到 maxRounds。
   * 返回最终 assistant 消息。
   */
  async chatWithTools(params: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
    /** 执行工具并返回结果字符串。返回值会原样塞进 tool 消息 content。 */
    onToolCall: (name: string, argsJson: string) => Promise<string>;
    model?: string;
    maxRounds?: number;
    options?: RequestOptions;
  }): Promise<ChatMessage> {
    const messages = [...params.messages];
    const maxRounds = params.maxRounds ?? 6;
    for (let round = 0; round < maxRounds; round++) {
      const res = await this.chat(
        { model: params.model ?? XAI_DEFAULT_MODELS.chat, messages, tools: params.tools, tool_choice: "auto" },
        params.options,
      );
      const msg = res.choices[0]?.message;
      if (!msg) throw new XaiError("chatWithTools: 无 choices 返回", 200, res);
      // 没有工具调用即视为完成。
      if (!msg.tool_calls?.length) return msg;
      messages.push(msg);
      // 逐个回填工具结果。每个 tool_call 对应一条 tool 消息。
      for (const call of msg.tool_calls) {
        const result = await params.onToolCall(call.function.name, call.function.arguments);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    throw new XaiError("chatWithTools: 超过最大工具调用轮数", 200, null);
  }

  // -------------------------------------------------------------------------
  // Embeddings
  // -------------------------------------------------------------------------

  async embed(request: EmbeddingRequest, options: RequestOptions = {}): Promise<EmbeddingResponse> {
    const { url, init } = this.buildRequest("POST", "/v1/embeddings", request, options, false);
    return this.sendJson<EmbeddingResponse>(url, init, options.signal);
  }

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  /** 文生图。返回 b64_json 或 url 列表。 */
  async generateImage(request: ImageGenerationRequest, options: RequestOptions = {}): Promise<ImageResponse> {
    const { url, init } = this.buildRequest("POST", "/v1/images/generations", request, options, false);
    return this.sendJson<ImageResponse>(url, init, options.signal);
  }

  /** 图片编辑。需在 request.image 提供原图（url 或 data URL）。 */
  async editImage(request: ImageEditRequest, options: RequestOptions = {}): Promise<ImageResponse> {
    // xAI 图片编辑复用文生图端点，靠 model 区分（grok-2-image-edit）。
    const { url, init } = this.buildRequest("POST", "/v1/images/generations", request, options, false);
    return this.sendJson<ImageResponse>(url, init, options.signal);
  }

  // -------------------------------------------------------------------------
  // 内部：请求构造与发送
  // -------------------------------------------------------------------------

  private buildRequest(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    isStream: boolean,
  ): { url: string; init: RequestInit } {
    const apiKey = options.apiKey ?? this.options.apiKey;
    const baseUrl = (options.baseUrl ?? this.options.baseUrl ?? XAI_BASE_URL).replace(/\/$/, "");
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...this.options.defaultHeaders,
      ...options.headers,
    };
    // 流式请求让 fetch 直通 body，不能用全局超时包裹。
    const init: RequestInit = {
      method,
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    };
    if (!isStream && this.options.timeoutMs) {
      // 单请求超时通过 AbortController 实现，不影响外部传入的 signal。
      init.signal = this.mergeAbort(options.signal, this.options.timeoutMs);
    }
    return { url, init };
  }

  private async sendJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, signal ? { ...init, signal } : init);
    if (!response.ok) await this.throwFromResponse(response);
    return (await response.json()) as T;
  }

  /** 把业务错误体解析后抛出 XaiError，统一上层 catch 语义。 */
  private async throwFromResponse(response: Response): Promise<never> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    const message = (body as XaiApiErrorBody | null)?.error?.message ?? `xAI 请求失败：HTTP ${response.status}`;
    throw new XaiError(message, response.status, body);
  }

  /** SSE 单事件解析：剥离前缀 "data:"，返回解析后的对象或 "[DONE]" 标记。 */
  private parseSseEvent(rawEvent: string): unknown | "[DONE]" | null {
    const lines = rawEvent.split("\n");
    const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return null;
    const data = dataLines.join("\n");
    if (data === "[DONE]") return "[DONE]";
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /** 合并外部 signal 与超时 signal，任一触发即中断。 */
  private mergeAbort(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }
    // fetch 完成后清理定时器，避免泄漏。controller.signal 一旦 abort，上层会 reject。
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    return controller.signal;
  }
}
