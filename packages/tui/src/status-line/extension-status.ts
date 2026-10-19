import type { TspCommonProps, TspProps, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeStatusText } from "../chrome/shared";
import { node, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { isNativeRendering, onNativeRenderingChange } from "../native/state";

/** Optional native presentation; text terminals and RPC retain the supplied fallback text. */
export interface ExtensionStatusOptions {
	/** Native label, without terminal progress glyphs. Defaults to the fallback text. */
	label?: string;
	/** Exact normalized progress: 0–1, null for unknown, omitted for no meter. */
	progress?: number | null;
	/** Brief finite determinate fill, then a muted mark. Unknown progress stays static. */
	progressMotion?: "brief";
	/** Named native icon in the meter's fixed slot when progress is omitted. */
	icon?: string;
	tone?: TspTone;
	/** Hover details and accessible description. */
	title?: string;
	/** Interactive native activation; never submits a user message or starts a turn. */
	onActivate?: () => void | Promise<void>;
}

interface StatusEntry {
	text: string;
	options: ExtensionStatusOptions | undefined;
	action: string | undefined;
	motion?: { from: number; to: number; started: number };
	settled?: boolean;
}

/** Owns replacement semantics, stable ordering, native descriptions and status-only actions. */
export class ExtensionStatuses {
	#entries = new Map<string, StatusEntry>();
	#ordered: readonly (readonly [string, StatusEntry])[] = [];
	#texts: readonly string[] = [];
	#nextAction = 0;
	#timer: NodeJS.Timeout | undefined;
	#unwatchNative: (() => void) | undefined;
	#reduceMotion = false;
	#disposed = false;

	constructor(private readonly changed: () => void = () => {}) {}

	/** The composer forwards the terminal's current motion preference before describing. */
	setReduceMotion(reduce: boolean): void {
		this.#reduceMotion = reduce;
		if (reduce) this.#settle();
	}

	dispose(): void {
		this.#disposed = true;
		this.#clearTimer();
		for (const entry of this.#entries.values()) entry.motion = undefined;
	}

	#clearTimer(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#unwatchNative?.();
		this.#unwatchNative = undefined;
	}

	#settle(): void {
		this.#clearTimer();
		let changed = false;
		for (const entry of this.#entries.values()) {
			if (!entry.motion) continue;
			entry.motion = undefined;
			entry.settled = true;
			changed = true;
		}
		if (changed) this.changed();
	}

	#value(entry: StatusEntry, now: number): number | null | undefined {
		const motion = entry.motion;
		if (!motion) return entry.options?.progress;
		const t = Math.min(1, Math.max(0, (now - motion.started) / 120));
		return motion.from + (motion.to - motion.from) * (1 - (1 - t) ** 3);
	}

	#hasMotion(): boolean {
		for (const entry of this.#entries.values()) if (entry.motion) return true;
		return false;
	}

	#schedule(): void {
		if (this.#timer !== undefined) return;
		if (!this.#hasMotion()) {
			this.#clearTimer();
			return;
		}
		const now = Date.now();
		let delay = 420;
		for (const entry of this.#entries.values()) {
			if (!entry.motion) continue;
			const elapsed = now - entry.motion.started;
			delay = Math.min(delay, elapsed < 120 ? Math.min(30, 120 - elapsed) : Math.max(0, 420 - elapsed));
		}
		this.#unwatchNative ??= onNativeRenderingChange(on => {
			if (!on) this.#settle();
		});
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			if (!isNativeRendering() || this.#reduceMotion) {
				this.#settle();
				return;
			}
			const now = Date.now();
			for (const entry of this.#entries.values()) {
				if (!entry.motion || now - entry.motion.started < 420) continue;
				entry.motion = undefined;
				entry.settled = true;
			}
			this.changed();
			this.#schedule();
		}, delay);
		this.#timer.unref();
	}

	get texts(): readonly string[] {
		return this.#texts;
	}

	set(key: string, text: string | undefined, options?: ExtensionStatusOptions): boolean {
		if (text === undefined) {
			if (!this.#entries.delete(key)) return false;
		} else {
			const previous = this.#entries.get(key);
			const old = previous?.options;
			if (
				previous?.text === text &&
				old?.label === options?.label &&
				old?.progress === options?.progress &&
				old?.progressMotion === options?.progressMotion &&
				old?.icon === options?.icon &&
				old?.tone === options?.tone &&
				old?.title === options?.title &&
				old?.onActivate === options?.onActivate
			)
				return false;
			const now = Date.now();
			const sameMark =
				old?.progress === options?.progress &&
				old?.tone === options?.tone &&
				old?.progressMotion === options?.progressMotion;
			const brief =
				options?.progressMotion === "brief" &&
				typeof options.progress === "number" &&
				Number.isFinite(options.progress) &&
				options.tone !== "warning" &&
				options.tone !== "error";
			const priorValue = previous ? this.#value(previous, now) : 0;
			const target = typeof options?.progress === "number" ? Math.max(0, Math.min(1, options.progress)) : 0;
			const animate = brief && !sameMark && !this.#disposed && !this.#reduceMotion && isNativeRendering();
			this.#entries.set(key, {
				text,
				options: options && { ...options },
				action: options?.onActivate
					? old?.onActivate === options.onActivate
						? previous?.action
						: `status.extension.${++this.#nextAction}`
					: undefined,
				motion: sameMark
					? previous?.motion
					: animate
						? {
								from:
									typeof priorValue === "number" && Number.isFinite(priorValue) && priorValue <= target
										? priorValue
										: target,
								to: target,
								started: now,
							}
						: undefined,
				settled: sameMark ? previous?.settled : brief && !animate,
			});
		}
		this.#ordered = Array.from(this.#entries.entries()).sort(([a], [b]) => a.localeCompare(b));
		this.#texts = this.#ordered.map(([, entry]) => entry.text);
		if (!this.#hasMotion()) this.#clearTimer();
		else this.#schedule();
		return true;
	}

	activate(action: string): boolean {
		for (const [, entry] of this.#ordered) {
			if (entry.action !== action) continue;
			void entry.options?.onActivate?.();
			return true;
		}
		return false;
	}

	describe(props: TspProps<"seg">, dim = false): NativeNode[] {
		const now = Date.now();
		return this.#ordered.flatMap(([key, entry]) => {
			const options = entry.options;
			const label = sanitizeStatusText(options?.label ?? entry.text);
			if (!label) return [];
			const progress = options?.progress;
			const displayed = this.#value(entry, now);
			const value =
				typeof displayed === "number" && Number.isFinite(displayed) ? Math.max(0, Math.min(1, displayed)) : null;
			const detail =
				progress === undefined
					? entry.text
					: `${label} — ${typeof progress !== "number" || !Number.isFinite(progress) ? "Progress unknown" : `${Number((Math.max(0, Math.min(1, progress)) * 100).toFixed(3))}%`}`;
			const title = sanitizeStatusText(options?.title ?? detail);
			const spans = [span(label, dim ? "dim" : undefined)];
			const markProps = {
				min: { w: "2ch", h: "1lines" },
				max: { w: "2ch", h: "1lines" },
				shrink: 0,
				...(entry.settled ? { tone: "muted" as const } : options?.tone === undefined ? {} : { tone: options.tone }),
				title,
				aria: title,
			} satisfies TspCommonProps;
			const glyph =
				progress !== undefined && (options?.progressMotion !== "brief" || value !== null)
					? node("meter", { ...markProps, style: "ring", size: "sm", value }, undefined, "meter")
					: options?.icon
						? node("icon", { ...markProps, name: options.icon }, undefined, "icon")
						: undefined;
			const mark = glyph
				? node("row", { ...markProps, align: "center", justify: "between" }, [glyph], "mark")
				: undefined;
			return [
				node(
					"seg",
					{
						...props,
						...(mark ? {} : { spans }),
						...(entry.settled
							? { tone: "muted" as const }
							: options?.tone === undefined
								? {}
								: { tone: options.tone }),
						title,
						...(entry.action ? { actions: { click: entry.action } } : {}),
					},
					mark
						? [
								node(
									"row",
									{ gap: "xs", align: "center" },
									[mark, node("text", { spans, wrap: "none" }, undefined, "label")],
									"content",
								),
							]
						: undefined,
					`hook-${key}`,
				),
			];
		});
	}
}
