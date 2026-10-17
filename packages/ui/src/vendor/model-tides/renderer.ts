/**
 * Vendored from https://github.com/BYK/model-tides
 * Source path: src/flow-svg/renderer.ts
 * Source commit: debf94918013ff8bb579d7a12272521a1d395080
 * MIT License, Copyright (c) 2026 Burak Yigit Kaya — see LICENSE in this directory.
 * Local modifications: `// @ts-nocheck` added below — the vendored source is
 * not written for `noUncheckedIndexedAccess` and is lint/format-excluded.
 */
// @ts-nocheck
export interface FlowDatum {
    /** Time of the target observation, in milliseconds since the Unix epoch. */
    readonly time: number;
    /** Target category, such as a model, provider, or service. */
    readonly to: string;
    /** Optional source category for an observed transition. */
    readonly from?: string;
    /** Time of the source observation. Defaults to `time` when `from` is set. */
    readonly fromTime?: number;
    /** Non-negative quantity carried by the observation. Defaults to one. */
    readonly weight?: number;
}

export interface FlowNodeTitleContext {
    readonly key: string;
    readonly label: string;
    readonly time: number;
    readonly period: string;
    readonly value: number;
}

export interface FlowLinkTitleContext {
    readonly kind: 'entry' | 'transition' | 'intra-period';
    readonly from?: string;
    readonly to: string;
    readonly fromLabel?: string;
    readonly toLabel: string;
    readonly fromTime?: number;
    readonly time: number;
    readonly fromPeriod?: string;
    readonly toPeriod: string;
    readonly value: number;
}

export interface FlowContinuityTitleContext {
    readonly key: string;
    readonly label: string;
    readonly fromTime: number;
    readonly time: number;
    readonly fromPeriod: string;
    readonly toPeriod: string;
    readonly fromValue: number;
    readonly toValue: number;
    readonly movedEntryTitle?: string;
}

export interface FlowMigrationTitleContext {
    readonly from: string;
    readonly to: string;
    readonly fromLabel: string;
    readonly toLabel: string;
    readonly fromPeriod: string;
    readonly toPeriod: string;
    readonly drop: number;
    readonly rise: number;
    readonly value: number;
}

export interface FlowSvgOptions {
    readonly start: number;
    readonly end: number;
    readonly width: number;
    readonly height: number;
    /** Preferred left-to-right category order. Unlisted categories follow alphabetically. */
    readonly order?: readonly string[];
    /** Maps data values to display/grouping keys, for example a top-N "Other" bucket. */
    readonly displayKey?: (key: string) => string;
    readonly displayName?: (key: string) => string;
    readonly colorFor?: (key: string) => string;
    /** Colors a raw model stream without changing the color of its grouped node. */
    readonly streamColorFor?: (rawKey: string, displayKey: string) => string;
    readonly formatValue?: (value: number) => string;
    readonly formatPeriod?: (time: number, intervalDays: number) => string;
    readonly formatNodeTitle?: (context: FlowNodeTitleContext) => string;
    readonly formatLinkTitle?: (context: FlowLinkTitleContext) => string;
    readonly formatContinuityTitle?: (context: FlowContinuityTitleContext) => string;
    readonly formatMigrationTitle?: (context: FlowMigrationTitleContext) => string;
    /** Use weekly rather than daily buckets for short ranges of weekly counts. */
    readonly weeklyBuckets?: boolean;
    /** Pair unmatched declines and increases in adjacent buckets. For count-only data, never observed switches. */
    readonly inferMigrations?: boolean;
    /** Disable delayed browser tooltips when a chart supplies its own hover UI. */
    readonly nativeTooltips?: boolean;
    readonly axisCaption?: string;
    readonly ariaLabel?: string;
}

interface Period {
    readonly time: number;
    readonly label: string;
}

interface Node {
    readonly id: string;
    readonly key: string;
    readonly bucket: number;
    readonly rawKeys: Set<string>;
    readonly rawEventWeights: Map<string, number>;
    readonly rawOutgoingWeights: Map<string, number>;
    readonly continuityWeights: Map<string, number>;
    readonly continuityCenters: Map<string, number>;
    readonly rawTops: Map<string, number>;
    eventWeight: number;
    outgoingWeight: number;
    weight: number;
    y: number;
    height: number;
}

interface Link {
    readonly source: Node | null;
    readonly target: Node;
    weight: number;
    readonly kind: 'entry' | 'transition' | 'intra-period';
    readonly pairs: Map<string, readonly [string | null, string]>;
    sourceOffset: number;
    targetOffset: number;
}

interface InferredMigration {
    readonly source: Node;
    readonly target: Node;
    readonly from: string;
    readonly to: string;
    readonly drop: number;
    readonly rise: number;
    readonly weight: number;
    sourceOffset: number;
    targetOffset: number;
}

export const FLOW_PALETTE = [
    '#ff7668',
    '#63c8bf',
    '#f2c45c',
    '#a7ce7e',
    '#c98bd8',
    '#74a6e8',
    '#a2adbb',
    '#d98858',
    '#c2cf69',
    '#df9ab7',
] as const;

const escapeSvg = (value: unknown): string =>
    String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

const defaultPeriodLabel = (time: number, intervalDays: number): string => {
    const date = new Date(time);
    return intervalDays === 30
        ? date.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })
        : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

const defaultValueLabel = (value: number): string => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);

const uniquePairKey = (pair: readonly [string | null, string]): string => JSON.stringify(pair);

const addPair = (pairs: Map<string, readonly [string | null, string]>, pair: readonly [string | null, string]): void => {
    pairs.set(uniquePairKey(pair), pair);
};

const addWeight = (weights: Map<string, number>, key: string, weight: number): number => {
    const total = (weights.get(key) ?? 0) + weight;
    if (!Number.isFinite(total)) throw new RangeError('Aggregated flow weights must remain finite.');
    weights.set(key, total);
    return total;
};

const makeNode = (id: string, key: string, bucket: number): Node => ({
    id,
    key,
    bucket,
    rawKeys: new Set(),
    rawEventWeights: new Map(),
    rawOutgoingWeights: new Map(),
    continuityWeights: new Map(),
    continuityCenters: new Map(),
    rawTops: new Map(),
    eventWeight: 0,
    outgoingWeight: 0,
    weight: 0,
    y: 0,
    height: 0,
});

/**
 * Render a time-bucketed, weighted flow diagram as a standalone SVG string.
 * The renderer has no DOM, framework, charting-library, or data-source dependency.
 */
export function renderFlowSvg(data: readonly FlowDatum[], options: FlowSvgOptions): string {
    const { start, end } = options;
    const width = Math.round(options.width);
    const height = Math.round(options.height);
    const maxDateTime = 8_640_000_000_000_000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || Math.abs(start) > maxDateTime || Math.abs(end) > maxDateTime) {
        throw new RangeError('Flow range must contain finite timestamps with end at or after start.');
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new RangeError('Flow SVG dimensions must be positive finite numbers.');
    }

    const spanDays = Math.max(1, (end - start) / 86_400_000);
    if (!Number.isFinite(spanDays)) throw new RangeError('Flow range is too large to bucket safely.');
    const intervalDays = spanDays > 150 ? 30 : spanDays > 35 || options.weeklyBuckets ? 7 : 1;
    const dayBucket = (time: number): number => Math.floor(time / 86_400_000) * 86_400_000;
    const periodFor = (time: number): number => {
        if (intervalDays === 30) {
            const date = new Date(time);
            return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
        }
        if (intervalDays === 7) {
            const day = Math.floor(time / 86_400_000);
            const mondayOffset = (new Date(day * 86_400_000).getUTCDay() + 6) % 7;
            return (day - mondayOffset) * 86_400_000;
        }
        return dayBucket(time);
    };
    const nextPeriod = (time: number): number => intervalDays === 30
        ? Date.UTC(new Date(time).getUTCFullYear(), new Date(time).getUTCMonth() + 1, 1)
        : time + intervalDays * 86_400_000;
    const firstBucket = periodFor(start);
    const lastBucket = periodFor(end);
    const periods: Period[] = [];
    for (let time = firstBucket; time <= lastBucket; time = nextPeriod(time)) {
        periods.push({ time, label: options.formatPeriod?.(time, intervalDays) ?? defaultPeriodLabel(time, intervalDays) });
    }
    if (periods.length === 0) periods.push({ time: firstBucket, label: options.formatPeriod?.(firstBucket, intervalDays) ?? defaultPeriodLabel(firstBucket, intervalDays) });

    const displayKey = options.displayKey ?? ((key: string) => key);
    const nodes = new Map<string, Node>();
    const categoryWeights = new Map<string, number>();
    const links: Link[] = [];
    const linkIndex = new Map<string, Link>();
    const periodIndexByTime = new Map(periods.map((period, index) => [period.time, index]));
    const previousPeriodByTime = new Map(periods.map((period, index) => [period.time, periods[index - 1]?.time]));
    const nodeFor = (key: string, bucket: number): Node => {
        const id = `${bucket}\u0000${key}`;
        let node = nodes.get(id);
        if (!node) {
            node = makeNode(id, key, bucket);
            nodes.set(id, node);
        }
        return node;
    };
    const linkFor = (source: Node | null, target: Node, kind: Link['kind'], pair: readonly [string | null, string], splitByRawPair: boolean): Link => {
        const rawIdentity = splitByRawPair ? uniquePairKey(pair) : '';
        const id = `${source?.id ?? 'entry'}\u0000${target.id}\u0000${kind}\u0000${rawIdentity}`;
        let link = linkIndex.get(id);
        if (!link) {
            link = { source, target, weight: 0, kind, pairs: new Map(), sourceOffset: 0, targetOffset: 0 };
            linkIndex.set(id, link);
            links.push(link);
        }
        return link;
    };

    for (const datum of data) {
        if (!Number.isFinite(datum.time) || Math.abs(datum.time) > maxDateTime || typeof datum.to !== 'string' || !datum.to.trim()) {
            throw new TypeError('Every flow datum needs a finite time and non-empty target key.');
        }
        const weight = datum.weight ?? 1;
        if (!Number.isFinite(weight) || weight < 0) {
            throw new RangeError('Flow weights must be finite, non-negative numbers.');
        }
        if (weight === 0 || datum.time < start || datum.time > end) continue;
        if (datum.from !== undefined && (typeof datum.from !== 'string' || !datum.from.trim())) {
            throw new TypeError('A provided flow source key must not be empty.');
        }
        if (options.inferMigrations && datum.from !== undefined) {
            throw new TypeError('Inferred migrations require count-only data without observed sources.');
        }
        const sourceTime = datum.fromTime ?? datum.time;
        if (!Number.isFinite(sourceTime) || Math.abs(sourceTime) > maxDateTime || sourceTime > datum.time) {
            throw new RangeError('A source timestamp must be finite and no later than its target timestamp.');
        }

        const targetKey = displayKey(datum.to);
        if (typeof targetKey !== 'string' || !targetKey.trim()) throw new TypeError('Displayed flow category keys must be non-empty strings.');
        const targetBucket = periodFor(datum.time);
        const target = nodeFor(targetKey, targetBucket);
        target.rawKeys.add(datum.to);
        target.eventWeight += weight;
        addWeight(target.rawEventWeights, datum.to, weight);
        const categoryWeight = (categoryWeights.get(targetKey) ?? 0) + weight;
        if (!Number.isFinite(target.eventWeight) || !Number.isFinite(categoryWeight)) throw new RangeError('Aggregated flow weights must remain finite.');
        categoryWeights.set(targetKey, categoryWeight);

        let source: Node | null = null;
        let sourceKey: string | null = null;
        let sourceBucket: number | null = null;
        if (datum.from !== undefined && sourceTime >= start) {
            sourceKey = displayKey(datum.from);
            if (typeof sourceKey !== 'string' || !sourceKey.trim()) throw new TypeError('Displayed flow category keys must be non-empty strings.');
            sourceBucket = periodFor(sourceTime);
            source = nodeFor(sourceKey, sourceBucket);
            source.rawKeys.add(datum.from);
            source.outgoingWeight += weight;
            addWeight(source.rawOutgoingWeights, datum.from, weight);
            categoryWeights.set(sourceKey, categoryWeights.get(sourceKey) ?? 0);
        }

        const kind: Link['kind'] = source === null ? 'entry' : sourceBucket === targetBucket ? 'intra-period' : 'transition';
        const pair: readonly [string | null, string] = [sourceKey, datum.to];
        if (source === null || source.key !== target.key) {
            const splitByRawPair = targetKey !== datum.to || (sourceKey !== null && sourceKey !== datum.from);
            const link = linkFor(source, target, kind, pair, splitByRawPair);
            link.weight += weight;
            addPair(link.pairs, pair);
        }
    }

    for (const node of nodes.values()) {
        node.weight = Math.max(node.eventWeight, node.outgoingWeight);
        const rawActivity = [...node.rawKeys].map((key) => [
            key,
            Math.max(node.rawEventWeights.get(key) ?? 0, node.rawOutgoingWeights.get(key) ?? 0),
        ] as const);
        const totalRawActivity = rawActivity.reduce((sum, [, weight]) => sum + weight, 0);
        if (!Number.isFinite(totalRawActivity)) throw new RangeError('Aggregated flow weights must remain finite.');
        if (totalRawActivity > 0) {
            for (const [key, weight] of rawActivity) {
                node.continuityWeights.set(key, (weight / totalRawActivity) * node.weight);
            }
        }
    }
    const nodeLists = new Map<number, Node[]>();
    for (const node of nodes.values()) {
        const list = nodeLists.get(node.bucket) ?? [];
        list.push(node);
        nodeLists.set(node.bucket, list);
    }
    const preferredOrder = new Map((options.order ?? []).map((key, index) => [key, index]));
    const compareNodes = (a: Node, b: Node): number =>
        (preferredOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
            (preferredOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER) ||
        a.key.localeCompare(b.key);
    for (const list of nodeLists.values()) list.sort(compareNodes);

    const columnWeights = [...nodeLists.values()].map((list) => list.reduce((sum, node) => sum + node.weight, 0));
    if (columnWeights.some((weight) => !Number.isFinite(weight))) throw new RangeError('Aggregated flow column weights must remain finite.');
    const maxColumnWeight = Math.max(1, ...columnWeights);
    const maxNodeCount = Math.max(1, ...[...nodeLists.values()].map((list) => list.length));
    const plotTop = 38;
    const plotBottom = height - 58;
    const plotHeight = Math.max(1, plotBottom - plotTop);
    const gap = Math.min(maxNodeCount > 30 ? 5 : 15, plotHeight / (maxNodeCount + 1));
    const valueScale = Math.max(0, (plotHeight - gap * (maxNodeCount - 1)) / maxColumnWeight);
    for (const list of nodeLists.values()) {
        const contentHeight = list.reduce((sum, node) => sum + node.weight * valueScale, 0) + gap * Math.max(0, list.length - 1);
        let y = plotTop + Math.max(0, (plotHeight - contentHeight) / 2);
        for (const node of list) {
            node.y = y;
            node.height = node.weight * valueScale;
            node.continuityCenters.clear();
            node.rawTops.clear();
            let continuityY = node.y;
            for (const [key, weight] of [...node.continuityWeights].sort(([a], [b]) => a.localeCompare(b))) {
                node.rawTops.set(key, continuityY);
                node.continuityCenters.set(key, continuityY + weight * valueScale / 2);
                continuityY += weight * valueScale;
            }
            y += node.height + gap;
        }
    }

    const inferredMigrations: InferredMigration[] = [];
    const inferredIncoming = new Map<Node, Map<string, number>>();
    const inferredOutgoing = new Map<Node, Map<string, number>>();
    const incomingAbove = new Map<Node, Map<string, number>>();
    const outgoingAbove = new Map<Node, Map<string, number>>();
    if (options.inferMigrations) {
        for (let index = 0; index < periods.length - 1; index += 1) {
            const before = new Map((nodeLists.get(periods[index].time) ?? [])
                .flatMap((node) => [...node.rawEventWeights].map(([key, weight]) => [key, { node, weight }] as const)));
            const after = new Map((nodeLists.get(periods[index + 1].time) ?? [])
                .flatMap((node) => [...node.rawEventWeights].map(([key, weight]) => [key, { node, weight }] as const)));
            const declines = [...before].map(([key, { node, weight }]) => ({
                key, node, drop: weight - (after.get(key)?.weight ?? 0),
                remaining: weight - (after.get(key)?.weight ?? 0),
            })).filter(({ remaining }) => remaining > 0)
                .sort((a, b) => b.drop - a.drop || a.key.localeCompare(b.key));
            const rises = [...after].map(([key, { node, weight }]) => ({
                key, node, rise: weight - (before.get(key)?.weight ?? 0),
                remaining: weight - (before.get(key)?.weight ?? 0),
            })).filter(({ remaining }) => remaining > 0)
                .sort((a, b) => b.rise - a.rise || a.key.localeCompare(b.key));
            // Largest deltas first keeps the diagram legible. This is a visual pairing, not an identity match.
            for (const decline of declines) {
                for (const rise of rises) {
                    if (decline.remaining === 0) break;
                    if (rise.remaining === 0 || decline.node.key === rise.node.key) continue;
                    const weight = Math.min(decline.remaining, rise.remaining);
                    inferredMigrations.push({
                        source: decline.node, target: rise.node, from: decline.key, to: rise.key,
                        drop: decline.drop, rise: rise.rise, weight,
                        sourceOffset: 0, targetOffset: 0,
                    });
                    decline.remaining -= weight;
                    rise.remaining -= weight;
                    const incoming = inferredIncoming.get(rise.node) ?? new Map<string, number>();
                    incoming.set(rise.key, (incoming.get(rise.key) ?? 0) + weight);
                    inferredIncoming.set(rise.node, incoming);
                    const outgoing = inferredOutgoing.get(decline.node) ?? new Map<string, number>();
                    outgoing.set(decline.key, (outgoing.get(decline.key) ?? 0) + weight);
                    inferredOutgoing.set(decline.node, outgoing);
                }
            }
        }

        const rawCenter = (node: Node, key: string): number =>
            node.rawTops.get(key)! + (node.rawEventWeights.get(key) ?? 0) * valueScale / 2;
        const placeMigrations = (atSource: boolean, aboveWeights: Map<Node, Map<string, number>>): void => {
            const grouped = new Map<Node, Map<string, InferredMigration[]>>();
            for (const migration of inferredMigrations) {
                const node = atSource ? migration.source : migration.target;
                const key = atSource ? migration.from : migration.to;
                const byKey = grouped.get(node) ?? new Map<string, InferredMigration[]>();
                const group = byKey.get(key) ?? [];
                group.push(migration);
                byKey.set(key, group);
                grouped.set(node, byKey);
            }
            for (const [node, byKey] of grouped) {
                const aboveByKey = new Map<string, number>();
                aboveWeights.set(node, aboveByKey);
                for (const [key, group] of byKey) {
                    const otherCenter = (migration: InferredMigration): number => atSource
                        ? rawCenter(migration.target, migration.to) : rawCenter(migration.source, migration.from);
                    const ordered = [...group].sort((a, b) => otherCenter(a) - otherCenter(b) ||
                        (atSource ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
                    const above = ordered.filter((migration) => otherCenter(migration) < rawCenter(node, key));
                    const below = ordered.filter((migration) => otherCenter(migration) >= rawCenter(node, key));
                    const aboveWeight = above.reduce((sum, migration) => sum + migration.weight, 0);
                    const belowWeight = below.reduce((sum, migration) => sum + migration.weight, 0);
                    aboveByKey.set(key, aboveWeight);
                    const place = (migrations: readonly InferredMigration[], start: number): void => {
                        const cursor = { value: start };
                        for (const migration of migrations) {
                            if (atSource) migration.sourceOffset = cursor.value;
                            else migration.targetOffset = cursor.value;
                            cursor.value += migration.weight * valueScale;
                        }
                    };
                    // Keep the retained model in the middle; links to models above/below hug the respective edges.
                    place(above, node.rawTops.get(key)!);
                    place(below, node.rawTops.get(key)! + ((node.rawEventWeights.get(key) ?? 0) - belowWeight) * valueScale);
                }
            }
        };
        placeMigrations(true, outgoingAbove);
        placeMigrations(false, incomingAbove);
    }

    const incomingByNode = new Map<Node, Link[]>();
    const outgoingByNode = new Map<Node, Link[]>();
    for (const link of links) {
        const incoming = incomingByNode.get(link.target) ?? [];
        incoming.push(link);
        incomingByNode.set(link.target, incoming);
        if (link.source) {
            const outgoing = outgoingByNode.get(link.source) ?? [];
            outgoing.push(link);
            outgoingByNode.set(link.source, outgoing);
        }
    }
    const pairForLink = (link: Link): readonly [string | null, string] => link.pairs.values().next().value!;
    for (const node of nodes.values()) {
        const incomingByRawKey = new Map<string, Link[]>();
        for (const link of incomingByNode.get(node) ?? []) {
            const rawKey = pairForLink(link)[1];
            const incoming = incomingByRawKey.get(rawKey) ?? [];
            incoming.push(link);
            incomingByRawKey.set(rawKey, incoming);
        }
        let incomingOffset = node.y + Math.max(0, (node.height - node.eventWeight * valueScale) / 2);
        for (const [rawKey, rawWeight] of [...node.rawEventWeights].sort(([a], [b]) => a.localeCompare(b))) {
            const incoming = incomingByRawKey.get(rawKey) ?? [];
            if (incoming.length > 0) {
                incoming.sort((a, b) =>
                    (a.source?.bucket ?? Number.MIN_SAFE_INTEGER) - (b.source?.bucket ?? Number.MIN_SAFE_INTEGER) ||
                    (a.source?.y ?? a.target.y) - (b.source?.y ?? b.target.y) ||
                    (pairForLink(a)[0] ?? '').localeCompare(pairForLink(b)[0] ?? ''),
                );
                let rawOffset = incomingOffset;
                for (const link of incoming) {
                    link.targetOffset = rawOffset;
                    rawOffset += link.weight * valueScale;
                }
            }
            incomingOffset += rawWeight * valueScale;
        }

        const outgoingByRawKey = new Map<string, Link[]>();
        for (const link of outgoingByNode.get(node) ?? []) {
            const rawKey = pairForLink(link)[0];
            if (rawKey === null) continue;
            const outgoing = outgoingByRawKey.get(rawKey) ?? [];
            outgoing.push(link);
            outgoingByRawKey.set(rawKey, outgoing);
        }
        let outgoingOffset = node.y + Math.max(0, (node.height - node.outgoingWeight * valueScale) / 2);
        for (const [rawKey, rawWeight] of [...node.rawOutgoingWeights].sort(([a], [b]) => a.localeCompare(b))) {
            const outgoing = outgoingByRawKey.get(rawKey) ?? [];
            if (outgoing.length > 0) {
                outgoing.sort((a, b) =>
                    a.target.bucket - b.target.bucket || a.target.y - b.target.y || a.target.key.localeCompare(b.target.key) ||
                    pairForLink(a)[1].localeCompare(pairForLink(b)[1]),
                );
                let rawOffset = outgoingOffset;
                for (const link of outgoing) {
                    link.sourceOffset = rawOffset;
                    rawOffset += link.weight * valueScale;
                }
            }
            outgoingOffset += rawWeight * valueScale;
        }
    }

    const left = Math.min(width * 0.24, Math.max(38, width * 0.065));
    const right = Math.min(width * 0.16, Math.max(20, width * 0.035));
    const firstX = periods.length > 1 ? left + Math.min(45, width * 0.025) : width / 2;
    const lastX = periods.length > 1 ? Math.max(firstX, width - right) : firstX;
    const columnStep = periods.length > 1 ? (lastX - firstX) / (periods.length - 1) : 0;
    const xFor = (bucket: number): number => {
        const index = Math.max(0, Math.min(periods.length - 1, periodIndexByTime.get(bucket) ?? 0));
        return periods.length > 1 ? firstX + index * columnStep : firstX;
    };
    const nodeWidth = Math.min(12, Math.max(4, periods.length > 1 ? columnStep * 0.35 : width / 100));
    const getColor = options.colorFor ?? ((key: string) => {
        const keys = [...categoryWeights.keys()].sort(compareCategoryByOrder(preferredOrder));
        const index = Math.max(0, keys.indexOf(key));
        return FLOW_PALETTE[index % FLOW_PALETTE.length];
    });
    const getStreamColor = (rawKey: string, displayKey: string): string => options.streamColorFor?.(rawKey, displayKey) ?? getColor(displayKey);
    const getName = options.displayName ?? ((key: string) => key);
    const formatValue = options.formatValue ?? defaultValueLabel;
    const nameFor = (key: string): string => getName(key);
    const formatNodeTitle = (context: FlowNodeTitleContext): string =>
        options.formatNodeTitle?.(context) ?? `${context.period} · ${context.label} · ${formatValue(context.value)}`;
    const formatLinkTitle = (context: FlowLinkTitleContext): string => {
        if (options.formatLinkTitle) return options.formatLinkTitle(context);
        if (context.kind === 'entry') return `${formatValue(context.value)} into ${context.toLabel} (${context.toPeriod})`;
        if (context.kind === 'intra-period') {
            return `${formatValue(context.value)} ${context.fromLabel} → ${context.toLabel} within ${context.toPeriod}`;
        }
        return `${formatValue(context.value)} ${context.fromLabel} (${context.fromPeriod}) → ${context.toLabel} (${context.toPeriod})`;
    };
    const formatMigrationTitle = options.formatMigrationTitle ?? ((context: FlowMigrationTitleContext) =>
        `Apparent shift: ${context.fromLabel} fell by ${formatValue(context.drop)} and ` +
        `${context.toLabel} rose by ${formatValue(context.rise)} from ${context.fromPeriod} to ${context.toPeriod}. ` +
        `Up to ${formatValue(context.value)} line up; this is not a tracked switch.`);
    const markTooltip = (title: string): { attributes: string; content: string } => {
        const escaped = escapeSvg(title);
        return options.nativeTooltips === false
            ? { attributes: ` data-flow-tooltip="${escaped}" aria-label="${escaped}"`, content: '' }
            : { attributes: '', content: `<title>${escaped}</title>` };
    };
    const crossPeriodPath = (leftEdge: number, rightEdge: number, sourceY: number, targetY: number, streamHeight: number): string => {
        const bend = Math.max(4, (rightEdge - leftEdge) * 0.46);
        return `M ${leftEdge} ${sourceY - streamHeight / 2} C ${leftEdge + bend} ${sourceY - streamHeight / 2}, ${rightEdge - bend} ${targetY - streamHeight / 2}, ${rightEdge} ${targetY - streamHeight / 2} L ${rightEdge} ${targetY + streamHeight / 2} C ${rightEdge - bend} ${targetY + streamHeight / 2}, ${leftEdge + bend} ${sourceY + streamHeight / 2}, ${leftEdge} ${sourceY + streamHeight / 2} Z`;
    };

    const periodLabels = new Map(periods.map((period) => [period.time, period.label]));
    const tickSpacing = Math.max(44, Math.min(82, intervalDays === 30 ? 70 : intervalDays === 7 ? 60 : 54));
    const tickStride = Math.max(1, Math.ceil(tickSpacing / Math.max(1, columnStep)));
    const parts: string[] = [];
    parts.push(
        `<svg class="usage-chart flow-svg" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" data-flow-plot-start-x="${firstX}" data-flow-plot-end-x="${lastX}" data-flow-plot-start-time="${firstBucket}" data-flow-plot-end-time="${lastBucket}" role="img" aria-label="${escapeSvg(options.ariaLabel ?? 'Chronological weighted flows between categories')}">`
    );

    for (const [index, period] of periods.entries()) {
        const x = xFor(period.time);
        parts.push(`<line class="chart-gridline" x1="${x}" y1="24" x2="${x}" y2="${plotBottom}" />`);
        if (index % tickStride === 0 || index === periods.length - 1) {
            parts.push(`<line class="date-tick" x1="${x}" y1="${plotBottom}" x2="${x}" y2="${plotBottom + 5}" />`);
            parts.push(`<text class="date-label" x="${x}" y="${plotBottom + 24}" text-anchor="middle">${escapeSvg(period.label)}</text>`);
        }
    }

    type EntryDetails = { titles: string[]; pairs: Map<string, readonly [string | null, string]> };
    const continuityEntries = new Map<string, EntryDetails>();
    const linkedEntries = new Map<Link, EntryDetails>();
    const absorbedEntryLinks = new Set<Link>();
    const addEntryDetails = <Key extends string | Link>(detailsByTarget: Map<Key, EntryDetails>, key: Key, link: Link, title: string): void => {
        const details: EntryDetails = detailsByTarget.get(key) ?? { titles: [], pairs: new Map<string, readonly [string | null, string]>() };
        details.titles.push(title);
        for (const [key, pair] of link.pairs) details.pairs.set(key, pair);
        detailsByTarget.set(key, details);
    };
    for (const link of links) {
        if (link.kind !== 'entry') continue;
        if (options.inferMigrations) continue;
        const [, entryTarget] = pairForLink(link);
        const context: FlowLinkTitleContext = {
            kind: link.kind,
            to: entryTarget,
            toLabel: nameFor(entryTarget),
            time: link.target.bucket,
            toPeriod: periodLabels.get(link.target.bucket) ?? '',
            value: link.weight,
        };
        const title = formatLinkTitle(context);
        const previousBucket = previousPeriodByTime.get(link.target.bucket);
        const previousNodes = previousBucket === undefined ? [] : nodeLists.get(previousBucket) ?? [];
        const continuousPredecessor = previousNodes.find((node) =>
            node.key === link.target.key && node.rawKeys.has(entryTarget),
        );
        if (continuousPredecessor) {
            addEntryDetails(continuityEntries, `${link.target.id}\u0000${entryTarget}`, link, title);
            absorbedEntryLinks.add(link);
            continue;
        }

        const observedPredecessor = links
            .filter((candidate) => candidate !== link && candidate.target === link.target && candidate.source !== null)
            .sort((a, b) => b.weight - a.weight)
            .find((candidate) => [...candidate.pairs.values()].some(([, target]) => target === entryTarget));
        if (observedPredecessor) {
            addEntryDetails(linkedEntries, observedPredecessor, link, title);
            absorbedEntryLinks.add(link);
        }
    }

    const formatContinuityTitle = options.formatContinuityTitle ?? ((context: FlowContinuityTitleContext) => {
        const carried = context.movedEntryTitle ? ` ${context.movedEntryTitle}` : '';
        return `Visual continuity: ${context.label} appears in ${context.fromPeriod} and ${context.toPeriod}; this does not track individual sessions.${carried}`;
    });
    for (let index = 0; index < periods.length - 1; index += 1) {
        const current = nodeLists.get(periods[index].time) ?? [];
        const next = nodeLists.get(periods[index + 1].time) ?? [];
        const nextByKey = new Map(next.map((node) => [node.key, node]));
        for (const node of current) {
            const following = nextByKey.get(node.key);
            if (!following) continue;
            const continuingKeys = [...node.rawKeys].filter((key) => following.rawKeys.has(key)).sort();
            for (const key of continuingKeys) {
                const fromWeight = node.continuityWeights.get(key) ?? 0;
                const toWeight = following.continuityWeights.get(key) ?? 0;
                if (fromWeight <= 0 || toWeight <= 0) continue;
                const x1 = xFor(node.bucket) + nodeWidth / 2;
                const x2 = xFor(following.bucket) - nodeWidth / 2;
                const retained = Math.min(node.rawEventWeights.get(key) ?? 0, following.rawEventWeights.get(key) ?? 0);
                const startY = options.inferMigrations
                    ? node.rawTops.get(key)! + ((outgoingAbove.get(node)?.get(key) ?? 0) +
                        ((node.rawEventWeights.get(key) ?? 0) - retained - (inferredOutgoing.get(node)?.get(key) ?? 0)) / 2 +
                        retained / 2) * valueScale
                    : node.continuityCenters.get(key) ?? node.y + node.height / 2;
                const endY = options.inferMigrations
                    ? following.rawTops.get(key)! + ((incomingAbove.get(following)?.get(key) ?? 0) + retained / 2) * valueScale
                    : following.continuityCenters.get(key) ?? following.y + following.height / 2;
                const control = Math.max(0, (x2 - x1) * 0.45);
                const fromBand = options.inferMigrations ? retained * valueScale : Math.min(node.height, Math.max(1, fromWeight * valueScale));
                const toBand = options.inferMigrations ? retained * valueScale : Math.min(following.height, Math.max(1, toWeight * valueScale));
                const path = `M ${x1} ${startY - fromBand / 2} C ${x1 + control} ${startY - fromBand / 2}, ${x2 - control} ${endY - toBand / 2}, ${x2} ${endY - toBand / 2} L ${x2} ${endY + toBand / 2} C ${x2 - control} ${endY + toBand / 2}, ${x1 + control} ${startY + fromBand / 2}, ${x1} ${startY + fromBand / 2} Z`;
                const attachedEntries = continuityEntries.get(`${following.id}\u0000${key}`);
                const title = formatContinuityTitle({
                    key,
                    label: nameFor(key),
                    fromTime: node.bucket,
                    time: following.bucket,
                    fromPeriod: periods[index].label,
                    toPeriod: periods[index + 1].label,
                    fromValue: node.rawEventWeights.get(key) ?? 0,
                    toValue: following.rawEventWeights.get(key) ?? 0,
                    movedEntryTitle: attachedEntries?.titles.join('. '),
                });
                const continuityPairMap = new Map<string, readonly [string | null, string]>();
                const pair = [null, key] as const;
                continuityPairMap.set(uniquePairKey(pair), pair);
                for (const [pairKey, attachedPair] of attachedEntries?.pairs ?? []) continuityPairMap.set(pairKey, attachedPair);
                const continuityPairs = escapeSvg(JSON.stringify([...continuityPairMap.values()]));
                const tooltip = markTooltip(title);
                parts.push(
                    `<path class="continuity-ribbon" d="${path}" fill="${escapeSvg(getStreamColor(key, node.key))}" opacity=".12" data-flow-action="link" data-flow-pairs="${continuityPairs}"${tooltip.attributes}>${tooltip.content}</path>`
                );
            }
        }
    }

    for (const migration of inferredMigrations) {
        const leftEdge = xFor(migration.source.bucket) + nodeWidth / 2;
        const rightEdge = xFor(migration.target.bucket) - nodeWidth / 2;
        const sourceY = migration.sourceOffset + migration.weight * valueScale / 2;
        const targetY = migration.targetOffset + migration.weight * valueScale / 2;
        const title = formatMigrationTitle({
            from: migration.from, to: migration.to,
            fromLabel: nameFor(migration.from), toLabel: nameFor(migration.to),
            fromPeriod: periodLabels.get(migration.source.bucket) ?? '',
            toPeriod: periodLabels.get(migration.target.bucket) ?? '',
            drop: migration.drop, rise: migration.rise, value: migration.weight,
        });
        const pair = escapeSvg(JSON.stringify([[migration.from, migration.to]]));
        const tooltip = markTooltip(title);
        parts.push(`<path class="flow-ribbon flow-inferred" d="${crossPeriodPath(leftEdge, rightEdge, sourceY, targetY, migration.weight * valueScale)}" fill="${escapeSvg(getStreamColor(migration.to, migration.target.key))}" opacity=".5" data-flow-inferred="true" data-flow-action="link" data-flow-pairs="${pair}"${tooltip.attributes}>${tooltip.content}</path>`);
    }

    const orderedLinks = [...links].sort((a, b) => {
        if (a.kind === 'entry' && b.kind !== 'entry') return -1;
        if (a.kind !== 'entry' && b.kind === 'entry') return 1;
        return (a.source?.y ?? a.target.y) - (b.source?.y ?? b.target.y);
    });
    for (const link of orderedLinks) {
        const targetX = xFor(link.target.bucket);
        const [sourceRawKey, targetRawKey] = pairForLink(link);
        const color = escapeSvg(getStreamColor(targetRawKey, link.target.key));
        const previousBucket = previousPeriodByTime.get(link.target.bucket);
        const previousWeight = options.inferMigrations && previousBucket !== undefined
            ? (nodeLists.get(previousBucket) ?? []).find((node) => node.rawEventWeights.has(targetRawKey))?.rawEventWeights.get(targetRawKey) ?? 0 : 0;
        const retained = Math.min(previousWeight, link.weight);
        const incoming = inferredIncoming.get(link.target)?.get(targetRawKey) ?? 0;
        const entryWeight = options.inferMigrations && link.kind === 'entry' ? link.weight - retained - incoming : link.weight;
        if (entryWeight <= 0) continue;
        const titleContext: FlowLinkTitleContext = {
            kind: link.kind,
            from: sourceRawKey ?? undefined,
            to: targetRawKey,
            fromLabel: sourceRawKey ? nameFor(sourceRawKey) : undefined,
            toLabel: nameFor(targetRawKey),
            fromTime: link.source?.bucket,
            time: link.target.bucket,
            fromPeriod: link.source ? periodLabels.get(link.source.bucket) : undefined,
            toPeriod: periodLabels.get(link.target.bucket) ?? '',
            value: entryWeight,
        };
        const title = formatLinkTitle(titleContext);
        if (link.kind === 'entry') {
            if (absorbedEntryLinks.has(link)) continue;
            const backtailX = targetX - 38;
            const entryOffset = options.inferMigrations
                ? link.target.rawTops.get(targetRawKey)! + (retained + (incomingAbove.get(link.target)?.get(targetRawKey) ?? 0)) * valueScale
                : link.targetOffset;
            const centerY = entryOffset + entryWeight * valueScale / 2;
            const streamHeight = entryWeight * valueScale;
            const clickPairs = escapeSvg(JSON.stringify([...link.pairs.values()]));
            const blockTop = centerY - Math.max(3, streamHeight) / 2;
            const tooltip = markTooltip(title);
            parts.push(
                `<rect class="flow-entry-block" x="${backtailX - 7}" y="${blockTop}" width="12" height="${Math.max(6, streamHeight)}" rx="3" fill="${color}" opacity=".62" data-flow-action="link" data-flow-pairs="${clickPairs}"${tooltip.attributes}>${tooltip.content}</rect>`
            );
            const path = `M ${backtailX} ${centerY - streamHeight / 2} C ${backtailX + 18} ${centerY - streamHeight / 2}, ${targetX - 22} ${centerY - streamHeight / 2}, ${targetX - nodeWidth / 2} ${centerY - streamHeight / 2} L ${targetX - nodeWidth / 2} ${centerY + streamHeight / 2} C ${targetX - 22} ${centerY + streamHeight / 2}, ${backtailX + 18} ${centerY + streamHeight / 2}, ${backtailX} ${centerY + streamHeight / 2} Z`;
            parts.push(
                `<path class="flow-ribbon flow-entry" d="${path}" fill="${color}" opacity=".48" data-flow-action="link" data-flow-pairs="${clickPairs}"${tooltip.attributes}>${tooltip.content}</path>`
            );
            continue;
        }

        const source = link.source;
        if (!source) continue;
        const sourceX = xFor(source.bucket);
        const sourceY = link.sourceOffset + link.weight * valueScale / 2;
        const targetY = link.targetOffset + link.weight * valueScale / 2;
        const streamHeight = Math.max(0.7, link.weight * valueScale);
        const leftEdge = sourceX + nodeWidth / 2;
        const rightEdge = targetX - nodeWidth / 2;
        const attachedEntries = linkedEntries.get(link);
        const clickPairMap = new Map(link.pairs);
        for (const [key, pair] of attachedEntries?.pairs ?? []) clickPairMap.set(key, pair);
        const clickPairs = escapeSvg(JSON.stringify([...clickPairMap.values()]));
        const linkedTitle = attachedEntries ? `${title}. ${attachedEntries.titles.join('. ')}` : title;
        const tooltip = markTooltip(linkedTitle);
        const path = link.kind === 'intra-period'
            ? (() => {
                const edgeX = sourceX + nodeWidth / 2;
                const laneX = edgeX + Math.min(42, Math.max(24, width * 0.018));
                return `M ${edgeX} ${sourceY - streamHeight / 2} C ${laneX} ${sourceY - streamHeight / 2}, ${laneX} ${targetY - streamHeight / 2}, ${edgeX} ${targetY - streamHeight / 2} L ${edgeX} ${targetY + streamHeight / 2} C ${laneX} ${targetY + streamHeight / 2}, ${laneX} ${sourceY + streamHeight / 2}, ${edgeX} ${sourceY + streamHeight / 2} Z`;
            })()
            : crossPeriodPath(leftEdge, rightEdge, sourceY, targetY, streamHeight);
        parts.push(
            `<path class="flow-ribbon ${link.kind === 'intra-period' ? 'flow-intra' : 'flow-transition'}" d="${path}" fill="${color}" opacity="${link.kind === 'intra-period' ? '.58' : '.30'}" data-flow-action="link" data-flow-pairs="${clickPairs}"${tooltip.attributes}>${tooltip.content}</path>`
        );
    }

    for (const [index, period] of periods.entries()) {
        const list = nodeLists.get(period.time) ?? [];
        for (const node of list) {
            const x = xFor(period.time);
            const color = escapeSvg(getColor(node.key));
            const label = nameFor(node.key);
            const context: FlowNodeTitleContext = {
                key: node.key,
                label,
                time: period.time,
                period: period.label,
                value: node.eventWeight,
            };
            const title = formatNodeTitle(context);
            const rawValues = escapeSvg(JSON.stringify([...node.rawKeys]));
            const tooltip = markTooltip(title);
            parts.push(
                `<rect class="usage-node" x="${x - nodeWidth / 2}" y="${node.y}" width="${nodeWidth}" height="${Math.max(4, node.height)}" rx="3" fill="${color}" data-flow-action="node" data-flow-values="${rawValues}"${tooltip.attributes}>${tooltip.content}</rect>`
            );
        }
        if (index === periods.length - 1) break;
    }

    const axisY = plotBottom + 1;
    parts.push(`<line class="date-axis" x1="${firstX}" y1="${axisY}" x2="${lastX}" y2="${axisY}" />`);
    parts.push(`<text class="axis-caption" x="${(firstX + lastX) / 2}" y="${height - 2}" text-anchor="middle">${escapeSvg(options.axisCaption ?? 'EARLIER ← TIME → LATER')}</text>`);
    parts.push('</svg>');
    return parts.join('');
}

const compareCategoryByOrder = (order: ReadonlyMap<string, number>) => (a: string, b: string): number =>
    (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b);
