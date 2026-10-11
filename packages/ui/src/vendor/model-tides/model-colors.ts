/**
 * Vendored from https://github.com/BYK/model-tides
 * Source path: src/model-colors.ts
 * Source commit: debf94918013ff8bb579d7a12272521a1d395080
 * MIT License, Copyright (c) 2026 Burak Yigit Kaya — see LICENSE in this directory.
 * Local modifications: `// @ts-nocheck` added below — the vendored source is
 * not written for `noUncheckedIndexedAccess` and is lint/format-excluded.
 */
// @ts-nocheck
export const OTHER_MODEL_COLOR = '#728b93';

const providerPalette = [
    '#6677bd',
    '#548d9b',
    '#9a6e9b',
    '#8b8750',
    '#547caf',
    '#b66b66',
] as const;

const tokenize = (value: string): Set<string> =>
    new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

const hasAny = (tokens: Set<string>, ...values: string[]): boolean => values.some((value) => tokens.has(value));

const stableIndex = (value: string, length: number): number => {
    let hash = 2_166_136_261;
    for (const character of value) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0) % length;
};

function providerFallback(provider: string): string {
    return providerPalette[stableIndex(provider, providerPalette.length)] ?? OTHER_MODEL_COLOR;
}

function modelShade(base: string, model: string): string {
    // Keep family hues, but give versions and provider routes their own stable shades.
    const canonical = model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
    const channels = [1, 3, 5].map((index) => parseInt(base.slice(index, index + 2), 16) / 255);
    const max = Math.max(...channels);
    const min = Math.min(...channels);
    const delta = max - min;
    const lightness = (max + min) / 2;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    const hue = delta === 0 ? 0 : max === channels[0]
        ? ((channels[1] - channels[2]) / delta + 6) % 6
        : max === channels[1] ? (channels[2] - channels[0]) / delta + 2
            : (channels[0] - channels[1]) / delta + 4;
    const shade = stableIndex(canonical, 11) - 5;
    const claudeVersion = /(?:^|\/)claude-(?:opus|sonnet|haiku)-\d+[-.](\d+)/.exec(canonical);
    const newerShade = claudeVersion ? Number(claudeVersion[1]) % 2 === 0 : null;
    const routeHue = claudeVersion && canonical.startsWith('github-copilot/') ? -34 : 0;
    const shiftedHue = (hue * 60 + (newerShade === null ? (stableIndex(`${canonical}:hue`, 5) - 2) * 6
        : newerShade ? -6 : 6) + routeHue + 360) % 360;
    const shiftedLightness = Math.max(0.24, Math.min(0.58, lightness +
        (newerShade === null ? shade * 0.012 : newerShade ? -0.06 : 0.085)));
    const chroma = (1 - Math.abs(2 * shiftedLightness - 1)) * saturation;
    const segment = chroma * (1 - Math.abs((shiftedHue / 60) % 2 - 1));
    const rgb = shiftedHue < 60 ? [chroma, segment, 0] : shiftedHue < 120 ? [segment, chroma, 0]
        : shiftedHue < 180 ? [0, chroma, segment] : shiftedHue < 240 ? [0, segment, chroma]
            : shiftedHue < 300 ? [segment, 0, chroma] : [chroma, 0, segment];
    const offset = shiftedLightness - chroma / 2;
    return `#${rgb.map((value) => Math.round((value + offset) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function getModelColor(model: string): string {
    if (model === 'Other models') return OTHER_MODEL_COLOR;

    const segments = model.toLowerCase().split('/');
    const provider = segments[0] ?? model.toLowerCase();
    const tokens = tokenize(model);
    const providerTokens = tokenize(provider);

    const base = (() => {
        if (hasAny(tokens, 'claude', 'anthropic') || hasAny(providerTokens, 'anthropic')) {
            if (tokens.has('opus')) return '#a4305e';
            if (tokens.has('sonnet')) return '#c77513';
            if (tokens.has('haiku')) return '#727b17';
            return '#b95535';
        }
        if (hasAny(tokens, 'openai', 'gpt', 'chatgpt', 'codex')) {
            if (tokens.has('codex')) return '#487630';
            if (hasAny(tokens, 'o1', 'o3', 'o4')) return '#6852a6';
            if (hasAny(tokens, 'dall', 'image')) return '#4b9b79';
            if (hasAny(tokens, 'embedding', 'embed')) return '#798e35';
            return '#087a8b';
        }
        if (hasAny(tokens, 'gemini') || hasAny(providerTokens, 'google', 'gemini')) {
            if (tokens.has('flash')) return tokens.has('lite') ? '#348c80' : '#247bbd';
            return '#6453b1';
        }
        if (hasAny(tokens, 'mistral', 'codestral', 'ministral')) {
            if (tokens.has('codestral')) return '#a35c91';
            if (tokens.has('small') || tokens.has('ministral')) return '#e49349';
            if (tokens.has('large')) return '#d75f4c';
            return '#d77558';
        }
        if (hasAny(tokens, 'deepseek')) {
            if (tokens.has('r1')) return '#367db8';
            if (tokens.has('v3')) return '#2a9d91';
            return '#3289a8';
        }
        if (hasAny(tokens, 'llama', 'meta')) return '#8263b5';
        if (hasAny(tokens, 'grok', 'xai')) return '#5e7293';
        if (hasAny(tokens, 'cohere', 'command')) return '#7861aa';
        if (hasAny(tokens, 'qwen', 'alibaba')) return '#b65f89';
        if (hasAny(tokens, 'nova') || hasAny(providerTokens, 'amazon', 'bedrock')) return '#c48736';
        return providerFallback(provider);
    })();
    return modelShade(base, model);
}
