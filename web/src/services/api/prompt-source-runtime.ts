import i18n from "@/i18n";
import { XIAN_YU_PROMPT_SOURCE_ID, type PromptSource } from "./prompt-source-presets";

export type RawPrompt = {
    id: string;
    title: string;
    prompt: string;
    description: string;
    coverUrl: string;
    referenceImageUrls: string[];
    tags: string[];
    preview: string;
    createdAt: string;
    updatedAt: string;
    author?: string;
    sourceUrl?: string;
    imageMode?: string;
    imageModel?: string;
    imageSize?: string;
    imageCount?: number;
};

type RunOptions = { signal?: AbortSignal };

async function fetchSource(source: PromptSource, options?: RunOptions) {
    const response = await fetch(source.url, { cache: "no-store", signal: options?.signal });
    if (!response.ok) throw new Error(i18n.t("config.promptSources.runtime.requestFailed", { status: response.status }));
    return response.json();
}

export async function runPromptSource(source: PromptSource, options?: RunOptions): Promise<RawPrompt[]> {
    if (!source.url.trim()) throw new Error(i18n.t("config.promptSources.runtime.urlRequired"));
    let data: unknown;
    try {
        data = await fetchSource(source, options);
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(i18n.t("config.promptSources.runtime.fetchFailed", { name: source.name, error: error instanceof Error ? error.message : String(error) }));
    }

    const items = parsePromptSourceData(data, source);
    if (source.builtIn && !items.length) throw new Error(i18n.t("config.promptSources.runtime.noPrompts", { name: source.name }));
    return items;
}

export function parsePromptSourceData(data: unknown, source: PromptSource) {
    if (source.id === XIAN_YU_PROMPT_SOURCE_ID) return normalizeXianyuItems(data, source);
    if (!Array.isArray(data)) throw new Error(i18n.t("config.promptSources.runtime.invalidRoot", { name: source.name }));
    return normalizeItems(data, source);
}

function normalizeXianyuItems(value: unknown, source: PromptSource) {
    const seen = new Set<string>();
    const items: RawPrompt[] = [];
    arrayValue(asRecord(value).dates).forEach((dateValue, dateIndex) => {
        const date = asRecord(dateValue);
        arrayValue(date.items).forEach((itemValue, itemIndex) => {
            const item = asRecord(itemValue);
            const prompt = stringValue(item.prompt).trim();
            const referenceImageUrls = [stringValue(item.primary_image_url), ...stringArray(item.image_urls)]
                .map((url) => url.trim())
                .filter(isVisibleImageUrl)
                .filter((url, index, urls) => urls.indexOf(url) === index);
            if (!prompt || !referenceImageUrls.length) return;
            const reason = stringValue(item.reason).replace(/^reusable\s+/i, "").trim();
            const author = stringValue(item.author).trim();
            const title = reason || author || prompt.slice(0, 32);
            const duplicateKey = `${title.toLowerCase()}\n${prompt.toLowerCase()}`;
            if (seen.has(duplicateKey)) return;
            seen.add(duplicateKey);
            const sourceUrl = stringValue(item.source_url || item.x_url || item.url).trim();
            const createdAt = stringValue(item.created_at || date.date).trim();
            const tags = ["gpt-image-2", author, Number(item.engagement_score) > 0 ? "高互动" : ""].filter(Boolean);
            items.push({
                id: `${source.id}-${leftPad(dateIndex + 1)}-${leftPad(itemIndex + 1)}`,
                title,
                prompt,
                description: reason,
                coverUrl: referenceImageUrls[0],
                referenceImageUrls,
                tags,
                preview: [reason, sourceUrl, ...referenceImageUrls.map((url) => `![](${url})`)].filter(Boolean).join("\n\n"),
                createdAt,
                updatedAt: createdAt,
                author: author || undefined,
                sourceUrl: absoluteUrl(source.url, sourceUrl),
                imageModel: "gpt-image-2",
            });
        });
    });
    return items;
}

function normalizeItems(values: unknown[], source: PromptSource) {
    const seen = new Set<string>();
    const items: RawPrompt[] = [];
    values.forEach((value, index) => {
        const record = asRecord(value);
        const title = stringValue(record.title).trim();
        const prompt = stringValue(record.prompt).trim();
        if (!title || !prompt) return;
        const id = stringValue(record.id).trim() || `${source.id}-${leftPad(index + 1)}`;
        if (seen.has(id)) return;
        seen.add(id);
        const referenceImageUrls = stringArray(record.referenceImageUrls).map((url) => absoluteUrl(source.url, url));
        const coverUrl = absoluteUrl(source.url, stringValue(record.coverUrl)) || referenceImageUrls[0] || "";
        items.push({
            id,
            title,
            prompt,
            description: stringValue(record.description),
            coverUrl,
            referenceImageUrls,
            tags: stringArray(record.tags),
            preview: stringValue(record.preview),
            createdAt: stringValue(record.createdAt),
            updatedAt: stringValue(record.updatedAt),
            author: stringValue(record.author),
            sourceUrl: absoluteUrl(source.url, stringValue(record.sourceUrl)),
            imageMode: optionalString(record.imageMode),
            imageModel: optionalString(record.imageModel),
            imageSize: optionalString(record.imageSize),
            imageCount: optionalNumber(record.imageCount),
        });
    });
    return items;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? value.map(stringValue).map((item) => item.trim()).filter(Boolean) : [];
}

function arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function isVisibleImageUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

function optionalString(value: unknown) {
    const result = stringValue(value).trim();
    return result || undefined;
}

function optionalNumber(value: unknown) {
    const result = Number(value);
    return Number.isFinite(result) && result > 0 ? result : undefined;
}

function absoluteUrl(baseUrl: string, path: string) {
    if (!path) return "";
    try {
        return new URL(path, baseUrl).toString();
    } catch {
        return path;
    }
}

function leftPad(value: number) {
    return String(value).padStart(4, "0");
}
