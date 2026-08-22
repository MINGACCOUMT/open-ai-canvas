import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { createGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export type BackendGenerationMode = "text" | "image" | "video" | "audio";

export type BackendGenerationResult = {
    mode?: BackendGenerationMode;
    images?: Array<{ dataUrl: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string }>;
    video?: { dataUrl: string; storageKey?: string; width?: number; height?: number; durationMs?: number; bytes?: number; mimeType?: string };
    audio?: { dataUrl: string; storageKey?: string; durationMs?: number; bytes?: number; mimeType?: string; format?: string };
    text?: string;
};

type BackendGenerationTaskOptions = {
    projectId?: string;
    mode: BackendGenerationMode;
    prompt: string;
    config: AiConfig;
    referenceImages?: ReferenceImage[];
    referenceVideos?: ReferenceVideo[];
    referenceAudios?: ReferenceAudio[];
    mask?: ReferenceImage;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    onTaskUpdate?: (task: GenerationTask) => void;
};

type PreparedGenerationReferences = {
    referenceImages: Awaited<ReturnType<typeof prepareBackendImageReference>>[];
    referenceVideos: Awaited<ReturnType<typeof prepareBackendMediaReference>>[];
    referenceAudios: Awaited<ReturnType<typeof prepareBackendMediaReference>>[];
    mask?: Awaited<ReturnType<typeof prepareBackendImageReference>>;
};

// 生成、计费、取消和任务记录必须共用后端任务生命周期，页面层不能再直连供应商。
export async function runBackendGenerationTask({
    projectId,
    mode,
    prompt,
    config,
    referenceImages = [],
    referenceVideos = [],
    referenceAudios = [],
    mask,
    signal,
    metadata,
    onTaskUpdate,
}: BackendGenerationTaskOptions) {
    throwIfAborted(signal);
    const prepared = await prepareGenerationReferences({ referenceImages, referenceVideos, referenceAudios, mask });
    throwIfAborted(signal);
    return createAndWaitGenerationTask({ projectId, mode, prompt, config, referenceImages, referenceVideos, signal, metadata, onTaskUpdate }, prepared);
}

export async function runBackendGenerationTaskBatch(options: BackendGenerationTaskOptions & { count: number }) {
    const count = Math.max(1, Math.min(15, Math.floor(Number(options.count)) || 1));
    throwIfAborted(options.signal);
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    return Promise.allSettled(Array.from({ length: count }, (_, batchIndex) => createAndWaitGenerationTask({
        ...options,
        metadata: { ...options.metadata, batchIndex, batchCount: count },
    }, prepared)));
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function prepareGenerationReferences({ referenceImages = [], referenceVideos = [], referenceAudios = [], mask }: Pick<BackendGenerationTaskOptions, "referenceImages" | "referenceVideos" | "referenceAudios" | "mask">): Promise<PreparedGenerationReferences> {
    const preparedImages = await Promise.all(referenceImages.map(prepareBackendImageReference));
    const preparedVideos = await Promise.all(referenceVideos.map(prepareBackendMediaReference));
    const preparedAudios = await Promise.all(referenceAudios.map(prepareBackendMediaReference));
    const preparedMask = mask ? await prepareBackendImageReference(mask) : undefined;
    return { referenceImages: preparedImages, referenceVideos: preparedVideos, referenceAudios: preparedAudios, mask: preparedMask };
}

async function createAndWaitGenerationTask({ projectId, mode, prompt, config, referenceImages = [], signal, metadata, onTaskUpdate }: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences) {
    const videoOperation = String(metadata?.videoEditOperation || (referenceImages.length ? "image_to_video" : "text_to_video"));
    const task = await createGenerationTask({
        ...(projectId ? { projectId } : {}),
        type: `canvas_${mode}`,
        operation: mode === "video" ? videoOperation : mode,
        prompt,
        model: config.model,
        input: {
            mode,
            prompt,
            config: backendProviderConfig(config),
            referenceImages: prepared.referenceImages,
            referenceVideos: prepared.referenceVideos,
            referenceAudios: prepared.referenceAudios,
            mask: prepared.mask,
            metadata,
        },
    });
    onTaskUpdate?.(task);
    const completed = await waitForGenerationTask(task.id, { signal, initialTask: task, onTaskUpdate });
    return parseBackendGenerationResult(completed);
}

async function prepareBackendMediaReference(media: ReferenceVideo | ReferenceAudio) {
    if (resourceIdFromStorageKey(media.storageKey)) return backendMediaReference(media, { storageKey: media.storageKey });
    const url = media.url || "";
    if (/^https?:\/\//i.test(url)) return backendMediaReference(media, { url });
    let blob: Blob | null = null;
    if (media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && (url.startsWith("blob:") || url.startsWith("data:"))) blob = await (await fetch(url)).blob();
    if (!blob) throw new Error("参考媒体尚未保存，请重新上传后再生成");
    try {
        const kind: "video" | "audio" | "file" = blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
        const resource = await uploadResourceFile(blob, kind, { fileName: media.name, width: "width" in media ? media.width : undefined, height: "height" in media ? media.height : undefined, durationMs: media.durationMs });
        return backendMediaReference(media, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || media.type || blob.type });
    } catch (error) {
        throw new Error(error instanceof Error ? `参考媒体上传失败：${error.message}` : "参考媒体上传失败");
    }
}

async function prepareBackendImageReference(image: ReferenceImage) {
    image = await ensureUpstreamCompatibleImageReference(image);
    if (resourceIdFromStorageKey(image.storageKey)) return backendImageReference(image, { storageKey: image.storageKey });
    const sourceUrl = image.url || image.dataUrl;
    if (/^https?:\/\//i.test(sourceUrl)) return backendImageReference(image, { url: sourceUrl });
    const blob = image.storageKey ? await getImageBlob(image.storageKey) : sourceUrl ? await (await fetch(sourceUrl)).blob() : null;
    if (!blob) throw new Error("参考图片尚未保存，请重新上传后再生成");
    try {
        const resource = await uploadResourceFile(blob, "image", { fileName: image.name });
        return backendImageReference(image, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || image.type || blob.type });
    } catch (error) {
        throw new Error(error instanceof Error ? `参考图片上传失败：${error.message}` : "参考图片上传失败");
    }
}

// AVIF 参考图在部分聚合渠道会被静默丢弃并返回与参考无关的模板图（实测 grok-imagine 渠道），
// 浏览器端统一转 JPEG 再交给后端，规避各渠道图片解码差异；后端标准库不支持 AVIF，只能在前端转。
async function ensureUpstreamCompatibleImageReference(image: ReferenceImage): Promise<ReferenceImage> {
    if (!isAvifReference(image)) return image;
    const blob = await resolveReferenceImageBlob(image);
    if (!blob) throw new Error("AVIF 参考图读取失败，请重新上传后再生成");
    try {
        const jpegBlob = await convertImageBlobToJpeg(blob);
        const fileName = `${(image.name || "参考图").replace(/\.[^.]+$/, "")}.jpg`;
        const resource = await uploadResourceFile(jpegBlob, "image", { fileName, width: image.width, height: image.height });
        return backendImageReference(image, { storageKey: resourceStorageKey(resource.id), type: "image/jpeg" });
    } catch (error) {
        if (error instanceof Error && error.message.includes("参考图片上传失败")) throw error;
        throw new Error(error instanceof Error ? `AVIF 参考图转码失败：${error.message}` : "AVIF 参考图转码失败");
    }
}

function isAvifReference(image: ReferenceImage) {
    if ((image.type || "").toLowerCase() === "image/avif") return true;
    return [image.url, image.dataUrl, image.storageKey].some((value) => /\.avif($|[?#])/i.test(value || ""));
}

async function resolveReferenceImageBlob(image: ReferenceImage): Promise<Blob | null> {
    if (image.storageKey) {
        const cached = await getImageBlob(image.storageKey);
        if (cached) return cached;
    }
    const sourceUrl = image.url || image.dataUrl;
    if (!sourceUrl) return null;
    try {
        return await (await fetch(sourceUrl)).blob();
    } catch {
        return null;
    }
}

async function convertImageBlobToJpeg(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建画布");
        context.drawImage(bitmap, 0, 0);
        const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
        if (!jpeg) throw new Error("JPEG 编码失败");
        return jpeg;
    } finally {
        bitmap.close();
    }
}

// 任务输入只允许后端协议字段，避免把 previewUrl 等页面态 Data URL 带入强校验写路径。
function backendImageReference(image: ReferenceImage, override: Partial<ReferenceImage>): ReferenceImage {
    return {
        id: image.id,
        name: image.name,
        type: override.type || image.type,
        dataUrl: "",
        url: override.url,
        storageKey: override.storageKey,
        ...(image.bytes ? { bytes: image.bytes } : {}),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
    };
}

function backendMediaReference<T extends ReferenceVideo | ReferenceAudio>(media: T, override: Partial<T>): T {
    return {
        id: media.id,
        name: media.name,
        type: override.type || media.type,
        url: override.url || "",
        storageKey: override.storageKey,
        ...("bytes" in media && media.bytes ? { bytes: media.bytes } : {}),
        ...("width" in media && media.width ? { width: media.width } : {}),
        ...("height" in media && media.height ? { height: media.height } : {}),
        ...(media.durationMs ? { durationMs: media.durationMs } : {}),
    } as T;
}

export function backendProviderConfig(config: AiConfig) {
    const requestConfig = resolveModelRequestConfig(config, config.model);
    return {
        channelId: requestConfig.channelId,
        apiFormat: requestConfig.apiFormat,
        interfaceType: requestConfig.interfaceType,
        baseUrl: requestConfig.baseUrl,
        apiKey: requestConfig.apiKey,
        secretKey: requestConfig.secretKey,
        model: requestConfig.model,
        size: config.size,
        quality: config.quality,
        transparentBackground: config.transparentBackground,
        count: config.count,
        videoSeconds: config.videoSeconds,
        vquality: config.vquality,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
        capabilityConfig: modelCapabilityConfigFor(config, requestConfig.model),
        systemPrompt: "",
    };
}

export function parseBackendGenerationResult(task: GenerationTask): BackendGenerationResult {
    if (!task.resultJson) throw new Error("后端任务没有返回结果");
    const result = JSON.parse(task.resultJson) as BackendGenerationResult;
    if (!result || typeof result !== "object") throw new Error("后端任务结果格式错误");
    return result;
}
