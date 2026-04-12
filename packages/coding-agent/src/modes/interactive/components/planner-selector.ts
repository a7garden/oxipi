import type { Model } from "@oxipi/ai";
import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, Text, type TUI } from "@oxipi/tui";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

interface PlannerItem {
	provider: string;
	id: string;
	model: Model<any>;
}

/**
 * Component that renders a planner model selector with search
 */
export class PlannerSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: PlannerItem[] = [];
	private filteredModels: PlannerItem[] = [];
	private selectedIndex: number = 0;
	private currentPlanner?: string;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (modelId: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;

	constructor(
		tui: TUI,
		currentPlanner: string | undefined,
		modelRegistry: ModelRegistry,
		onSelect: (modelId: string) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.currentPlanner = currentPlanner;
		this.modelRegistry = modelRegistry;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.addChild(new Text(theme.bold("Select Planner Model"), 0, 0));
		this.addChild(new Spacer(1));

		// Add hint
		const hintText = "Only showing models with configured API keys";
		this.addChild(new Text(theme.fg("dim", hintText), 0, 0));
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex]);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			if (initialSearchInput) {
				this.filterModels(initialSearchInput);
			} else {
				this.updateList();
			}
			this.tui.requestRender();
		});
	}

	private async loadModels(): Promise<void> {
		this.modelRegistry.refresh();

		try {
			const availableModels = await this.modelRegistry.getAvailable();
			this.allModels = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
			this.allModels.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
		} catch {
			this.allModels = [];
		}

		this.filteredModels = this.allModels;
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.allModels, query, ({ id, provider }) => `${id} ${provider} ${provider}/${id}`)
			: this.allModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const modelId = `${item.provider}/${item.id}`;
			const isCurrent = this.currentPlanner === modelId;

			let line: string;
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = item.id;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${prefix + theme.fg("accent", modelText)} ${providerBadge}${checkmark}`;
			} else {
				const modelText = `  ${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${modelText} ${providerBadge}${checkmark}`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}
	}

	private handleSelect(item: PlannerItem): void {
		const modelId = `${item.provider}/${item.id}`;
		this.onSelectCallback(modelId);
		this.onCancelCallback();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel);
			}
		}
		// Escape
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}
}
