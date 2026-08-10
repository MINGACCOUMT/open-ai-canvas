/**
 * xAI (Grok) API 工具类统一出口。
 *
 * 典型用法：
 *   import { XaiClient, XAI_DEFAULT_MODELS } from "@/lib/xai";
 *   const client = new XaiClient({ apiKey: import.meta.env.VITE_XAI_API_KEY });
 *
 * 详细示例见 ./example.ts。
 */

export * from "./types";
export { XaiClient, XaiError } from "./client";
export type { XaiClientOptions, RequestOptions, StreamEvent } from "./client";
