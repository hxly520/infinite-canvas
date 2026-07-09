import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildSeedancePromptText, isArkPlanBaseUrl, isSeedanceVideoModel, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = {
    id?: string;
    request_id?: string;
    task_id?: string;
    status?: string;
    state?: string;
    error?: { message?: string } | string | null;
    url?: string;
    video_url?: string;
    output?: Array<{ url?: string; video_url?: string }>;
    content?: { video_url?: string; url?: string } | null;
};
type ApiVideoResponse = VideoResponse | { code?: number; data?: VideoResponse | null; msg?: string };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; last_frame_url?: string } | null;
};
type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string };
type RequestOptions = { signal?: AbortSignal };

const OPENAI_VIDEO_POLL_DELAY_MS = 5000;
const OPENAI_VIDEO_MAX_ATTEMPTS = 360;

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = {
    id: string;
    provider: "openai" | "seedance";
    model: string;
    statusPathBase?: string;
    contentPathBase?: string;
    pollDelayMs?: number;
    maxAttempts?: number;
    result?: VideoGenerationResult;
};
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

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
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    if (task.result) return task.result;
    const delayMs = task.pollDelayMs ?? (task.provider === "seedance" ? 5000 : 2500);
    const maxAttempts = task.maxAttempts ?? 120;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === maxAttempts - 1) throw new Error(`${task.provider === "seedance" ? "Seedance " : ""}视频生成超时，请稍后重试`);
        await delay(delayMs, options?.signal);
    }
    throw new Error("视频生成超时，请稍后重试");
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.videoModel || config.model).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (isArkPlanBaseUrl(requestConfig.baseUrl)) {
        return createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    return task.provider === "seedance" ? pollSeedanceTask(requestConfig, task, options) : pollOpenAIVideoTask(requestConfig, task, options);
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
    throw new Error("视频接口没有返回可播放的视频");
}

type OpenAIVideoAdapter = {
    kind: "videos-json" | "video-generations-json" | "legacy-multipart";
    payloadBuilder: "seedance-flat" | "grok" | "omni-frame" | "omni-v2v" | "sora2" | "generic";
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
    if (value.includes("grok") && value.includes("video")) {
        return {
            kind: "video-generations-json",
            payloadBuilder: "grok",
            label: "Grok 视频",
            createPath: "/videos/generations",
            statusPathBase: "/videos",
            contentPathBase: "/videos",
            pollDelayMs: OPENAI_VIDEO_POLL_DELAY_MS,
            maxAttempts: OPENAI_VIDEO_MAX_ATTEMPTS,
        };
    }
    if (value.includes("omni-v2v")) return openAIVideosAdapter("omni-v2v", "Omni 视频转视频");
    if (value.includes("omni")) return openAIVideosAdapter("omni-frame", "Omni 视频");
    if (value.includes("sora")) return openAIVideosAdapter("sora2", "Sora 视频");
    if (value.includes("video") || value.includes("veo") || value.includes("kling") || value.includes("wan") || value.includes("hailuo")) {
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
            (await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, {
                headers: aiHeaders(config, undefined, { "Idempotency-Key": createVideoIdempotencyKey() }),
                signal: options?.signal,
            })).data,
        );
        return openAIVideoTaskFromCreateResponse(created, { model, statusPathBase: "/videos", contentPathBase: "/videos", pollDelayMs: 2500, maxAttempts: 120 }, options);
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function buildOpenAIVideoPayload(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], adapter: OpenAIVideoAdapter) {
    const requestModel = modelOptionName(model);
    const imageUrls = await Promise.all(references.map((image) => resolveSeedanceImageUrl(config, image)));
    const videoUrls = await Promise.all(videoReferences.map((video) => resolveSeedanceVideoUrl(video)));
    const audioUrls = await Promise.all(audioReferences.map((audio) => resolveSeedanceAudioUrl(audio)));
    const aspectRatio = normalizeOpenAIVideoAspectRatio(config.size);
    const resolution = normalizeOpenAIVideoResolution(config.vquality, requestModel);
    const seconds = Number(normalizeVideoSeconds(config.videoSeconds));
    const payload: Record<string, unknown> = {
        model: requestModel,
        prompt: prompt.trim(),
    };

    if (aspectRatio) payload.aspect_ratio = aspectRatio;

    switch (adapter.payloadBuilder) {
        case "seedance-flat": {
            if (audioUrls.length && !imageUrls.length && !videoUrls.length) throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
            assertSeedanceVideoReferences(videoReferences);
            assertSeedanceAudioReferences(audioReferences);
            assertReferenceLimit(imageUrls, 9, "参考图");
            assertReferenceLimit(videoUrls, 3, "参考视频");
            assertReferenceLimit(audioUrls, 3, "参考音频");
            payload.prompt = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
            const duration = normalizeSeedanceDuration(config.videoSeconds);
            if (duration > 0) payload.duration = duration;
            payload.resolution = normalizeSeedanceModelResolution(config.vquality, requestModel);
            payload.audio = boolConfig(config.videoGenerateAudio, true);
            payload.watermark = boolConfig(config.videoWatermark, false);
            applyFrameOrReferenceImages(payload, imageUrls);
            if (videoUrls.length) payload.reference_videos = videoUrls;
            if (audioUrls.length) payload.reference_audios = audioUrls;
            return payload;
        }
        case "grok": {
            assertReferenceLimit(imageUrls, 7, "参考图");
            assertReferenceLimit(videoUrls, 1, "参考视频");
            if (audioUrls.length) throw new Error("Grok 视频接口暂不支持参考音频");
            payload.seconds = seconds;
            payload.resolution = resolution;
            applyImageReferences(payload, imageUrls);
            if (videoUrls.length) payload.video_url = videoUrls[0];
            return payload;
        }
        case "omni-v2v": {
            if (imageUrls.length || audioUrls.length) throw new Error("Omni V2V 仅支持 1 个参考视频，请移除参考图或参考音频");
            if (videoUrls.length !== 1) throw new Error("Omni V2V 需要且只能使用 1 个参考视频");
            payload.video_url = videoUrls[0];
            payload.resolution = resolution;
            return payload;
        }
        case "omni-frame": {
            if (videoUrls.length || audioUrls.length) throw new Error("Omni 图生视频暂不支持参考视频或参考音频");
            assertReferenceLimit(imageUrls, 5, "参考图");
            payload.resolution = resolution;
            applyFrameOrReferenceImages(payload, imageUrls);
            return payload;
        }
        case "sora2": {
            if (videoUrls.length || audioUrls.length) throw new Error("Sora 视频接口暂不支持参考视频或参考音频");
            assertReferenceLimit(imageUrls, 1, "参考图");
            const duration = normalizeSoraDuration(config.videoSeconds);
            payload.duration = duration;
            payload.sora2_duration = duration;
            applyImageReferences(payload, imageUrls);
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

async function openAIVideoTaskFromCreateResponse(created: VideoResponse, defaults: Omit<VideoGenerationTask, "id" | "provider">, options?: RequestOptions): Promise<VideoGenerationTask> {
    const id = extractVideoTaskId(created);
    const status = normalizeTaskStatus(created.status || created.state);
    const url = extractVideoResultUrl(created);
    if ((status === "completed" || (!id && url)) && url) {
        return { ...defaults, id: id || `completed-${Date.now()}`, provider: "openai", result: await videoResultFromUrl(url, options) };
    }
    if (status === "failed") throw new Error(extractVideoError(created) || "视频生成失败");
    if (!id) throw new Error("视频接口没有返回任务 ID");
    return { ...defaults, id, provider: "openai" };
}

async function createOpenAIVideoJSONTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], adapter: OpenAIVideoAdapter, options?: RequestOptions): Promise<VideoGenerationTask> {
    const payload = await buildOpenAIVideoPayload(config, model, prompt, references, videoReferences, audioReferences, adapter);
    try {
        const created = unwrapVideoResponse(
            (await axios.post<ApiVideoResponse>(aiApiUrl(config, adapter.createPath), payload, {
                headers: aiHeaders(config, "application/json", { "Idempotency-Key": createVideoIdempotencyKey() }),
                signal: options?.signal,
            })).data,
        );
        return openAIVideoTaskFromCreateResponse(
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
        throw new Error(readAxiosError(error, `${adapter.label}任务创建失败`));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const statusPathBase = task.statusPathBase || "/videos";
    const contentPathBase = task.contentPathBase || statusPathBase;
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `${statusPathBase}/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const status = normalizeTaskStatus(video.status || video.state);
        if (status === "completed") {
            const resultUrl = extractVideoResultUrl(video);
            if (resultUrl) return { status: "completed", result: await videoResultFromUrl(resultUrl, options) };
            const content = await axios.get<Blob>(aiApiUrl(config, `${contentPathBase}/${encodeURIComponent(task.id)}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (status === "failed") return { status: "failed", error: extractVideoError(video) || "视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务查询失败"));
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
            (await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, {
                headers: aiHeaders(config, "application/json", { "Idempotency-Key": createVideoIdempotencyKey() }),
                signal: options?.signal,
            })).data,
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
            return { status: "completed", result: await videoResultFromUrl(url, options) };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: state.error?.message || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function applyFrameOrReferenceImages(payload: Record<string, unknown>, imageUrls: string[]) {
    if (imageUrls.length === 2) {
        payload.first_image_url = imageUrls[0];
        payload.last_image_url = imageUrls[1];
        return;
    }
    applyImageReferences(payload, imageUrls);
}

function applyImageReferences(payload: Record<string, unknown>, imageUrls: string[]) {
    if (!imageUrls.length) return;
    payload.image_url = imageUrls[0];
    if (imageUrls.length > 1) payload.reference_image_urls = imageUrls.slice(1);
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
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "4k" || normalized === "2160" || normalized === "2160p") return "4k";
    if (normalized === "1080" || normalized === "1080p" || normalized === "2k") return "1080p";
    if (normalized === "480" || normalized === "480p" || normalized === "low") return "480p";
    return "720p";
}

function normalizeSeedanceModelResolution(value: string, model: string) {
    const modelValue = model.toLowerCase();
    if (modelValue.includes("4k")) return "4k";
    if (modelValue.includes("1080p")) return "1080p";
    if (modelValue.includes("720p")) return "720p";
    if (modelValue.includes("480p")) return "480p";
    return normalizeSeedanceResolution(value, model);
}

function normalizeSoraDuration(value: string) {
    const seconds = Number(normalizeVideoSeconds(value));
    return seconds > 10 ? 12 : 8;
}

function normalizeTaskStatus(value: string | undefined) {
    const status = String(value || "").trim().toLowerCase();
    if (["complete", "completed", "success", "succeeded", "done"].includes(status)) return "completed";
    if (["fail", "failed", "error", "cancel", "cancelled", "canceled", "expired", "timeout", "timed_out"].includes(status)) return "failed";
    return "pending";
}

function extractVideoTaskId(video: VideoResponse) {
    return video.id || video.request_id || video.task_id || "";
}

function extractVideoResultUrl(video: VideoResponse): string {
    const outputUrl = video.output?.find((item) => item.video_url || item.url);
    return (
        video.video_url ||
        video.url ||
        video.content?.video_url ||
        video.content?.url ||
        outputUrl?.video_url ||
        outputUrl?.url ||
        ""
    );
}

function extractVideoError(video: VideoResponse) {
    if (typeof video.error === "string") return video.error;
    return video.error?.message || "";
}

function createVideoIdempotencyKey() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `video-${crypto.randomUUID()}`;
    return `video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
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

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、素材 ID，或本地已保存的视频");
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL、素材 ID，或本地已保存的音频");
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
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
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
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
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
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
