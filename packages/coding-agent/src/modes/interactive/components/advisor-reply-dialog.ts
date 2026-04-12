import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@oxipi/tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

export class AdvisorReplyDialogComponent extends Container implements Focusable {
	private input: Input;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TUI,
		readonly correlationId: string,
		subAgentId: string,
		question: string,
		context: string | undefined,
		onSubmitReply: (reply: string) => void,
		private readonly onCancelReply: () => void,
	) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", `Sub-agent question (${subAgentId})`), 1, 0));
		this.addChild(new Text(theme.fg("muted", `correlationId: ${correlationId}`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("text", question), 1, 0));
		if (context?.trim()) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", `Context: ${context}`), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", "Reply:"), 1, 0));
		this.input = new Input();
		this.input.onSubmit = () => {
			const reply = this.input.getValue().trim();
			if (!reply) return;
			onSubmitReply(reply);
		};
		this.input.onEscape = () => onCancelReply();
		this.addChild(this.input);
		this.addChild(
			new Text(`(${keyHint("tui.select.cancel", "cancel")} ${keyHint("tui.select.confirm", "submit")})`, 1, 0),
		);
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelReply();
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}
}
