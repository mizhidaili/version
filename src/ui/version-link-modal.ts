import {
	App,
	Editor,
	FuzzyMatch,
	FuzzySuggestModal,
	TFile,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import {
	getOverallVersion,
	VersionFile,
	VersionGroup,
	VersionIndex,
} from '../version-index';
import { VersionHoverPreview } from './hover-preview';

export interface VersionLinkChoice {
	alias: string;
	file: TFile;
	label: string;
	versionFile: VersionFile;
}

export interface VersionChoiceOptions {
	includeOverall?: boolean;
	placeholder?: string;
	versionFilter?: (versionFile: VersionFile) => boolean;
}

export class VersionLinkModal extends FuzzySuggestModal<VersionGroup> {
	private hoverPreview: VersionHoverPreview | null = null;

	constructor(
		app: App,
		private readonly index: VersionIndex,
		private readonly editor: Editor,
		private readonly sourceFile: TFile,
		private readonly i18n: VersionI18n,
	) {
		super(app);
		this.setPlaceholder(this.i18n.t('link.chooseTheme'));
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.modalEl.addClass('version-theme-picker-modal');
		const parent = this.resultContainerEl.parentElement;
		if (!parent) {
			return;
		}
		parent.addClass('version-theme-picker-layout');
		this.resultContainerEl.addClass('version-theme-picker-choices');
		this.hoverPreview = new VersionHoverPreview(
			this.app,
			this.modalEl.ownerDocument,
			this.i18n,
		);
	}

	onClose(): void {
		this.hoverPreview?.destroy();
		this.hoverPreview = null;
		super.onClose();
	}

	getItems(): VersionGroup[] {
		return this.index.getGroups();
	}

	getItemText(group: VersionGroup): string {
		return group.folder ? `${group.topic} ${group.folder}` : group.topic;
	}

	renderSuggestion(match: FuzzyMatch<VersionGroup>, el: HTMLElement): void {
		const nameEl = renderThemeSuggestion(match.item, el);
		nameEl.addEventListener('pointerenter', (event) => {
			this.scheduleGroupPreview(match.item, nameEl, event);
		});
		nameEl.addEventListener('pointerleave', () =>
			this.hoverPreview?.scheduleHide());
	}

	onChooseItem(group: VersionGroup): void {
		new VersionChoiceModal(
			this.app,
			group,
			(choice) => {
				const link = this.app.fileManager.generateMarkdownLink(
					choice.file,
					this.sourceFile.path,
					undefined,
					choice.alias,
				);
				this.editor.replaceSelection(link);
			},
			this.i18n,
		).open();
	}

	private scheduleGroupPreview(
		group: VersionGroup,
		anchorEl: HTMLElement,
		event: PointerEvent,
	): void {
		const v1 = getOverallVersion(group);
		if (v1) {
			this.hoverPreview?.scheduleFile(v1.file, anchorEl, group.topic, event);
		}
	}
}

export class VersionChoiceModal extends FuzzySuggestModal<VersionLinkChoice> {
	private hoverPreview: VersionHoverPreview | null = null;

	constructor(
		app: App,
		private readonly group: VersionGroup,
		private readonly onChoose: (choice: VersionLinkChoice) => void,
		private readonly i18n: VersionI18n,
		private readonly options: VersionChoiceOptions = {},
	) {
		super(app);
		this.setPlaceholder(
			options.placeholder ??
				this.i18n.t('link.chooseVersion', {
					topic: group.topic,
				}),
		);
		this.emptyStateText = this.i18n.t('link.noVersions');
		this.limit = Number.POSITIVE_INFINITY;
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.modalEl.addClass('version-link-picker-modal');

		const resultsParent = this.resultContainerEl.parentElement;
		if (resultsParent) {
			resultsParent.addClass('version-link-picker-layout');
			this.resultContainerEl.addClass('version-link-picker-choices');
			this.hoverPreview = new VersionHoverPreview(
				this.app,
				this.modalEl.ownerDocument,
				this.i18n,
			);
		}
	}

	onClose(): void {
		this.hoverPreview?.destroy();
		this.hoverPreview = null;
		super.onClose();
	}

	getItems(): VersionLinkChoice[] {
		const choices: VersionLinkChoice[] = [];
		const overall = getOverallVersion(this.group);

		if (overall && this.options.includeOverall !== false) {
			choices.push({
				alias: this.group.topic,
				file: overall.file,
				label: this.i18n.t('link.overall'),
				versionFile: overall,
			});
		}

		for (const versionFile of this.group.versions) {
			if (this.options.versionFilter && !this.options.versionFilter(versionFile)) {
				continue;
			}
			choices.push({
				alias: this.i18n.t('link.versionAlias', {
					topic: this.group.topic,
					version: versionFile.version,
				}),
				file: versionFile.file,
				label: this.i18n.t('link.version', {
					version: versionFile.version,
				}),
				versionFile,
			});
		}

		return choices;
	}

	getItemText(choice: VersionLinkChoice): string {
		return choice.label;
	}

	renderSuggestion(
		match: FuzzyMatch<VersionLinkChoice>,
		el: HTMLElement,
	): void {
		const titleEl = el.createDiv({
			cls: 'version-link-choice-title',
			text: match.item.label,
		});
		titleEl.addEventListener('pointerenter', (event) => {
			this.hoverPreview?.scheduleFile(
				match.item.versionFile.file,
				titleEl,
				`V${match.item.versionFile.version} · ${match.item.versionFile.file.basename}`,
				event,
			);
		});
		titleEl.addEventListener('pointerleave', () =>
			this.hoverPreview?.scheduleHide());
	}

	onChooseItem(choice: VersionLinkChoice): void {
		this.onChoose(choice);
	}

}

export function renderThemeSuggestion(
	group: VersionGroup,
	el: HTMLElement,
): HTMLElement {
	const row = el.createDiv({ cls: 'version-theme-suggestion-row' });
	const nameEl = row.createDiv({
		cls: 'version-theme-suggestion-name',
		text: group.topic,
	});
	row.createSpan({
		cls: 'version-count-badge',
		text: String(group.versions.length),
	});
	return nameEl;
}
