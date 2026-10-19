import { afterEach, describe, expect, it } from "bun:test";
import { el, node, withHidden } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode, NativeStylesheet, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { settleNative } from "@oh-my-pi/pi-tui/native/settle";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import type { TspStylesheet } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

const MAIN: NativeStylesheet = { name: "extension-main", css: ".extension-target { color: red }" };
const UPDATED: NativeStylesheet = { name: MAIN.name, css: ".extension-target { color: blue }" };

class Styled implements Component {
	current: NativeNode;
	events: NativeUiEvent[] = [];
	constructor(sheet: NativeStylesheet = MAIN) {
		this.current = {
			...el("div", undefined, [
				{
					...el(
						"button",
						{ class: "extension-target", text: "Open", actions: { click: "inspect" } },
						undefined,
						"target",
					),
					styles: [sheet],
				},
			]),
		};
	}
	render(): readonly string[] {
		return ["fallback"];
	}
	describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("el") && cx.stylesheets === true ? this.current : null;
	}
	handleNativeEvent(event: NativeUiEvent): void {
		this.events.push(event);
	}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

function sheets(h: TspHarness): TspStylesheet[] {
	return h.terminal.log.filter(message => message.verb === "s").map(message => message.body as TspStylesheet);
}

describe("native scoped styles and elements", () => {
	it("waits for the real hello before using el or styles, then installs sheets ahead of elements", async () => {
		const component = new Styled();
		harness = await TspHarness.start(tui => tui.addChild(component), { expected: true, manualProbe: true });
		const h = harness;
		expect(h.byId(nativeComponentId(component))?.k).toBe("rows");
		expect(sheets(h)).toEqual([]);
		h.terminal.answerProbe({ features: ["styles"] });
		h.flush();
		const sf = h.terminal.surface!;
		expect(h.byId(nativeComponentId(component))?.k).toBe("el");
		expect(sheets(h)).toEqual([{ sf, ...MAIN }]);
		const installed = h.terminal.log.findIndex(message => message.verb === "s");
		expect(h.terminal.log.slice(installed + 1).some(message => message.verb === "f")).toBe(true);
		expect(h.errors).toEqual([]);
	});

	it("sends no style traffic to old clients, even for an unconditional declaration", async () => {
		const component = new Styled();
		component.describe = () => ({ ...node("text", { text: "old client" }), styles: [MAIN] });
		harness = await TspHarness.start(tui => tui.addChild(component), {
			kinds: ["col", "text", "rows"],
			features: [],
		});
		expect(sheets(harness)).toEqual([]);
		expect(harness.byId(nativeComponentId(component))?.k).toBe("text");
	});

	it("shares static sheets, retains settled declarations, and sends CSS-only replacements without a frame", async () => {
		const settled = new Styled();
		settleNative(settled);
		const live = new Styled({ ...MAIN });
		harness = await TspHarness.start(
			tui => {
				tui.addChild(settled);
				tui.addChild(live);
			},
			{ features: ["styles", "settle"] },
		);
		const h = harness;
		const sf = h.terminal.surface!;
		expect(sheets(h)).toEqual([{ sf, ...MAIN }]);
		const frames = h.frames.length;
		live.current = { ...live.current, styles: [UPDATED] };
		await h.render();
		expect(h.frames).toHaveLength(frames);
		expect(sheets(h)).toEqual([
			{ sf, ...MAIN },
			{ sf, ...UPDATED },
		]);
		await h.render();
		await h.render();
		expect(sheets(h)).toHaveLength(2);
		// The unchanged settled component still mentions MAIN: it must not revert UPDATED.
		h.tui.stop();
		h.flush();
		h.tui.start();
		h.flush();
		expect(sheets(h).at(-1)).toEqual({ sf, ...UPDATED });
		expect(sheets(h)).toHaveLength(3);
		expect(h.region("main")?.c?.map(child => child.id)).toEqual([
			nativeComponentId(settled),
			nativeComponentId(live),
		]);
		h.event({ ev: "action", sf, id: `${nativeComponentId(settled)}.target`, act: "inspect" });
		expect(settled.events.at(-1)).toMatchObject({ type: "action", key: "target", act: "inspect" });
		live.current = { ...live.current, styles: [MAIN] };
		await h.render();
		expect(sheets(h).at(-1)).toEqual({ sf, ...MAIN });
		live.current = { ...live.current, styles: [UPDATED] };
		await h.render();
		expect(sheets(h).at(-1)).toEqual({ sf, ...UPDATED });
		expect(h.errors).toEqual([]);
	});

	it("installs sheets independently on fullscreen surfaces and replays them when a page reopens", async () => {
		const inline = new Styled();
		const page = new Styled();
		harness = await TspHarness.start(tui => tui.addChild(inline), { features: ["styles"] });
		const h = harness;
		const session = h.terminal.surface!;
		const overlay = h.tui.showOverlay(page, { fullscreen: true, width: "100%" });
		await h.render();
		const screen = h.terminal.surface!;
		expect(screen).not.toBe(session);
		expect(sheets(h)).toEqual([
			{ sf: session, ...MAIN },
			{ sf: screen, ...MAIN },
		]);
		h.event({ ev: "action", sf: screen, id: `${nativeComponentId(page)}.target`, act: "inspect" });
		expect(page.events.at(-1)).toMatchObject({ type: "action", key: "target" });
		overlay.hide();
		h.flush();
		expect(h.terminal.surface).toBe(session);
		h.tui.showOverlay(page, { fullscreen: true, width: "100%" });
		await h.render();
		const reopened = h.terminal.surface!;
		expect(reopened).not.toBe(screen);
		expect(sheets(h).at(-1)).toEqual({ sf: reopened, ...MAIN });
		expect(sheets(h)).toHaveLength(3);
		for (const sf of [session, screen, reopened]) {
			const installed = h.terminal.log.findIndex(message => {
				const body = message.body;
				return message.verb === "s" && body !== null && typeof body === "object" && "sf" in body && body.sf === sf;
			});
			const firstFrame = h.terminal.log.findIndex(message => {
				const body = message.body;
				return message.verb === "f" && body !== null && typeof body === "object" && "sf" in body && body.sf === sf;
			});
			expect(installed).toBeLessThan(firstFrame);
		}
		expect(h.errors).toEqual([]);
	});

	it("replays settled nested declarations on a fresh surface when a resumed surface reports gone", async () => {
		const component = new Styled();
		settleNative(component);
		harness = await TspHarness.start(tui => tui.addChild(component), { features: ["styles", "settle", "adopt"] });
		const h = harness;
		const previous = h.terminal.surface!;
		h.tui.stop();
		h.flush();
		h.tui.start();
		h.flush();
		h.terminal.docs.delete(previous);
		h.event({ ev: "gone", ids: [previous] });
		const sf = h.terminal.surface!;
		expect(sf).not.toBe(previous);
		expect(sheets(h).at(-1)).toEqual({ sf, ...MAIN });
		expect(h.byId(`${nativeComponentId(component)}.target`)?.k).toBe("el");
		h.event({ ev: "action", sf, id: `${nativeComponentId(component)}.target`, act: "inspect" });
		expect(component.events.at(-1)).toMatchObject({ type: "action", key: "target" });
		expect(h.errors).toEqual([]);
	});

	it("coalesces credit-blocked sheet updates and sends the final sheet before its dependent frame", async () => {
		const component = new Styled();
		harness = await TspHarness.start(tui => tui.addChild(component), {
			features: ["styles"],
			credits: 1,
			autoAck: false,
		});
		const h = harness;
		const logged = h.terminal.log.length;
		component.current = {
			...el("div", { text: "intermediate" }),
			styles: [{ name: MAIN.name, css: ".unused { color: green }" }],
		};
		await h.render();
		component.current = { ...el("div", { text: "final" }), styles: [UPDATED] };
		await h.render();
		expect(h.terminal.log).toHaveLength(logged);
		h.terminal.ackAll();
		h.flush();
		expect(h.terminal.log.slice(logged).map(message => message.verb)).toEqual(["s", "f"]);
		expect(sheets(h).at(-1)).toEqual({ sf: h.terminal.surface!, ...UPDATED });
		expect(h.byId(nativeComponentId(component))).toMatchObject({ k: "el", p: { tag: "div", text: "final" } });
		expect(h.errors).toEqual([]);
	});

	it("routes keyed element actions and form changes without losing form values or control state", async () => {
		const component = new Styled();
		component.current = {
			...el("form", undefined, [
				el("input", { type: "checkbox", name: "enabled", checked: false }, undefined, "enabled"),
				el("button", { text: "Apply", actions: { click: "apply" } }, undefined, "apply"),
			]),
			styles: [MAIN],
		};
		harness = await TspHarness.start(tui => tui.addChild(component), { features: ["styles"] });
		const h = harness;
		const sf = h.terminal.surface!;
		const id = nativeComponentId(component);
		h.event({
			ev: "change",
			sf,
			id: `${id}.enabled`,
			name: "enabled",
			value: "on",
			checked: true,
			values: { enabled: true },
		});
		h.event({ ev: "action", sf, id: `${id}.apply`, act: "apply", values: { enabled: true } });
		expect(component.events).toEqual([
			{
				type: "change",
				key: "enabled",
				item: "",
				name: "enabled",
				value: "on",
				checked: true,
				values: { enabled: true },
			},
			{ type: "action", key: "apply", act: "apply", value: undefined, mods: [], values: { enabled: true } },
		]);
		component.current = { ...el("form", { text: "Updated" }, component.current.c), styles: [MAIN] };
		await h.render();
		expect(h.byId(id)).toMatchObject({ k: "el", p: { tag: "form", text: "Updated" } });
		expect(h.byId(`${id}.enabled`)).toMatchObject({ k: "el", p: { tag: "input", checked: false } });
		expect(h.errors).toEqual([]);
	});

	it("preserves declarations through visibility helpers and rejects invalid names or excess UTF-8 CSS", async () => {
		const component = new Styled();
		const full: NativeStylesheet = { name: "full", css: "é".repeat(128 * 1024) };
		const invalid: readonly NativeStylesheet[] = [
			{ name: "bad.name", css: "x{}" },
			{ name: "x".repeat(65), css: "x{}" },
			{ name: "overflow", css: "x" },
		];
		component.current = withHidden({ ...el("div"), styles: [full, ...invalid] }, true);
		harness = await TspHarness.start(tui => tui.addChild(component), { features: ["styles"], apc: 4096 });
		expect(sheets(harness)).toEqual([{ sf: harness.terminal.surface!, ...full }]);
		expect(harness.byId(nativeComponentId(component))).toMatchObject({ k: "el", p: { tag: "div", hidden: true } });
		await harness.render();
		expect(sheets(harness)).toHaveLength(1);
		expect(harness.errors).toEqual([]);
	});
});
