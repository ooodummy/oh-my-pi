import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { XdevMountedRenderer, XdevMountedState } from "@oh-my-pi/pi-tui/tools/xdev";
import type { Component } from "../src/tui";
import { node, text } from "../src/native/describe";
import type { DescribeContext, NativeChild } from "../src/native/node";
import type { ToolRendererFactory } from "../src/tools/renderer";

/**
 * A `write xd://<tool>` card renders with the dispatched tool's own renderer,
 * while streaming (call branch) and once the result lands, for mounted devices
 * and active top-level tools alike. The TUI forwards the host's canonical
 * resolver (`XdevMountedState.resolve`, wired to `resolveXdevTool`) and must
 * not gate it on `mountedNames` itself: that second predicate is what left a
 * dispatched top-level tool on the generic args/output card.
 */

const ui = () => ({
	requestRender: vi.fn(),
	requestComponentRender: vi.fn(),
	resetDisplay: vi.fn(),
});

const probeTool: XdevMountedRenderer = {
	label: "Probe",
	mergeCallAndResult: true,
	renderCall: () => new Text("PROBE-CALL", 0, 0),
	renderResult: () => new Text("PROBE-RESULT", 0, 0),
};

function writeToolWithXdev(xdev: XdevMountedState): AgentTool {
	return { name: "write", label: "Write", session: { xdev } } as unknown as AgentTool;
}

/** `mountedNames` stays empty on purpose: the host resolver is the only authority. */
function xdevState(resolve: XdevMountedState["resolve"]): XdevMountedState {
	return {
		mountedNames: new Set<string>(),
		tools: new Map<string, XdevMountedRenderer>([["probe", probeTool]]),
		resolve,
	};
}

const dispatchResult = {
	content: [{ type: "text" as const, text: "42" }],
	details: {
		xdev: {
			tool: "probe",
			mode: "execute" as const,
			args: { command: "Write-Output 42" },
			inner: { output: "42" },
		},
	},
};

function deviceWrite(resolve: XdevMountedState["resolve"]): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"write",
		{ path: "xd://probe", content: JSON.stringify({ command: "Write-Output 42" }) },
		{ useBuiltInRenderer: true },
		writeToolWithXdev(xdevState(resolve)),
		ui(),
	);
	component.setExecutionStarted();
	return component;
}

describe("write xd:// device card renderer resolution", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the dispatched tool's card while streaming and after the result", () => {
		const component = deviceWrite(() => probeTool);
		expect(component.render(80).join("\n")).toContain("PROBE-CALL");

		component.updateResult(dispatchResult, false);
		expect(component.render(80).join("\n")).toContain("PROBE-RESULT");
	});

	it("falls back to the generic card when the host resolver returns nothing", () => {
		const component = deviceWrite(() => undefined);
		expect(component.render(80).join("\n")).not.toContain("PROBE-CALL");

		component.updateResult(dispatchResult, false);
		const rendered = component.render(80).join("\n");
		expect(rendered).not.toContain("PROBE-RESULT");
		expect(rendered).toContain("42");
	});
});

const nativeContext: DescribeContext = {
	cols: 80,
	reduceMotion: false,
	dark: true,
	supports: kind => kind === "tool",
	feature: () => false,
};

function nativeText(child: NativeChild): string {
	if ("render" in child)
		return nativeText(child.describe?.(nativeContext) ?? node("rows", { cols: 80, lines: [...child.render(80)] }));
	return JSON.stringify(child.p ?? {}) + (child.c ?? []).map(nativeText).join("\n");
}

describe("extension presentation in original tool cards", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps selection per card, preserves native events, and repaints the same body boundary", () => {
		const host = ui();
		const factory = vi.fn<ToolRendererFactory>(({ requestRender, fallback }) => {
			let selected = "first";
			const body: Component = {
				render: () => [selected],
				describe: () => text(selected),
				handleNativeEvent: event => {
					if (event.type === "select") {
						selected = event.item;
						requestRender();
					}
				},
			};
			return { ...fallback, mergeCallAndResult: true, describeResult: () => ({ body: [body] }) };
		});
		const options = { getToolRenderer: () => factory, useBuiltInRenderer: false };
		const first = new ToolExecutionComponent("probe", {}, options, undefined, host);
		const second = new ToolExecutionComponent("probe", {}, options, undefined, host);
		for (const card of [first, second]) {
			card.setExecutionStarted();
			card.updateResult({ content: [{ type: "text", text: "original" }] }, true);
		}
		const before = first.describe(nativeContext);
		const body = before.c?.[0] as Component;
		body.handleNativeEvent?.({ type: "select", key: "", item: "second" });
		const after = first.describe(nativeContext);
		expect(after).not.toBe(before);
		expect(after.c?.[0]).toBe(body);
		expect(nativeText(after)).toContain("second");
		expect(nativeText(second.describe(nativeContext))).toContain("first");
		expect(after.p).toMatchObject({ status: "running", collapsed: true });
		expect(after.p).toHaveProperty("age");
		first.updateResult({ content: [{ type: "text", text: "original" }] }, false);
		expect(first.describe(nativeContext).p).toMatchObject({ status: "done" });
		expect(first.describe(nativeContext).p).toHaveProperty("took");
		second.seal();
		expect(second.describe(nativeContext).p).toMatchObject({ status: "cancelled" });
		expect(factory).toHaveBeenCalledTimes(2);
		expect(host.requestComponentRender).toHaveBeenCalledWith(first);
	});

	it("gives factories the original bound MCP views for ANSI, errors and full expansion", () => {
		const original = {
			name: "probe",
			label: "Original",
			mergeCallAndResult: true,
			renderCall() {
				return new Text(`${this.label}-CALL`, 0, 0);
			},
			renderResult() {
				return new Text(`${this.label}-RESULT`, 0, 0);
			},
			describeResult() {
				return { body: [text(`${this.label}-RESULT`)] };
			},
		};
		const factory: ToolRendererFactory = ({ fallback }) => ({
			...fallback,
			describeResult(result, options, args) {
				return options.expanded || result.isError
					? fallback.describeResult?.(result, options, args)
					: { body: [text("CUSTOM")] };
			},
		});
		const card = new ToolExecutionComponent(
			"probe",
			{},
			{ getToolRenderer: () => factory },
			original as unknown as AgentTool,
			ui(),
		);
		card.updateResult({ content: [{ type: "text", text: "unchanged" }] }, false);
		expect(nativeText(card.describe(nativeContext))).toContain("CUSTOM");
		expect(card.render(80).join("\n")).toContain("Original-RESULT");
		card.setExpanded(true);
		expect(nativeText(card.describe(nativeContext))).toContain("Original-RESULT");
		card.setExpanded(false);
		card.updateResult({ content: [{ type: "text", text: "unchanged" }], isError: true }, false);
		expect(nativeText(card.describe(nativeContext))).toContain("Original-RESULT");
		expect(card.describe(nativeContext).p).toMatchObject({ status: "error" });
	});

	it("retains native output when factories, describe hooks, or child components fail", () => {
		const factories: ToolRendererFactory[] = [
			() => ({}) as never,
			() => {
				throw new Error("factory");
			},
			({ fallback }) => ({
				...fallback,
				describeResult: () => {
					throw new Error("describe");
				},
			}),
			({ fallback }) => ({
				...fallback,
				describeResult: () => ({
					body: [
						{
							render: () => {
								throw new Error("rows");
							},
						},
					],
				}),
			}),
			({ fallback }) => ({ ...fallback, describeResult: () => undefined }),
			({ fallback }) => ({
				...fallback,
				describeResult: () => ({
					body: [
						{
							render: () => {
								throw new Error("render");
							},
							describe: () => {
								throw new Error("component");
							},
						},
					],
				}),
			}),
		];
		for (const factory of factories) {
			const card = new ToolExecutionComponent("probe", {}, { getToolRenderer: () => factory }, undefined, ui());
			card.updateResult({ content: [{ type: "text", text: "ORIGINAL-OUTPUT" }] }, false);
			expect(nativeText(card.describe(nativeContext))).toContain("ORIGINAL-OUTPUT");
		}
	});

	it("overrides xd presentation only after canonical resolution and forwards original inner metadata", () => {
		const seen: unknown[] = [];
		const originalRenderResult = probeTool.renderResult;
		const factory = vi.fn<ToolRendererFactory>(({ fallback }) => ({
			...fallback,
			mergeCallAndResult: true,
			renderResult: () => {
				throw new Error("ANSI");
			},
			describeResult(result, _options, args) {
				seen.push({ result, args });
				return { body: [text("CUSTOM-XD")] };
			},
		}));
		const resolvedNames: string[] = [];
		const original = writeToolWithXdev(
			xdevState(name => {
				resolvedNames.push(name);
				return name === "probe" ? probeTool : undefined;
			}),
		);
		const getToolRenderer = (name: string) => (name === "probe" ? factory : undefined);
		const card = new ToolExecutionComponent(
			"write",
			{ path: "xd://probe", content: '{"command":"Write-Output 42"}' },
			{ getToolRenderer },
			original,
			ui(),
		);
		card.setExecutionStarted();
		card.updateResult(dispatchResult, false);
		expect(nativeText(card.describe(nativeContext))).toContain("CUSTOM-XD");
		expect(card.render(80).join("\n")).toContain("PROBE-RESULT");
		expect(seen).toEqual([
			{
				result: { content: dispatchResult.content, details: dispatchResult.details.xdev.inner, isError: undefined },
				args: dispatchResult.details.xdev.args,
			},
		]);
		expect(resolvedNames.every(name => name === "probe")).toBe(true);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(probeTool.renderResult).toBe(originalRenderResult);

		const unresolved = new ToolExecutionComponent(
			"write",
			{ path: "xd://probe", content: "{}" },
			{ getToolRenderer },
			writeToolWithXdev(xdevState(() => undefined)),
			ui(),
		);
		unresolved.updateResult(dispatchResult, false);
		expect(nativeText(unresolved.describe(nativeContext))).not.toContain("CUSTOM-XD");
		expect(factory).toHaveBeenCalledTimes(1);
	});
});
