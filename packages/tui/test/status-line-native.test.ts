import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, removeSyncWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import type { TspProps } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { StatusLineComponent } from "../src/status-line/component";
import { describeSegment, type SegmentContext } from "../src/status-line/segments";
import { createStartupStatusLine } from "../src/status-line/startup";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
});

function statusLine(settings: StatusLineSettings, gitEnabled = false): StatusLineComponent {
	return createStartupStatusLine({
		settings,
		gitEnabled,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
}

function isNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && "k" in child;
}

/** The `seg` facts of the composer's extras, in order. */
function facts(line: StatusLineComponent): { key: string; props: TspProps<"seg"> }[] {
	const extras = line.describeComposerFacts().extras;
	expect(extras.k).toBe("status");
	return (extras.c ?? [])
		.filter(isNode)
		.flatMap(child =>
			child.k === "seg" && child.key !== undefined ? [{ key: child.key, props: child.p ?? {} }] : [],
		);
}

describe("native composer facts", () => {
	it("keeps the configured segments without another home, outer edges dropping last", () => {
		setNativeRendering(true);
		const segs = facts(
			statusLine({
				preset: "custom",
				leftSegments: ["hostname", "path", "session", "model"],
				rightSegments: ["session_name", "time", "context_pct", "cost"],
			}),
		);

		// Path goes to Tern's pane header, the session name to the tab title, the
		// model to its chip, context and cost to the hairline and usage text.
		expect(segs.map(seg => seg.key)).toEqual(["hostname", "session", "time"]);
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.hostname!).toBeGreaterThan(priority.session!);
	});

	it("reorders priorities when the configured order changes", () => {
		setNativeRendering(true);
		const segs = facts(statusLine({ preset: "custom", leftSegments: ["session", "hostname"], rightSegments: [] }));
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.session!).toBeGreaterThan(priority.hostname!);
	});

	it("keeps the git branch by the model chip, outlasting the other facts and opening /git", () => {
		setNativeRendering(true);
		const originalProjectDir = getProjectDir();
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-composer-git-"));
		try {
			// The repository's on-disk shape, written without invoking git (no hooks, signing or user config).
			const gitDir = path.join(repo, ".git");
			for (const dir of ["objects", path.join("refs", "heads")])
				fs.mkdirSync(path.join(gitDir, dir), { recursive: true });
			fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/parity\n");
			fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
			setProjectDir(repo);

			const segs = facts(
				statusLine(
					{ preset: "custom", leftSegments: ["hostname", "model", "path", "git"], rightSegments: [] },
					true,
				),
			);
			expect(segs.map(seg => seg.key)).toEqual(["hostname", "git"]);
			const [hostname, branch] = segs;
			expect(branch!.props).toMatchObject({
				icon: "branch",
				spans: [{ t: "feature/parity", s: "statusLineGitClean" }],
				actions: { click: "status.git" },
			});
			expect(branch!.props.priority!).toBeGreaterThan(hostname!.props.priority!);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(repo);
		}
	});

	it("spaces the git counts apart from the branch and each other", () => {
		const text = (branch: string | null, showBranch = true) =>
			describeSegment("git", {
				git: { branch, status: { staged: 2, unstaged: 3, untracked: 1 }, pr: null },
				options: { git: { showBranch } },
			} as unknown as SegmentContext)
				?.spans.map(part => part.t)
				.join("");
		expect(text("main")).toBe("main *3 +2 ?1");
		expect(text("main", false)).toBe("*3 +2 ?1");
	});

	it("describes spans without ANSI escapes or separator glyphs", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "full", separator: "powerline" });
		const json = JSON.stringify(line.describeComposerFacts());
		expect(json).not.toContain("\\u001b");
		for (const glyph of ["\ue0b0", "\ue0b2", "\ue0b1", "\ue0b3", "─", "│"]) expect(json).not.toContain(glyph);
		expect(facts(line).length).toBeGreaterThan(0);
	});

	it("returns the same facts while nothing changed and new ones after a change", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "custom", leftSegments: ["path", "mode"], rightSegments: [] });
		const first = line.describeComposerFacts();
		expect(line.describeComposerFacts()).toBe(first);

		line.setPlanModeStatus({ enabled: true, paused: false });
		expect(line.describeComposerFacts()).not.toBe(first);
		expect(facts(line).map(seg => seg.key)).toEqual(["mode"]);
	});
});

/** Flatten semantic children so assertions exercise the actual composer tree. */
function descendants(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).filter(isNode).flatMap(descendants)];
}

describe("native extension statuses", () => {
	it("preserves arbitrary fractional progress and invalidates unchanged fallback text", () => {
		const line = statusLine({ preset: "custom", leftSegments: [], rightSegments: [] });
		line.setHookStatus("index", "◔ Indexing", { label: "Indexing", progress: 0.37, tone: "info" });
		const first = line.describeComposerFacts();
		const firstMeter = descendants(first.extras).find(child => child.k === "meter");
		expect(firstMeter).toMatchObject({ p: { style: "ring", size: "sm", value: 0.37, tone: "info" } });
		expect(JSON.stringify(first.extras)).not.toContain("◔");
		line.setHookStatus("index", "◔ Indexing", { label: "Indexing", progress: 0.731, tone: "info" });
		const second = line.describeComposerFacts();
		expect(second).not.toBe(first);
		expect(descendants(second.extras).find(child => child.k === "meter")).toMatchObject({
			p: { value: 0.731, title: "Indexing — 73.1%" },
		});
		expect(descendants(second.extras).filter(child => child.k === "seg")).toHaveLength(1);
	});

	it("reuses one leading mark footprint for unknown progress and errors, then removes metadata", () => {
		const line = statusLine({ preset: "custom", leftSegments: ["status"], rightSegments: [] });
		line.setHookStatus("index", "Working", {
			label: "Index",
			progress: null,
			icon: "warning",
			title: "Waiting for totals",
		});
		const unknown = descendants(line.describeComposerFacts().extras);
		const meter = unknown.find(child => child.k === "meter");
		expect(meter).toMatchObject({ p: { style: "ring", value: null, title: "Waiting for totals" } });
		expect(unknown.some(child => child.k === "icon")).toBe(false);
		line.setHookStatus("index", "Unavailable", {
			label: "Index",
			icon: "warning",
			tone: "error",
			title: "Index unavailable",
		});
		const failed = descendants(line.describeComposerFacts().extras);
		expect(failed.some(child => child.k === "meter")).toBe(false);
		const icon = failed.find(child => child.k === "icon");
		expect(icon).toMatchObject({ p: { name: "warning", tone: "error", min: meter?.p?.min, max: meter?.p?.max } });
		line.setHookStatus("index", "Regular status");
		const plain = descendants(line.describeComposerFacts().extras);
		expect(plain.some(child => child.k === "meter" || child.k === "icon")).toBe(false);
		expect(plain.find(child => child.k === "seg")).toMatchObject({
			p: { spans: [{ t: "Regular status" }], title: "Regular status" },
		});
		line.setHookStatus("index", undefined);
		expect(descendants(line.describeComposerFacts().extras).filter(child => child.k === "seg")).toHaveLength(0);
	});

	it("activates only the current callback and removes stale actions on update and clear", () => {
		const line = statusLine({ preset: "custom", leftSegments: [], rightSegments: [] });
		let opened = 0;
		line.setHookStatus("index", "Index", {
			onActivate: () => {
				opened++;
			},
		});
		const action = facts(line)[0]!.props.actions!.click!;
		line.handleNativeEvent({ type: "action", key: "", act: action, mods: [] });
		expect(opened).toBe(1);
		line.setHookStatus("index", "Index", { progress: 0.37 });
		line.handleNativeEvent({ type: "action", key: "", act: action, mods: [] });
		expect(opened).toBe(1);
		expect(facts(line)[0]!.props.actions).toBeUndefined();
		line.setHookStatus("index", "Index", {
			onActivate: () => {
				opened++;
			},
		});
		const next = facts(line)[0]!.props.actions!.click!;
		line.setHookStatus("index", undefined);
		line.handleNativeEvent({ type: "action", key: "", act: next, mods: [] });
		expect(opened).toBe(1);
	});

	it("preserves text fallback and respects standalone-hook and configured-segment visibility", () => {
		const line = statusLine({ preset: "custom", leftSegments: [], rightSegments: [], showHookStatus: false });
		line.setHookStatus("index", "◔ Indexing 37%", { label: "Indexing", progress: 0.37 });
		expect(facts(line)).toHaveLength(0);
		expect(line.render(100)).toEqual([]);
		const configured = statusLine({
			preset: "custom",
			leftSegments: ["status"],
			rightSegments: [],
			showHookStatus: false,
		});
		configured.setHookStatus("index", "◔ Indexing 37%", { label: "Indexing", progress: 0.37 });
		expect(descendants(configured.describeComposerFacts().extras).some(child => child.k === "meter")).toBe(true);
		expect(configured.renderBottomBar(100, "full")).toContain("◔ Indexing 37%");
		const visible = statusLine({ preset: "custom", leftSegments: [], rightSegments: [] });
		visible.setHookStatus("index", "◔ Indexing 37%", { label: "Indexing", progress: 0.37 });
		expect(visible.render(100)).toEqual(["◔ Indexing 37%"]);
		expect(descendants(configured.describePreview()).filter(child => child.k === "meter")).toHaveLength(1);
	});

	it("forwards reduced motion into status facts before using the native memo", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "custom", leftSegments: [], rightSegments: [] });
		try {
			line.setHookStatus("index", "Index", {
				label: "Index",
				progress: 0.37,
				progressMotion: "brief",
				tone: "accent",
			});
			const first = line.describeComposerFacts({ reduceMotion: true });
			expect(descendants(first.extras).find(child => child.k === "meter")).toMatchObject({
				p: { value: 0.37, tone: "muted" },
			});
			expect(line.describeComposerFacts({ reduceMotion: true })).toBe(first);
			line.setHookStatus("index", "Index", {
				label: "Index",
				progress: 0.73,
				progressMotion: "brief",
				tone: "accent",
			});
			const next = line.describeComposerFacts({ reduceMotion: true });
			expect(descendants(next.extras).find(child => child.k === "meter")).toMatchObject({
				p: { value: 0.73, tone: "muted" },
			});
		} finally {
			line.dispose();
		}
	});
});
