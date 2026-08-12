import assert from "node:assert/strict";
import test from "node:test";

import { migrateLegacyBatchProject } from "./legacy-batch-migration";
import { CanvasNodeType, type CanvasNodeData } from "../../types/canvas";

const imageNode = (id: string, metadata: Record<string, unknown>): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 320, height: 240, metadata });

test("migrates legacy batch children into one official multi-image node", () => {
    const project = {
        nodes: [
            imageNode("root", { isBatchRoot: true, batchChildIds: ["child-a", "child-b"], primaryImageId: "child-b", content: "root-preview" }),
            imageNode("child-a", { batchRootId: "root", content: "a", storageKey: "image:a", status: "success", naturalWidth: 100, naturalHeight: 80 }),
            imageNode("child-b", { batchRootId: "root", content: "b", storageKey: "image:b", status: "success", naturalWidth: 200, naturalHeight: 160 }),
            { id: "text", type: CanvasNodeType.Text, title: "text", position: { x: 0, y: 0 }, width: 200, height: 100 },
        ],
        connections: [
            { id: "internal", fromNodeId: "root", toNodeId: "child-a" },
            { id: "external", fromNodeId: "child-b", toNodeId: "text" },
        ],
    };

    const migrated = migrateLegacyBatchProject(project);
    assert.deepEqual(migrated.nodes.map((node) => node.id), ["root", "text"]);
    assert.deepEqual(migrated.nodes[0].metadata?.images?.map((image) => image.id), ["child-a", "child-b"]);
    assert.equal(migrated.nodes[0].metadata?.primaryImageId, "child-b");
    assert.deepEqual(migrated.connections, [{ id: "external", fromNodeId: "root", toNodeId: "text" }]);
});

test("migration is idempotent for the official multi-image shape", () => {
    const project = { nodes: [imageNode("root", { images: [], primaryImageId: "a" })], connections: [] };
    assert.deepEqual(migrateLegacyBatchProject(project), project);
});
