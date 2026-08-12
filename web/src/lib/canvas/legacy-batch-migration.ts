import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeImage } from "../../types/canvas";

export function migrateLegacyBatchProject<T extends { nodes: CanvasNodeData[]; connections: CanvasConnection[] }>(project: T): T {
    const byId = new Map(project.nodes.map((node) => [node.id, node]));
    const removed = new Set<string>();
    const remap = new Map<string, string>();
    const nodes = project.nodes.map((node) => {
        const legacy = node.metadata as (typeof node.metadata & { isBatchRoot?: boolean; batchChildIds?: string[]; batchRootId?: string; imageBatchExpanded?: boolean; batchUsesReferenceImages?: boolean }) | undefined;
        if (node.type !== CanvasNodeType.Image || (!legacy?.isBatchRoot && !legacy?.batchChildIds?.length)) return node;
        const children = (legacy.batchChildIds || []).map((id) => byId.get(id)).filter((item): item is CanvasNodeData => Boolean(item));
        const images = children.map(legacyNodeImage).filter((item): item is CanvasNodeImage => Boolean(item));
        if (!images.length && node.metadata?.content) images.push(legacyNodeImage(node)!);
        for (const child of children) {
            removed.add(child.id);
            remap.set(child.id, node.id);
        }
        const { isBatchRoot: _root, batchChildIds: _children, batchRootId: _parent, imageBatchExpanded: _expanded, batchUsesReferenceImages: _usesRefs, ...metadata } = legacy;
        const primaryImageId = images.some((image) => image.id === legacy.primaryImageId) ? legacy.primaryImageId : images.find((image) => image.status === "success")?.id || images[0]?.id;
        return { ...node, metadata: { ...metadata, images, count: images.length || metadata.count, primaryImageId } };
    }).filter((node) => !removed.has(node.id));
    const seen = new Set<string>();
    const connections = project.connections.flatMap((connection) => {
        const fromNodeId = remap.get(connection.fromNodeId) || connection.fromNodeId;
        const toNodeId = remap.get(connection.toNodeId) || connection.toNodeId;
        const key = `${fromNodeId}:${toNodeId}`;
        if (fromNodeId === toNodeId || seen.has(key)) return [];
        seen.add(key);
        return [{ ...connection, fromNodeId, toNodeId }];
    });
    return { ...project, nodes, connections };
}

function legacyNodeImage(node: CanvasNodeData): CanvasNodeImage | null {
    const metadata = node.metadata;
    if (!metadata?.content && metadata?.status !== "error") return null;
    return {
        id: node.id,
        status: metadata.status || (metadata.content ? "success" : "error"),
        errorDetails: metadata.errorDetails,
        content: metadata.content || "",
        storageKey: metadata.storageKey || "",
        naturalWidth: metadata.naturalWidth || node.width,
        naturalHeight: metadata.naturalHeight || node.height,
        bytes: metadata.bytes || 0,
        mimeType: metadata.mimeType || "image/png",
    };
}
