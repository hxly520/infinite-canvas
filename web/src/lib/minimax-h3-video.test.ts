import assert from "node:assert/strict";
import test from "node:test";

import { minimaxH3VideoReferenceError, normalizeMinimaxH3Duration, normalizeMinimaxH3Ratio } from "./seedance-video";

test("normalizes MiniMax H3 duration and ratio to supported values", () => {
    assert.equal(normalizeMinimaxH3Duration("1"), 5);
    assert.equal(normalizeMinimaxH3Duration("15.9"), 15);
    assert.equal(normalizeMinimaxH3Duration("8"), 8);
    assert.equal(normalizeMinimaxH3Ratio("21:9"), "21:9");
    assert.equal(normalizeMinimaxH3Ratio("2:1"), "16:9");
});

test("enforces MiniMax H3 multimodal and first/last frame constraints", () => {
    const image = (id: string) => ({ id, name: id, type: "image/png", dataUrl: "data:image/png;base64,AA" });
    const audio = (id: string, durationMs: number) => ({ id, name: id, type: "audio/mpeg", url: "https://example.com/audio.mp3", durationMs });
    assert.match(minimaxH3VideoReferenceError([], [], [audio("a", 1000)], "auto", true), /至少 1 张参考图/);
    assert.match(minimaxH3VideoReferenceError([image("a")], [], [audio("a", 8000), audio("b", 8000)], "auto", true), /总时长不能超过 15 秒/);
    assert.match(minimaxH3VideoReferenceError([image("a")], [], [], "frames", true), /正好 2 张参考图/);
    assert.match(minimaxH3VideoReferenceError([image("a"), image("b")], [], [audio("a", 1000)], "frames", true), /不支持参考音频/);
    assert.equal(minimaxH3VideoReferenceError([image("a")], [], [audio("a", 1000)], "auto", true), "");
});
