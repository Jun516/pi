import { Container, isViewportTUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { FullscreenExitOutput } from "../src/core/settings-manager.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const layoutBoundary = new Error("Reached interactive layout setup");

function createStartupContext(showDetails = true) {
	return {
		session: {
			scopedModels: [
				{ model: { id: "model-a" }, thinkingLevel: "high" },
				{ model: { id: "model-b" }, thinkingLevel: undefined },
			],
		},
		keybindings: { getKeys: () => ["alt+m"] },
		headerContainer: new Container(),
		registerSignalHandlers: () => {},
		getChangelogForDisplay: () => undefined,
		shouldShowStartupDetails: () => showDetails,
		renderWidgets: () => {
			throw layoutBoundary;
		},
	};
}

type StartupContext = ReturnType<typeof createStartupContext>;
type StopContext = { renderer: ReturnType<typeof createInteractiveTui>; ui: ReturnType<typeof createInteractiveTui> };
const prototype = InteractiveMode.prototype as unknown as {
	init(this: StartupContext): Promise<void>;
	stopInteractiveTui(this: StopContext, fullscreenExitOutput: FullscreenExitOutput): void;
};

describe("InteractiveMode startup model scope", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.restoreAllMocks());

	// Regression for #11508: startup output must belong to the TUI, not the parent shell.
	it.each(["regular", "fullscreen"] as const)("renders model scope inside the %s renderer", async (tuiMode) => {
		const terminal = new VirtualTerminal(100, 12);
		terminal.write("SHELL_BEFORE\r\n");
		const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
			terminal.write(`${values.join(" ")}\r\n`);
		});
		const context = createStartupContext();
		await expect(prototype.init.call(context)).rejects.toBe(layoutBoundary);
		expect(log).not.toHaveBeenCalled();

		const ui = createInteractiveTui({
			tuiMode,
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		ui.addChild(context.headerContainer);
		if (isViewportTUI(ui)) ui.setLayoutRoot(context.headerContainer);
		ui.start();
		try {
			await terminal.waitForRender();
			const screen = terminal.getViewport().join("\n");
			expect(screen).toContain("Model scope: model-a:high, model-b");
			expect(screen).toContain("Alt+M to cycle");
		} finally {
			prototype.stopInteractiveTui.call({ renderer: ui, ui }, "resume-hint");
		}
		await terminal.flush();
		if (tuiMode === "fullscreen") {
			const shell = terminal.getScrollBuffer().join("\n");
			expect(shell).toContain("SHELL_BEFORE");
			expect(shell).not.toContain("Model scope:");
		}
	});

	it("keeps model scope hidden when startup details are suppressed", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const context = createStartupContext(false);
		await expect(prototype.init.call(context)).rejects.toBe(layoutBoundary);
		expect(log).not.toHaveBeenCalled();
		expect(context.headerContainer.children).toHaveLength(0);
	});

	it("does not add a model-scope notice for an empty scope", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const context = createStartupContext();
		context.session.scopedModels = [];
		await expect(prototype.init.call(context)).rejects.toBe(layoutBoundary);
		expect(log).not.toHaveBeenCalled();
		expect(context.headerContainer.children).toHaveLength(0);
	});
});
