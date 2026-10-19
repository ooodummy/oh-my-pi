import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import { ExtensionStatuses, type ExtensionStatusOptions } from "../src/status-line/extension-status";

function descendants(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(child => ("k" in child ? descendants(child) : []))];
}
function nodes(statuses: ExtensionStatuses): NativeNode[] {
	return statuses.describe({}).flatMap(descendants);
}
function meter(statuses: ExtensionStatuses) {
	return nodes(statuses).find(node => node.k === "meter");
}
const brief: ExtensionStatusOptions = { label: "Index", progressMotion: "brief", icon: "sync", tone: "accent" };

describe("finite extension status motion", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setSystemTime(1000);
		setNativeRendering(true);
	});
	afterEach(() => {
		setNativeRendering(false);
		vi.useRealTimers();
		setSystemTime();
	});

	it("fills only to observed progress, settles once, and never restarts for a changed tooltip", () => {
		let renders = 0;
		const statuses = new ExtensionStatuses(() => renders++);
		try {
			statuses.set("index", "Index", { ...brief, progress: 0.6 });
			expect(meter(statuses)).toMatchObject({ p: { value: 0, title: "Index — 60%" } });
			vi.advanceTimersByTime(60);
			const halfway = meter(statuses);
			if (halfway?.k !== "meter") throw new Error("Missing determinate meter");
			expect(halfway.p?.value).toBeGreaterThan(0);
			expect(halfway.p?.value).toBeLessThan(0.6);
			vi.advanceTimersByTime(60);
			expect(meter(statuses)).toMatchObject({ p: { value: 0.6, tone: "accent" } });
			vi.advanceTimersByTime(300);
			expect(meter(statuses)).toMatchObject({ p: { value: 0.6, tone: "muted" } });
			const settled = renders;
			statuses.set("index", "Index", { ...brief, progress: 0.6, title: "Scanning; same observed job" });
			vi.advanceTimersByTime(10_000);
			expect(renders).toBe(settled);
			expect(meter(statuses)).toMatchObject({ p: { value: 0.6, tone: "muted" } });
		} finally {
			statuses.dispose();
		}
	});

	it("keeps unknown static and a fixed keyed mark slot across counts and failures", () => {
		let renders = 0;
		const statuses = new ExtensionStatuses(() => renders++);
		try {
			statuses.set("index", "Index", { ...brief, progress: null });
			const unknown = nodes(statuses),
				slot = unknown.find(node => node.key === "mark");
			expect(slot).toMatchObject({
				k: "row",
				p: { min: { w: "2ch", h: "1lines" }, max: { w: "2ch", h: "1lines" }, shrink: 0 },
			});
			expect(unknown.some(node => node.k === "meter")).toBe(false);
			vi.advanceTimersByTime(10_000);
			expect(renders).toBe(0);
			statuses.set("index", "Index", { ...brief, progress: 0.4 });
			vi.advanceTimersByTime(30);
			statuses.set("index", "Index", { ...brief, progress: undefined, icon: "x-circle", tone: "error" });
			const failed = nodes(statuses),
				failedSlot = failed.find(node => node.key === "mark");
			expect(failedSlot).toMatchObject({
				k: slot!.k,
				key: slot!.key,
				p: { min: slot!.p!.min, max: slot!.p!.max, tone: "error" },
			});
			expect(failed.some(node => node.k === "meter")).toBe(false);
			expect(failed.find(node => node.k === "icon")).toMatchObject({ p: { name: "x-circle", tone: "error" } });
			const stopped = renders;
			vi.advanceTimersByTime(10_000);
			expect(renders).toBe(stopped);
		} finally {
			statuses.dispose();
		}
	});

	it("reduced motion settles immediately, including a preference change during fill", () => {
		let renders = 0;
		const statuses = new ExtensionStatuses(() => renders++);
		try {
			statuses.setReduceMotion(true);
			statuses.set("index", "Index", { ...brief, progress: 0.3 });
			expect(meter(statuses)).toMatchObject({ p: { value: 0.3, tone: "muted" } });
			vi.advanceTimersByTime(10_000);
			expect(renders).toBe(0);
			statuses.setReduceMotion(false);
			statuses.set("index", "Index", { ...brief, progress: 1, tone: "success" });
			vi.advanceTimersByTime(30);
			statuses.setReduceMotion(true);
			expect(meter(statuses)).toMatchObject({ p: { value: 1, tone: "muted" } });
			const stopped = renders;
			vi.advanceTimersByTime(10_000);
			expect(renders).toBe(stopped);
		} finally {
			statuses.dispose();
		}
	});

	it("clear, disposal and native exit cancel every remaining transition callback", () => {
		for (const stop of ["clear", "dispose", "exit"]) {
			setNativeRendering(true);
			let renders = 0;
			const statuses = new ExtensionStatuses(() => renders++);
			statuses.set("index", "Index", { ...brief, progress: 0.8 });
			vi.advanceTimersByTime(30);
			if (stop === "clear") statuses.set("index", undefined);
			else if (stop === "dispose") statuses.dispose();
			else setNativeRendering(false);
			const stopped = renders;
			vi.advanceTimersByTime(10_000);
			expect(renders).toBe(stopped);
			if (stop === "clear") expect(statuses.describe({})).toEqual([]);
			statuses.dispose();
		}
	});

	it("keeps activation identity for the same callback while invoking current state", () => {
		const statuses = new ExtensionStatuses();
		let current = 1,
			activated = 0;
		const onActivate = () => {
			activated = current;
		};
		statuses.set("index", "Index", { ...brief, onActivate });
		const action = nodes(statuses).find(node => node.k === "seg")?.p?.actions?.click;
		current = 2;
		statuses.set("index", "Index", { ...brief, title: "New observation", onActivate });
		expect(nodes(statuses).find(node => node.k === "seg")?.p?.actions?.click).toBe(action);
		expect(statuses.activate(action!)).toBe(true);
		expect(activated).toBe(2);
		statuses.set("index", undefined);
		expect(statuses.activate(action!)).toBe(false);
		statuses.dispose();
	});
});
