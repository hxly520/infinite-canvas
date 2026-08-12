import assert from "node:assert/strict";
import test from "node:test";

Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { clear() {}, getItem() { return null; }, key() { return null; }, removeItem() {}, setItem() {}, length: 0 } satisfies Storage,
});

const { XIAN_YU_PROMPT_SOURCE_ID, createPromptSource } = await import("./prompt-source-presets");
const { parsePromptSourceData } = await import("./prompt-source-runtime");

const source = createPromptSource({
    id: XIAN_YU_PROMPT_SOURCE_ID,
    name: "Xianyu GPT Image 2",
    url: "https://raw.githubusercontent.com/xianyu110/awesome-gptimage2/main/data/latest-prompts.json",
    homepage: "https://github.com/xianyu110/awesome-gptimage2",
    builtIn: true,
});

test("converts the legacy Xianyu nested feed without relaxing standard JSON sources", () => {
    const item = { prompt: "A reusable prompt", reason: "Reusable Product scene", author: "Author", created_at: "2026-08-12", x_url: "https://x.com/example/status/1", primary_image_url: "https://images.example/cover.jpg", image_urls: ["https://images.example/cover.jpg", "https://images.example/detail.jpg"], engagement_score: 8 };
    const result = parsePromptSourceData({ dates: [{ date: "2026-08-12", items: [item, item, { prompt: "no image" }] }] }, source);

    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Product scene");
    assert.equal(result[0].coverUrl, "https://images.example/cover.jpg");
    assert.deepEqual(result[0].referenceImageUrls, ["https://images.example/cover.jpg", "https://images.example/detail.jpg"]);
    assert.deepEqual(result[0].tags, ["gpt-image-2", "Author", "高互动"]);
    assert.equal(result[0].sourceUrl, "https://x.com/example/status/1");
});

test("keeps the official array-root requirement for standard sources", () => {
    assert.throws(() => parsePromptSourceData({ dates: [] }, createPromptSource({ id: "custom", name: "Custom", url: "https://example.com/prompts.json" })));
});
