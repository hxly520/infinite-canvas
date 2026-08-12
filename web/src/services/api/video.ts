import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import {
    boolConfig,
    buildSeedancePromptText,
    isArkPlanBaseUrl,
    isSeedancePerSecondModel,
    isSeedanceVideoModel,
    normalizeSeedanceDuration,
    normalizeSeedanceRatio,
    normalizeSeedanceResolution,
    normalizeVideoReferenceMode,
    seedanceFixedResolution,
    seedanceVideoReferenceError,
    SEEDANCE_REFERENCE_LIMITS,
} from "@/lib/seedance-video";
import { buildApiUrl, modelMatchesCapability, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo, VideoGenerationResult, VideoGenerationTask, VideoGenerationTaskState } from "@/types/media";

export type { VideoGenerationResult, VideoGenerationTask, VideoGenerationTaskState } from "@/types/media";

type VideoResponse = {
    id?: string;
    request_id?: string;
    task_id?: string;
    status?: string;
    state?: string;
    error?: { message?: string } | string | null;
    data?: VideoResponse | VideoResponse[] | null;
    result?: VideoResponse | VideoResponse[] | string | null;
    raw_data?: VideoResponse | VideoResponse[] | null;
    video?: VideoResponse | string | null;
    result_url?: string;
    url?: string;
    video_url?: string;
    output?: string | VideoResponse | Array<string | VideoResponse>;
    content?: VideoResponse | string | null;
};
type ApiVideoResponse = VideoResponse | { code?: number; data?: VideoResponse | null; msg?: string };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; last_frame_url?: string } | null;
};
type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string };
type RequestOptions = {
    signal?: AbortSignal;
    task?: VideoGenerationTask;
    idempotencyKey?: string;
    onTaskChange?: (task: VideoGenerationTask) => void | Promise<void>;
};

export type VideoReferenceLimits = { images: number; videos: number; audios: number };

const OPENAI_VIDEO_POLL_DELAY_MS = 5000;
const OPENAI_VIDEO_MAX_ATTEMPTS = 360;
const MANAGED_VIDEO_ORIGIN = "https://video.52token.org";
const EDGE_VIDEO_PATH_PREFIX = "/v1/video-content/";
const pluginVideoResults = new Map<string, VideoGenerationResult>();

export class VideoGenerationTerminalError extends Error {
    constructor(
        message: string,
        readonly canCreateReplacement = false,
    ) {
        super(message);
        this.name = "VideoGenerationTerminalError";
    }
}

export class VideoGenerationPollingPausedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VideoGenerationPollingPausedError";
    }
}

export function videoReferenceLimits(model: string, referenceMode = "auto"): VideoReferenceLimits {
    const value = modelOptionName(model).toLowerCase();
    if (normalizeVideoReferenceMode(referenceMode) === "frames" && (isSeedanceVideoModel(value) || value.includes("omni-fast"))) return { images: 2, videos: 0, audios: 0 };
    if (value.includes("grok") && value.includes("1.5")) return { images: 1, videos: 0, audios: 0 };
    if (value.includes("grok")) return { images: 7, videos: 1, audios: 0 };
    if (isSeedancePerSecondModel(value)) return { images: 9, videos: 3, audios: 3 };
    if (isSeedanceVideoModel(value)) return { images: 4, videos: 3, audios: 1 };
    if (value.includes("omni-v2v")) return { images: 0, videos: 1, audios: 0 };
    if (value.includes("omni")) return { images: 5, videos: 0, audios: 0 };
    if (value.includes("sora")) return { images: 1, videos: 0, audios: 0 };
    if (value.includes("veo")) return { images: isVeoReferenceModel(value) ? 3 : 2, videos: 0, audios: 0 };
    return { images: 7, videos: 3, audios: 3 };
}

class VideoGenerationPollRequestError extends Error {
    constructor(
        message: string,
        readonly retryable: boolean,
    ) {
        super(message);
        this.name = "VideoGenerationPollRequestError";
    }
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string, extra?: Record<string, string>) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...(extra || {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = options?.task ? refreshVideoTaskWindow(options.task, resolveTaskRequestConfig(config, options.task)) : await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    await options?.onTaskChange?.(serializableVideoTask(task));
    if (task.result) return task.result;
    return waitForVideoGenerationTask(config, task, options);
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = selectVideoModel(config);
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    const task = isArkPlanBaseUrl(requestConfig.baseUrl)
        ? await createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options)
        : await createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    return refreshVideoTaskWindow({ ...task, baseUrl: requestConfig.baseUrl }, requestConfig);
}

function selectVideoModel(config: AiConfig) {
    const currentModel = config.model.trim();
    if (currentModel && modelMatchesCapability(config, currentModel, "video")) return currentModel;
    const configuredVideoModel = config.videoModel.trim();
    if (configuredVideoModel && modelMatchesCapability(config, configuredVideoModel, "video")) return configuredVideoModel;
    return "";
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.result) return { status: "completed", result: task.result };
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: "插件视频任务已失效，请重新生成" };
    }
    const requestConfig = resolveTaskRequestConfig(config, task);
    assertVideoConfig(requestConfig, requestConfig.model);
    return task.provider === "seedance" ? pollSeedanceTask(requestConfig, task, options) : pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    const images = await Promise.all(references.map(imageToDataUrl));
    const raw = await runModelPlugin({
        capability: "video",
        script,
        config,
        prompt,
        images,
        params: { seconds: normalizeVideoSeconds(config.videoSeconds), size: normalizeVideoSize(config.size), resolution: normalizeVideoResolution(config.vquality), ratio: config.size, generateAudio: boolConfig(config.videoGenerateAudio, true), watermark: boolConfig(config.videoWatermark, false) },
        signal: options?.signal,
    });
    const result = await materializePluginVideoResult(pluginVideoResult(raw), config, options);
    const id = `plugin-${createVideoGenerationIdempotencyKey()}`;
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function pluginVideoResult(value: unknown): VideoGenerationResult {
    if (value instanceof Blob) return { blob: value };
    if (typeof value === "string") return { url: value, mimeType: "video/mp4" };
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((item): item is string => typeof item === "string" && Boolean(item));
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error("模型调用脚本没有返回视频");
}

async function materializePluginVideoResult(result: VideoGenerationResult, config: AiConfig, options?: RequestOptions): Promise<VideoGenerationResult> {
    if (result.blob) {
        await assertVideoBlob(result.blob);
        return result;
    }
    if (!result.url) throw new Error("模型调用脚本没有返回视频");
    return videoResultFromUrl(result.url, config, options);
}

export async function waitForVideoGenerationTask(config: AiConfig, sourceTask: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = refreshVideoTaskWindow(sourceTask, resolveTaskRequestConfig(config, sourceTask));
    await options?.onTaskChange?.(serializableVideoTask(task));
    if (task.result) return task.result;

    const delayMs = task.pollDelayMs ?? OPENAI_VIDEO_POLL_DELAY_MS;
    const maxAttempts = task.maxAttempts ?? OPENAI_VIDEO_MAX_ATTEMPTS;
    let lastTransientError = "";
    for (let attempt = 0; attempt < maxAttempts && Date.now() < (task.deadlineAt || Number.MAX_SAFE_INTEGER); attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const state = await pollVideoGenerationTask(config, task, options);
            if (state.status === "completed") return state.result;
            if (state.status === "failed") throw new VideoGenerationTerminalError(state.error, true);
            lastTransientError = "";
        } catch (error) {
            if (isRequestCanceled(error, options?.signal)) throw error;
            if (error instanceof VideoGenerationTerminalError) throw error;
            if (error instanceof VideoGenerationPollRequestError && !error.retryable) throw new VideoGenerationTerminalError(error.message);
            lastTransientError = error instanceof Error ? error.message : "视频任务查询暂时失败";
        }
        await delay(delayMs, options?.signal);
    }
    const detail = lastTransientError ? `：${lastTransientError}` : "";
    throw new VideoGenerationPollingPausedError(`视频仍在处理中，查询已暂停${detail}。继续查询不会重新创建任务或重复扣费`);
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    throw new Error("视频接口没有返回可播放的视频");
}

type OpenAIVideoAdapter = {
    kind: "videos-json" | "video-generations-json" | "legacy-multipart";
    payloadBuilder: "seedance-flat" | "grok" | "omni-frame" | "omni-v2v" | "sora2" | "veo" | "generic";
    label: string;
    createPath: string;
    statusPathBase: string;
    contentPathBase: string;
    pollDelayMs: number;
    maxAttempts: number;
};

function openAIVideoAdapter(model: string): OpenAIVideoAdapter {
    const value = model.toLowerCase();
    if (isSeedanceVideoModel(value)) return openAIVideosAdapter("seedance-flat", "Seedance 视频");
    if (value.includes("grok") && (value.includes("video") || value.includes("vedio"))) {
        return openAIVideosAdapter("grok", "Grok 视频");
    }
    if (value.includes("omni-v2v")) return openAIVideosAdapter("omni-v2v", "Omni 视频转视频");
    if (value.includes("omni")) return openAIVideosAdapter("omni-frame", "Omni 视频");
    if (value.includes("sora")) return openAIVideosAdapter("sora2", "Sora 视频");
    if (value.includes("veo")) return openAIVideosAdapter("veo", "Veo 视频");
    if (value.includes("video") || value.includes("vedio") || value.includes("kling") || value.includes("wan") || value.includes("hailuo")) {
        return openAIVideosAdapter("generic", "视频");
    }
    return {
        kind: "legacy-multipart",
        payloadBuilder: "generic",
        label: "视频",
        createPath: "/videos",
        statusPathBase: "/videos",
        contentPathBase: "/videos",
        pollDelayMs: OPENAI_VIDEO_POLL_DELAY_MS,
        maxAttempts: OPENAI_VIDEO_MAX_ATTEMPTS,
    };
}

function openAIVideosAdapter(payloadBuilder: OpenAIVideoAdapter["payloadBuilder"], label: string): OpenAIVideoAdapter {
    return {
        kind: "videos-json",
        payloadBuilder,
        label,
        createPath: "/videos",
        statusPathBase: "/videos",
        contentPathBase: "/videos",
        pollDelayMs: OPENAI_VIDEO_POLL_DELAY_MS,
        maxAttempts: OPENAI_VIDEO_MAX_ATTEMPTS,
    };
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const adapter = openAIVideoAdapter(modelOptionName(model));
    if (adapter.payloadBuilder === "omni-frame" && references.length > 1 && normalizeVideoReferenceMode(config.videoReferenceMode) !== "frames") {
        return createOpenAIVideoMultipartTask(config, model, prompt, references, videoReferences, audioReferences, adapter, options);
    }
    if (adapter.payloadBuilder === "omni-v2v" && videoReferences.length === 1 && !isPublicMediaUrl(videoReferences[0].url)) {
        return createOpenAIVideoMultipartTask(config, model, prompt, references, videoReferences, audioReferences, adapter, options);
    }
    if (adapter.kind !== "legacy-multipart") {
        return createOpenAIVideoJSONTask(config, model, prompt, references, videoReferences, audioReferences, adapter, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error("当前通用视频接口不支持参考视频或参考音频，请切换到 Seedance / Omni / Grok 视频模型，或移除参考素材");
    }
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, {
                    headers: aiHeaders(config, undefined, { "Idempotency-Key": options?.idempotencyKey || createVideoGenerationIdempotencyKey() }),
                    signal: options?.signal,
                })
            ).data,
        );
        return openAIVideoTaskFromCreateResponse(config, created, { model, statusPathBase: "/videos", contentPathBase: "/videos", pollDelayMs: OPENAI_VIDEO_POLL_DELAY_MS, maxAttempts: OPENAI_VIDEO_MAX_ATTEMPTS }, options);
    } catch (error) {
        if (error instanceof VideoGenerationTerminalError) throw error;
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function createOpenAIVideoMultipartTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], adapter: OpenAIVideoAdapter, options?: RequestOptions) {
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt.trim());
    const aspectRatio = normalizeOpenAIVideoAspectRatio(config.size);
    if (aspectRatio) body.append("aspect_ratio", aspectRatio);

    if (adapter.payloadBuilder === "omni-frame") {
        if (videoReferences.length || audioReferences.length) throw new Error("Omni 图生视频暂不支持参考视频或参考音频");
        assertReferenceLimit(references, 5, "参考图");
        const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        files.forEach((file) => body.append("input_reference", file));
    } else {
        if (references.length || audioReferences.length || videoReferences.length !== 1) throw new Error("Omni V2V 需要且只能使用 1 个参考视频");
        const blob = await resolveReferenceMediaBlob(videoReferences[0]);
        if (!blob) throw new Error("Omni V2V 本地参考视频读取失败，请重新上传");
        if (blob.size > 5 * 1024 * 1024) throw new Error("Omni V2V 参考视频不能超过 5MB");
        body.append("input_video", new File([blob], videoReferences[0].name || "input.mp4", { type: blob.type || videoReferences[0].type || "video/mp4" }));
    }

    try {
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(aiApiUrl(config, adapter.createPath), body, {
                    headers: aiHeaders(config, undefined, { "Idempotency-Key": options?.idempotencyKey || createVideoGenerationIdempotencyKey() }),
                    signal: options?.signal,
                })
            ).data,
        );
        return openAIVideoTaskFromCreateResponse(config, created, { model, statusPathBase: adapter.statusPathBase, contentPathBase: adapter.contentPathBase, pollDelayMs: adapter.pollDelayMs, maxAttempts: adapter.maxAttempts }, options);
    } catch (error) {
        if (error instanceof VideoGenerationTerminalError) throw error;
        throw new Error(readAxiosError(error, `${adapter.label}任务创建失败`));
    }
}

async function buildOpenAIVideoPayload(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], adapter: OpenAIVideoAdapter) {
    const requestModel = modelOptionName(model);
    const imageUrls = await Promise.all(references.map((image) => resolveSeedanceImageUrl(config, image)));
    const requiresHttpsReferenceMedia = adapter.payloadBuilder === "seedance-flat" || adapter.payloadBuilder === "grok";
    const videoUrls = await Promise.all(videoReferences.map((video) => resolveSeedanceVideoUrl(video, requiresHttpsReferenceMedia)));
    const audioUrls = await Promise.all(audioReferences.map((audio) => resolveSeedanceAudioUrl(audio, requiresHttpsReferenceMedia)));
    const aspectRatio = normalizeOpenAIVideoAspectRatio(config.size);
    const resolution = normalizeOpenAIVideoResolution(config.vquality, requestModel);
    const seconds = Number(normalizeVideoSeconds(config.videoSeconds));
    const referenceMode = normalizeVideoReferenceMode(config.videoReferenceMode);
    const payload: Record<string, unknown> = {
        model: requestModel,
        prompt: prompt.trim(),
    };

    if (aspectRatio) payload.aspect_ratio = aspectRatio;

    switch (adapter.payloadBuilder) {
        case "seedance-flat": {
            if (referenceMode === "frames") {
                if (imageUrls.length !== 2 || videoUrls.length || audioUrls.length) throw new Error("Seedance 首尾帧模式需要且只能使用 2 张参考图，不能同时添加参考视频或音频");
            } else if (audioUrls.length && !imageUrls.length && !videoUrls.length) {
                throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
            }
            assertSeedanceVideoReferences(videoReferences, requestModel);
            assertSeedanceAudioReferences(audioReferences);
            const perSecond = isSeedancePerSecondModel(requestModel);
            assertReferenceLimit(imageUrls, perSecond ? 9 : 4, "参考图");
            assertReferenceLimit(videoUrls, 3, "参考视频");
            assertReferenceLimit(audioUrls, perSecond ? 3 : 1, "参考音频");
            if (referenceMode !== "frames" && (videoUrls.length || audioUrls.length) && !imageUrls.length) throw new Error("Seedance 参考视频或音频需要至少同时添加 1 张参考图");
            payload.prompt = referenceMode === "frames" ? prompt.trim() : buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
            const duration = normalizeSeedanceDuration(config.videoSeconds);
            payload.duration = duration > 0 ? duration : 5;
            if (!perSecond) {
                payload.resolution = normalizeSeedanceModelResolution(config.vquality, requestModel);
                payload.audio = boolConfig(config.videoGenerateAudio, true);
            }
            if (referenceMode === "frames") {
                payload.first_image_url = imageUrls[0];
                payload.last_image_url = imageUrls[1];
            } else {
                applySeedanceImageReferences(payload, imageUrls);
                if (videoUrls.length) payload.reference_videos = videoUrls;
                if (audioUrls.length) payload.reference_audios = audioUrls;
            }
            return payload;
        }
        case "grok": {
            if (audioUrls.length) throw new Error("Grok 视频接口暂不支持参考音频");
            const grok15 = requestModel.toLowerCase().includes("1.5");
            if (grok15) {
                if (imageUrls.length !== 1) throw new Error("Grok 1.5 视频必须且只能使用 1 张参考图");
                if (videoUrls.length) throw new Error("Grok 1.5 视频不支持参考视频");
                payload.aspect_ratio = ["16:9", "9:16"].includes(aspectRatio) ? aspectRatio : "16:9";
            } else {
                assertReferenceLimit(imageUrls, 7, "参考图");
                assertReferenceLimit(videoUrls, 1, "参考视频");
            }
            const duration = normalizeAllowedDuration(seconds, [4, 6, 8, 10, 12, 15], 6);
            payload.seconds = imageUrls.length > 1 ? Math.min(duration, 10) : duration;
            payload.resolution = resolution === "480p" ? "480p" : "720p";
            if (imageUrls.length) payload.image_urls = imageUrls;
            if (videoUrls.length) payload.video_url = videoUrls[0];
            return payload;
        }
        case "omni-v2v": {
            if (imageUrls.length || audioUrls.length) throw new Error("Omni V2V 仅支持 1 个参考视频，请移除参考图或参考音频");
            if (videoUrls.length !== 1) throw new Error("Omni V2V 需要且只能使用 1 个参考视频");
            payload.video_url = videoUrls[0];
            payload.aspect_ratio = normalizeTwoWayAspectRatio(aspectRatio);
            return payload;
        }
        case "omni-frame": {
            if (videoUrls.length || audioUrls.length) throw new Error("Omni 图生视频暂不支持参考视频或参考音频");
            if (referenceMode === "frames") {
                if (!imageUrls.length || imageUrls.length > 2) throw new Error("Omni 首尾帧模式需要 1 张首帧或 2 张首尾帧参考图");
                payload.aspect_ratio = normalizeTwoWayAspectRatio(aspectRatio);
                payload.first_image_url = imageUrls[0];
                if (imageUrls[1]) payload.last_image_url = imageUrls[1];
                return payload;
            }
            assertReferenceLimit(imageUrls, 5, "参考图");
            payload.aspect_ratio = normalizeTwoWayAspectRatio(aspectRatio);
            applyImageReferences(payload, imageUrls);
            return payload;
        }
        case "sora2": {
            if (videoUrls.length || audioUrls.length) throw new Error("Sora 视频接口暂不支持参考视频或参考音频");
            assertReferenceLimit(imageUrls, 1, "参考图");
            const duration = normalizeSoraDuration(config.videoSeconds);
            payload.duration = duration;
            payload.aspect_ratio = normalizeTwoWayAspectRatio(aspectRatio);
            payload.generate_audio = boolConfig(config.videoGenerateAudio, true);
            if (imageUrls.length) {
                payload.reference_mode = "frame";
                payload.images = imageUrls;
            }
            return payload;
        }
        case "veo": {
            if (videoUrls.length || audioUrls.length) throw new Error("Veo 视频接口不支持参考视频或参考音频");
            const veoReferenceMode = isVeoReferenceModel(requestModel) ? "image" : "frame";
            assertReferenceLimit(imageUrls, veoReferenceMode === "image" ? 3 : 2, "参考图");
            payload.duration = normalizeAllowedDuration(seconds, [4, 6, 8], 6);
            payload.resolution = resolution === "1080p" ? "1080p" : "720p";
            payload.aspect_ratio = normalizeTwoWayAspectRatio(aspectRatio);
            payload.generate_audio = boolConfig(config.videoGenerateAudio, true);
            if (imageUrls.length) {
                payload.reference_mode = veoReferenceMode;
                payload.images = imageUrls;
            }
            return payload;
        }
        default: {
            payload.seconds = seconds;
            payload.duration = seconds;
            payload.resolution = resolution;
            applyImageReferences(payload, imageUrls);
            if (videoUrls.length) payload.reference_videos = videoUrls;
            if (audioUrls.length) payload.reference_audios = audioUrls;
            return payload;
        }
    }
}

async function openAIVideoTaskFromCreateResponse(config: AiConfig, created: VideoResponse, defaults: Omit<VideoGenerationTask, "id" | "provider">, options?: RequestOptions): Promise<VideoGenerationTask> {
    const id = extractVideoTaskId(created);
    const status = normalizeTaskStatus(extractVideoStatus(created));
    const url = extractVideoResultUrl(created);
    if ((status === "completed" || (!id && url)) && url) {
        const task = { ...defaults, id: id || `completed-${Date.now()}`, provider: "openai" as const };
        if (resolveManagedVideoDownload(url, config)) {
            try {
                return { ...task, result: await videoResultFromUrl(url, config, options) };
            } catch {
                if (id) return task;
            }
        }
        if (id) return task;
        throw new Error("视频接口返回了外部媒体地址，且没有可用于中转下载的公开任务 ID");
    }
    if (status === "failed") throw new VideoGenerationTerminalError(extractVideoError(created) || "视频生成失败", true);
    if (!id) throw new Error("视频接口没有返回任务 ID");
    return { ...defaults, id, provider: "openai" };
}

async function createOpenAIVideoJSONTask(
    config: AiConfig,
    model: string,
    prompt: string,
    references: ReferenceImage[],
    videoReferences: ReferenceVideo[],
    audioReferences: ReferenceAudio[],
    adapter: OpenAIVideoAdapter,
    options?: RequestOptions,
): Promise<VideoGenerationTask> {
    const payload = await buildOpenAIVideoPayload(config, model, prompt, references, videoReferences, audioReferences, adapter);
    try {
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(aiApiUrl(config, adapter.createPath), payload, {
                    headers: aiHeaders(config, "application/json", { "Idempotency-Key": options?.idempotencyKey || createVideoGenerationIdempotencyKey() }),
                    signal: options?.signal,
                })
            ).data,
        );
        return openAIVideoTaskFromCreateResponse(
            config,
            created,
            {
                model,
                statusPathBase: adapter.statusPathBase,
                contentPathBase: adapter.contentPathBase,
                pollDelayMs: adapter.pollDelayMs,
                maxAttempts: adapter.maxAttempts,
            },
            options,
        );
    } catch (error) {
        if (error instanceof VideoGenerationTerminalError) throw error;
        throw new Error(readAxiosError(error, `${adapter.label}任务创建失败`));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const statusPathBase = task.statusPathBase || "/videos";
    const contentPathBase = task.contentPathBase || statusPathBase;
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `${statusPathBase}/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const status = normalizeTaskStatus(extractVideoStatus(video));
        if (status === "completed") {
            const resultUrl = extractVideoResultUrl(video);
            if (resultUrl && resolveManagedVideoDownload(resultUrl, config)) return { status: "completed", result: await videoResultFromUrl(resultUrl, config, options) };
            try {
                return { status: "completed", result: await videoResultFromContentPath(config, contentPathBase, task.id, options) };
            } catch (error) {
                throw new Error(readAxiosError(error, "视频下载代理失败"));
            }
        }
        if (status === "failed") return { status: "failed", error: extractVideoError(video) || "视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        if (isRequestCanceled(error, options?.signal)) throw error;
        throw new VideoGenerationPollRequestError(readAxiosError(error, "视频任务查询失败"), isRetryableVideoError(error));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask(
            (
                await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, {
                    headers: aiHeaders(config, "application/json", { "Idempotency-Key": options?.idempotencyKey || createVideoGenerationIdempotencyKey() }),
                    signal: options?.signal,
                })
            ).data,
        );
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务创建失败"));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data);
        if (state.status === "succeeded") {
            const url = state.content?.video_url;
            if (!url) return { status: "failed", error: "Seedance 任务成功但没有返回视频 URL" };
            return { status: "completed", result: await videoResultFromUrl(url, config, options) };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: state.error?.message || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
        return { status: "pending" };
    } catch (error) {
        if (isRequestCanceled(error, options?.signal)) throw error;
        throw new VideoGenerationPollRequestError(readAxiosError(error, "Seedance 任务查询失败"), isRetryableVideoError(error));
    }
}

function applySeedanceImageReferences(payload: Record<string, unknown>, imageUrls: string[]) {
    if (!imageUrls.length) return;
    payload.image_url = imageUrls[0];
    if (imageUrls.length > 1) payload.reference_image_urls = imageUrls.slice(1);
}

function applyImageReferences(payload: Record<string, unknown>, imageUrls: string[]) {
    if (!imageUrls.length) return;
    if (imageUrls.length === 1) payload.image_url = imageUrls[0];
    else payload.image_urls = imageUrls;
}

function assertReferenceLimit(items: unknown[], limit: number, label: string) {
    if (items.length > limit) throw new Error(`${label}最多支持 ${limit} 个，请减少素材数量后重试`);
}

function normalizeOpenAIVideoAspectRatio(value: string) {
    const ratio = normalizeSeedanceRatio(value);
    return ratio === "adaptive" ? "" : ratio;
}

function normalizeOpenAIVideoResolution(value: string, model = "") {
    const modelValue = model.toLowerCase();
    if (modelValue.includes("4k")) return "4k";
    if (modelValue.includes("1080p")) return "1080p";
    if (modelValue.includes("720p")) return "720p";
    if (modelValue.includes("480p")) return "480p";
    const normalized = String(value || "")
        .trim()
        .toLowerCase();
    if (normalized === "4k" || normalized === "2160" || normalized === "2160p") return "4k";
    if (normalized === "1080" || normalized === "1080p" || normalized === "2k") return "1080p";
    if (normalized === "480" || normalized === "480p" || normalized === "low") return "480p";
    return "720p";
}

function normalizeSeedanceModelResolution(value: string, model: string) {
    return seedanceFixedResolution(model) || normalizeSeedanceResolution(value, model);
}

function normalizeSoraDuration(value: string) {
    const seconds = Number(normalizeVideoSeconds(value));
    return normalizeAllowedDuration(seconds, [4, 8, 12], 8);
}

function normalizeAllowedDuration(value: number, allowed: number[], fallback: number) {
    if (!Number.isFinite(value)) return fallback;
    return allowed.reduce((closest, item) => (Math.abs(item - value) < Math.abs(closest - value) ? item : closest), fallback);
}

function normalizeTwoWayAspectRatio(value: string) {
    return value === "9:16" ? "9:16" : "16:9";
}

function isVeoReferenceModel(model: string) {
    return /(?:^|[-_.:/])ref(?:$|[-_.:/])/i.test(model);
}

function normalizeTaskStatus(value: string | undefined) {
    const status = String(value || "")
        .trim()
        .toLowerCase();
    if (["complete", "completed", "success", "succeeded", "done"].includes(status)) return "completed";
    if (["fail", "failed", "failure", "generation_failed", "prompt_blocked", "error", "cancel", "cancelled", "canceled", "expired", "timeout", "timed_out"].includes(status)) return "failed";
    return "pending";
}

function extractVideoTaskId(video: VideoResponse): string {
    if (video.id || video.request_id || video.task_id) return video.id || video.request_id || video.task_id || "";
    return nestedVideoValues(video).map(extractVideoTaskId).find(Boolean) || "";
}

function extractVideoStatus(video: VideoResponse): string {
    if (video.status || video.state) return video.status || video.state || "";
    return nestedVideoValues(video).map(extractVideoStatus).find(Boolean) || "";
}

function extractVideoResultUrl(video: VideoResponse): string {
    const direct = video.result_url || video.video_url || video.url;
    if (direct) return direct;
    for (const value of [video.content, video.output, video.data, video.result, video.video, video.raw_data]) {
        for (const item of asVideoValueArray(value)) {
            if (typeof item === "string") {
                if (/^(?:https?:\/\/|\/)/i.test(item)) return item;
                continue;
            }
            const nested = extractVideoResultUrl(item);
            if (nested) return nested;
        }
    }
    return "";
}

function extractVideoError(video: VideoResponse): string {
    if (typeof video.error === "string") return sanitizeMediaError(video.error);
    if (video.error?.message) return sanitizeMediaError(video.error.message);
    return nestedVideoValues(video).map(extractVideoError).find(Boolean) || "";
}

function nestedVideoValues(video: VideoResponse) {
    return [video.data, video.result, video.raw_data, typeof video.video === "object" ? video.video : null].flatMap(asVideoValueArray).filter((value): value is VideoResponse => typeof value === "object" && value !== null);
}

function asVideoValueArray(value: VideoResponse | VideoResponse[] | string | Array<string | VideoResponse> | null | undefined): Array<VideoResponse | string> {
    if (Array.isArray(value)) return value;
    return value === null || value === undefined ? [] : [value];
}

export function createVideoGenerationIdempotencyKey() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `video-${crypto.randomUUID()}`;
    return `video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[], model = "") {
    const error = seedanceVideoReferenceError(videoReferences, model);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl || "";
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo, requireHttps = false) {
    if (isHttpsMediaUrl(video.url)) return video.url;
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) {
        if (requireHttps) throw new Error("参考视频仅支持 HTTPS 直链，请使用链接方式添加");
        return video.url;
    }
    if (requireHttps) throw new Error("参考视频仅支持 HTTPS 直链，请使用链接方式添加");
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、素材 ID，或本地已保存的视频");
    return blobToDataUrl(blob);
}

async function resolveReferenceMediaBlob(video: ReferenceVideo) {
    if (video.storageKey) {
        const stored = await getMediaBlob(video.storageKey);
        if (stored) return stored;
    }
    if (video.url?.startsWith("blob:") || video.url?.startsWith("data:")) return (await fetch(video.url)).blob();
    return null;
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio, requireHttps = false) {
    if (isHttpsMediaUrl(audio.url)) return audio.url;
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) {
        if (requireHttps) throw new Error("参考音频仅支持 HTTPS 直链，请使用链接方式添加");
        return audio.url;
    }
    if (requireHttps) throw new Error("参考音频仅支持 HTTPS 直链，请使用链接方式添加");
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL、素材 ID，或本地已保存的音频");
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(url: string, config: AiConfig, options?: RequestOptions): Promise<VideoGenerationResult> {
    const target = resolveManagedVideoDownload(url, config);
    if (!target) throw new Error("视频接口返回了外部媒体地址，请通过支持媒体代理的中转站端点调用");
    return videoResultFromDownloadURL(target.url, config, target.withAuth, options);
}

async function videoResultFromContentPath(config: AiConfig, contentPathBase: string, taskId: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    return videoResultFromDownloadURL(aiApiUrl(config, `${contentPathBase}/${encodeURIComponent(taskId)}/content`), config, true, options);
}

async function videoResultFromDownloadURL(url: string, config: AiConfig, withAuth: boolean, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { headers: withAuth ? aiHeaders(config) : undefined, responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (isRequestCanceled(error, options?.signal)) throw error;
        throw new VideoGenerationPollRequestError(readAxiosError(error, "视频下载失败"), isRetryableVideoError(error));
    }
}

function resolveManagedVideoDownload(rawUrl: string, config: AiConfig) {
    const value = rawUrl.trim();
    if (!value || value.startsWith("//")) return null;
    try {
        const gateway = new URL(config.baseUrl.trim());
        const relativeEdgePath = value.startsWith(EDGE_VIDEO_PATH_PREFIX);
        const target = value.startsWith("/") ? new URL(value, relativeEdgePath ? MANAGED_VIDEO_ORIGIN : gateway.origin) : new URL(value);
        const edgePath = target.pathname.startsWith(EDGE_VIDEO_PATH_PREFIX);
        if (target.origin === gateway.origin && !edgePath) return { url: target.toString(), withAuth: true };
        if (target.origin === MANAGED_VIDEO_ORIGIN && edgePath) return { url: target.toString(), withAuth: false };
        return null;
    } catch {
        return null;
    }
}

function resolveTaskRequestConfig(config: AiConfig, task: VideoGenerationTask) {
    const requestConfig = resolveModelRequestConfig(config, task.model);
    return task.baseUrl ? { ...requestConfig, baseUrl: task.baseUrl } : requestConfig;
}

function refreshVideoTaskWindow(task: VideoGenerationTask, config: AiConfig) {
    const now = Date.now();
    const pollDelayMs = task.pollDelayMs ?? OPENAI_VIDEO_POLL_DELAY_MS;
    const maxAttempts = task.maxAttempts ?? OPENAI_VIDEO_MAX_ATTEMPTS;
    const deadlineAt = task.deadlineAt && task.deadlineAt > now ? task.deadlineAt : now + pollDelayMs * maxAttempts;
    return {
        ...task,
        baseUrl: task.baseUrl || config.baseUrl,
        pollDelayMs,
        maxAttempts,
        createdAt: task.createdAt || now,
        deadlineAt,
    };
}

function serializableVideoTask(task: VideoGenerationTask): VideoGenerationTask {
    const { result: _result, ...serializable } = task;
    return serializable;
}

function isRequestCanceled(error: unknown, signal?: AbortSignal) {
    return Boolean(signal?.aborted || axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError"));
}

function isRetryableVideoError(error: unknown) {
    if (error instanceof VideoGenerationPollRequestError) return error.retryable;
    if (!axios.isAxiosError(error)) return true;
    const status = error.response?.status;
    return !status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持视频生成，请使用 OpenAI 格式渠道");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope<VideoResponse>(payload as ApiEnvelope<VideoResponse>, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope<SeedanceTask>(payload, "Seedance 接口没有返回任务");
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && typeof payload.code === "number") {
        if (payload.code !== 0) throw new Error(payload.msg || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    let message = fallback;
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        message = responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    } else if (error instanceof DOMException && error.name === "AbortError") {
        message = "请求已取消";
    } else if (error instanceof Error) {
        message = error.message;
    }
    return sanitizeMediaError(message);
}

function sanitizeMediaError(value: string) {
    return String(value || "请求失败")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[外部地址已隐藏]")
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 500);
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    const mimeType = blob.type.toLowerCase();
    if (mimeType.includes("text/html")) throw new Error("视频下载返回了 HTML 错误页面");
    if (mimeType.startsWith("video/") || mimeType === "application/octet-stream") return;
    if (!mimeType.includes("json")) throw new Error(`视频下载返回了不支持的内容类型：${mimeType || "unknown"}`);
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "视频下载失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function isHttpsMediaUrl(value: string) {
    return /^https:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地素材失败"));
        reader.readAsDataURL(blob);
    });
}
