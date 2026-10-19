import { afterEach, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { defaultEditorTheme } from "../test-themes";
import { TspHarness } from "./tsp-harness";

/** A settings page that docks beside the transcript (`/settings` in Tern) or, with `sheet` off, a modal panel. */
class Panel implements Component {
	readonly keys: string[] = [];
	constructor(readonly sheet: boolean) {}
	render(): string[] {
		return ["panel"];
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	invalidate(): void {}
	nativeSheet(): boolean {
		return this.sheet;
	}
	describe(): NativeNode {
		return node("prefs", { title: "Settings", pages: [{ id: "a", label: "A" }], page: "a", sections: [] });
	}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

async function open(
	sheet: boolean,
): Promise<{ h: TspHarness; editor: Editor; panel: Panel; sf: string; editorId: string }> {
	const editor = new Editor(defaultEditorTheme);
	const panel = new Panel(sheet);
	harness = await TspHarness.start(tui => {
		tui.addChild(editor);
		tui.setFocus(editor);
	});
	const h = harness;
	const sf = h.terminal.surface!;
	const editorId = h.find(n => n.k === "editor")!.id;
	h.tui.showOverlay(panel, { fullscreen: true, width: "100%", maxHeight: "100%" });
	await h.render();
	expect(h.tui.getFocused()).toBe(panel);
	return { h, editor, panel, sf, editorId };
}

function focusOf(h: TspHarness, sf: string): string | null {
	return h.terminal.docs.get(sf)!.focus;
}

describe("TSP focus event", () => {
	it("keeps passive popup actions live without moving composer focus or making the wrapper modal", async () => {
		const editor = new Editor(defaultEditorTheme);
		const events: NativeUiEvent[] = [],
			keys: string[] = [];
		const popup: Component = {
			render: () => ["popup"],
			describe: () =>
				node("text", { text: "Refresh popup", actions: { click: "refresh" }, role: "passive-control" }),
			handleNativeEvent: event => {
				events.push(event);
			},
			handleInput: data => {
				keys.push(data);
			},
		};
		harness = await TspHarness.start(tui => {
			tui.addChild(editor);
			tui.setFocus(editor);
		});
		const h = harness,
			sf = h.terminal.surface!,
			editorId = h.find(n => n.k === "editor")!.id;
		const handle = h.tui.showOverlay(popup, { nonModal: true, anchor: "top-center", width: 44 });
		await h.render();
		const control = h.find(n => n.p?.role === "passive-control")!;
		const wrapper = h.find(n => n.k === "overlay");
		if (wrapper?.k !== "overlay") throw new Error("Missing passive popup");
		expect(wrapper.p?.modal).toBe(false);
		expect(h.tui.getFocused()).toBe(editor);
		expect(focusOf(h, sf)).toBe(editorId);
		h.event({ ev: "focus", sf, id: control.id });
		h.event({ ev: "action", sf, id: control.id, act: "refresh", mods: [] });
		h.terminal.send("draft");
		h.flush();
		expect(events).toEqual([{ type: "action", key: "", act: "refresh", mods: [] }]);
		expect(keys).toEqual([]);
		expect(editor.getText()).toBe("draft");
		expect(h.tui.getFocused()).toBe(editor);
		handle.setHidden(true);
		handle.setHidden(false);
		await h.render();
		expect(focusOf(h, sf)).toBe(editorId);
		handle.hide();
		await h.render();
		expect(h.tui.getFocused()).toBe(editor);
		expect(h.find(n => n.k === "overlay")).toBeUndefined();
		h.tui.showOverlay(popup, { nonModal: true, fullscreen: true });
		await h.render();
		expect(h.tui.getFocused()).toBe(popup);
	});
	it("moves the keys between the composer and a settings sheet beside it", async () => {
		const { h, editor, panel, sf, editorId } = await open(true);
		const prefsId = h.find(n => n.k === "prefs")!.id;

		h.event({ ev: "focus", sf, id: editorId });
		expect(h.tui.getFocused()).toBe(editor);
		expect(focusOf(h, sf)).toBe(editorId);
		h.terminal.send("hi");
		h.flush();
		expect(editor.getText()).toBe("hi");
		expect(panel.keys).toEqual([]);
		// Code refocusing the editor while the sheet is up leaves the keys there.
		h.tui.setFocus(editor);
		expect(h.tui.getFocused()).toBe(editor);

		h.event({ ev: "focus", sf, id: prefsId });
		expect(h.tui.getFocused()).toBe(panel);
		expect(focusOf(h, sf)).toBeNull();
		h.terminal.send("x");
		h.flush();
		expect(panel.keys).toEqual(["x"]);
		expect(editor.getText()).toBe("hi");
	});

	it("leaves the keys with a modal panel", async () => {
		const { h, panel, sf, editorId } = await open(false);
		h.event({ ev: "focus", sf, id: editorId });
		expect(h.tui.getFocused()).toBe(panel);
	});
});
