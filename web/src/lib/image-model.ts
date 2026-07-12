export function fixedImageTier(model: string) {
    return model
        .trim()
        .toLowerCase()
        .match(/(?:^|[-_.])(1k|2k|4k)$/)?.[1]
        ?.toUpperCase();
}
