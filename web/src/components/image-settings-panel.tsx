import { type ReactNode, useState } from "react";
import { ConfigProvider, Switch } from "antd";

import { type CanvasTheme } from "@/lib/canvas-theme";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

const qualityOptions = [
    { value: "auto", label: "自动" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
];
const dispatchOptions = [
    { value: "sync", label: "同步", title: "同步：保持 OpenAI Images 原有请求方式" },
    { value: "async", label: "异步", title: "异步：创建任务后轮询结果，适合长时间生图上游" },
] as const;
const DIMENSION_STEP = 16;

const aspectOptions = [
    { value: "1:1", label: "1:1", width: 1024, height: 1024, icon: "square" },
    { value: "3:2", label: "3:2", width: 1536, height: 1024, icon: "landscape" },
    { value: "2:3", label: "2:3", width: 1024, height: 1536, icon: "portrait" },
    { value: "4:3", label: "4:3", width: 1360, height: 1024, icon: "landscape" },
    { value: "3:4", label: "3:4", width: 1024, height: 1360, icon: "portrait" },
    { value: "16:9", label: "16:9", width: 1824, height: 1024, icon: "landscape" },
    { value: "9:16", label: "9:16", width: 1024, height: 1824, icon: "portrait" },
    { value: "1:1-2k", label: "1:1(2k)", size: "2048x2048", width: 2048, height: 2048, icon: "square" },
    { value: "16:9-2k", label: "16:9(2k)", size: "2048x1152", width: 2048, height: 1152, icon: "landscape" },
    { value: "9:16-2k", label: "9:16(2k)", size: "1152x2048", width: 1152, height: 2048, icon: "portrait" },
    { value: "16:9-4k", label: "16:9(4k)", size: "3840x2160", width: 3840, height: 2160, icon: "landscape" },
    { value: "9:16-4k", label: "9:16(4k)", size: "2160x3840", width: 2160, height: 3840, icon: "portrait" },
    { value: "auto", label: "auto", width: 0, height: 0, icon: "auto" },
];

type ImageSettingsKey = "quality" | "size" | "count" | "imageDispatchMode" | "imageConcurrency";

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: <K extends ImageSettingsKey>(key: K, value: AiConfig[K]) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
    showAdvancedControls?: boolean;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 10, showAdvancedControls = false }: ImageSettingsPanelProps) {
    const [snapDimensionToStep, setSnapDimensionToStep] = useState(true);
    const fireflyTier = fireflyImageTier(modelOptionName(config.imageModel || config.model));
    const availableAspectOptions = fireflyTier ? aspectOptions.filter((item) => ["1:1", "4:3", "3:4", "16:9", "9:16", "auto"].includes(item.value)) : aspectOptions;
    const quality = config.quality || "auto";
    const effectiveMaxCount = fireflyTier ? 1 : maxCount;
    const effectiveQuickCount = fireflyTier ? 1 : quickCount;
    const count = Math.max(1, Math.min(effectiveMaxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const concurrency = Math.max(1, Math.min(10, Math.floor(Math.abs(Number(config.imageConcurrency)) || 5)));
    const activeSize = config.size || "auto";
    const selectedAspect = availableAspectOptions.find((item) => (item.size || item.value) === activeSize || item.value === activeSize);
    const dimensions = readSizeDimensions(activeSize, selectedAspect || availableAspectOptions[0]);
    const selectAspect = (value: string) => {
        const option = availableAspectOptions.find((item) => item.value === value);
        onConfigChange("size", option?.size || option?.value || "auto");
    };
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep)}x${alignDimension(height, snapDimensionToStep)}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-lg font-semibold">图像设置</div> : null}
                {fireflyTier ? (
                    <div className="space-y-2.5">
                        <SettingTitle color={theme.node.muted}>输出档位</SettingTitle>
                        <div className="text-sm font-medium">{fireflyTier}</div>
                    </div>
                ) : (
                    <>
                        <div className="space-y-2.5">
                            <SettingTitle color={theme.node.muted}>质量</SettingTitle>
                            <div className="grid grid-cols-4 gap-2.5">
                                {qualityOptions.map((item) => (
                                    <OptionPill key={item.value} selected={quality === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-2.5">
                            <div className="flex items-center justify-between gap-3">
                                <SettingTitle color={theme.node.muted}>尺寸</SettingTitle>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                        16倍数对齐
                                    </span>
                                    <span title="输入完成后自动向上补成 16 的倍数" onMouseDown={(event) => event.stopPropagation()}>
                                        <Switch size="small" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                                    </span>
                                </div>
                            </div>
                            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                                <DimensionInput prefix="W" value={dimensions.width} disabled={activeSize === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("width", value)} />
                                <span className="text-lg opacity-45">↔</span>
                                <DimensionInput prefix="H" value={dimensions.height} disabled={activeSize === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("height", value)} />
                            </div>
                        </div>
                    </>
                )}
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>宽高比</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {availableAspectOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedAspect?.value === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => selectAspect(item.value)}
                            >
                                <AspectIcon type={item.icon} width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>生成张数</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {Array.from({ length: effectiveQuickCount }, (_, index) => index + 1).map((value) => (
                            <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {value} 张
                            </OptionPill>
                        ))}
                        <CountInput value={count} max={effectiveMaxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                    </div>
                </div>
                {showAdvancedControls ? (
                    <>
                        <div className="space-y-2.5">
                            <SettingTitle color={theme.node.muted}>接口模式</SettingTitle>
                            <div className="grid grid-cols-2 gap-2.5">
                                {dispatchOptions.map((item) => (
                                    <OptionPill key={item.value} selected={(config.imageDispatchMode || "sync") === item.value} theme={theme} title={item.title} onClick={() => onConfigChange("imageDispatchMode", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-2.5">
                            <SettingTitle color={theme.node.muted}>并发</SettingTitle>
                            <div className="grid grid-cols-4 gap-2.5">
                                {[1, 3, 5, 10].map((value) => (
                                    <OptionPill key={value} selected={concurrency === value} theme={theme} onClick={() => onConfigChange("imageConcurrency", String(value))}>
                                        {value}
                                    </OptionPill>
                                ))}
                                <ConcurrencyInput value={concurrency} theme={theme} onChange={(value) => onConfigChange("imageConcurrency", String(value || 5))} />
                            </div>
                        </div>
                    </>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

function fireflyImageTier(model: string) {
    return model
        .trim()
        .toLowerCase()
        .match(/^firefly-[a-z0-9._-]+-(1k|2k|4k)$/)?.[1]
        ?.toUpperCase();
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: { Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return ({ auto: "自动", high: "高", medium: "中", low: "低" } as Record<string, string>)[value] || value;
}

export function imageSizeLabel(size: string) {
    return aspectOptions.find((item) => (item.size || item.value) === size || item.value === size)?.label || size;
}

function OptionPill({ selected, theme, title, onClick, children }: { selected: boolean; theme: CanvasTheme; title?: string; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            title={title}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function ConcurrencyInput({ value, theme, onChange }: { value: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-4 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={10}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, alignToStep, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; alignToStep: boolean; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = alignDimension(Math.max(1, Math.floor(Number(input.value) || value || 1024)), alignToStep);
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value || ""}
                key={`${prefix}-${value}`}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function CountInput({ value, max, theme, onChange }: { value: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-2 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function AspectIcon({ type, width, height, color }: { type: string; width: number; height: number; color: string }) {
    if (type === "auto") return null;
    const ratio = width / Math.max(1, height);
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function readSizeDimensions(size: string, fallback: { width: number; height: number }) {
    const match = size?.match(/^(\d+)x(\d+)$/);
    return {
        width: match ? Number(match[1]) : fallback.width,
        height: match ? Number(match[2]) : fallback.height,
    };
}

function alignDimension(value: number, enabled: boolean) {
    return enabled ? Math.ceil(value / DIMENSION_STEP) * DIMENSION_STEP : value;
}
