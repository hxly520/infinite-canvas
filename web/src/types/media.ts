export type ReferenceVideo = {
    id: string;
    name: string;
    type: string;
    url: string;
    storageKey?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type ReferenceAudio = {
    id: string;
    name: string;
    type: string;
    url: string;
    storageKey?: string;
    durationMs?: number;
};

export type VideoGenerationResult = {
    blob?: Blob;
    url?: string;
    mimeType?: string;
};

export type VideoGenerationTask = {
    id: string;
    provider: "openai" | "seedance";
    model: string;
    baseUrl?: string;
    statusPathBase?: string;
    contentPathBase?: string;
    pollDelayMs?: number;
    maxAttempts?: number;
    createdAt?: number;
    deadlineAt?: number;
    result?: VideoGenerationResult;
};

export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };
