import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type BtwPanelState = "running" | "complete" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	historyCount?: number;
	modelLabel?: string;
}

export class BtwPanelComponent extends Container {
	#question: string;
	#tui: TUI;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#closed = false;
	#historyCount: number;
	#modelLabel: string | undefined;

	constructor(options: BtwPanelComponentOptions) {
		super();
		this.#question = options.question;
		this.#tui = options.tui;
		this.#historyCount = options.historyCount ?? 0;
		this.#modelLabel = options.modelLabel;
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#rebuild();
	}

	markComplete(historyCount?: number): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		if (historyCount !== undefined) {
			this.#historyCount = historyCount;
		}
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#rebuild();
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.#headerLine(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#contentComponent());
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.#footerLine(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.#tui.requestRender();
	}

	#headerLine(): string {
		const q = theme.fg("accent", replaceTabs(this.#question));
		if (this.#modelLabel) {
			return `${q} ${theme.fg("dim", `[${this.#modelLabel}]`)}`;
		}
		return q;
	}

	#footerLine(): string {
		const historyHint =
			this.#historyCount > 0 ? `${this.#historyCount} prior exchange${this.#historyCount === 1 ? "" : "s"} · ` : "";
		switch (this.#state) {
			case "running":
				return theme.fg("muted", `${historyHint}Esc cancel /btw`);
			case "complete":
				if (this.#historyCount > 0) {
					return theme.fg("muted", `${historyHint}/btw:handoff to inject · Esc dismiss`);
				}
				return theme.fg("muted", "Esc dismiss");
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · Esc dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Esc dismiss`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", replaceTabs(this.#errorMessage ?? "Unknown error")), 1, 0);
		}
		const text = replaceTabs(this.#answer).trim();
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return new Text(theme.fg("dim", waiting), 1, 0);
		}
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
}
