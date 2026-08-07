import {
	App,
	FuzzyMatch,
	FuzzySuggestModal,
	TFile,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import { filterAllowedSeries } from '../series-choice-filter';
import { VersionGroup } from '../version-index';
import { VersionRegistry } from '../version-registry';
import { VersionHoverPreview } from './hover-preview';

type SeriesChoice =
	| { file: TFile | null; kind: 'new' }
	| { group: VersionGroup; kind: 'series'; previewFile: TFile | null };

export class VersionSeriesModal extends FuzzySuggestModal<SeriesChoice> {
	private hoverPreview: VersionHoverPreview | null = null;

	constructor(
		app: App,
		private readonly registry: VersionRegistry,
		private readonly activeFile: TFile | null,
		private readonly openManager: (
			file: TFile | null,
			seriesId: string | null,
		) => void,
		private readonly i18n: VersionI18n,
		private readonly allowCreate = true,
		private readonly allowedSeriesIds: ReadonlySet<string> | null = null,
	) {
		super(app);
		this.setPlaceholder(this.i18n.t('series.search'));
		this.emptyStateText = this.i18n.t('series.empty');
		this.limit = Number.POSITIVE_INFINITY;
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.modalEl.addClass('version-series-picker-modal');
		const parent = this.resultContainerEl.parentElement;
		if (!parent) {
			return;
		}
		parent.addClass('version-series-picker-layout');
		this.resultContainerEl.addClass('version-series-picker-choices');
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

	getItems(): SeriesChoice[] {
		const activeGroup = this.activeFile
			? this.registry.index.getGroupForFile(this.activeFile)
			: null;
		const choices: SeriesChoice[] = [];
		if (this.allowCreate) {
			choices.push({
				file: activeGroup ? null : this.activeFile,
				kind: 'new',
			});
		}
		for (const group of filterAllowedSeries(
			this.registry.index.getAllGroups(),
			this.allowedSeriesIds,
		)) {
			const previewFile =
				group.versions.find((member) => member.version === 1)?.file ??
				group.versions[0]?.file ??
				null;
			choices.push({ group, kind: 'series', previewFile });
		}
		return choices;
	}

	getItemText(choice: SeriesChoice): string {
		if (choice.kind === 'new') {
			return this.i18n.t('series.create');
		}
		return `${choice.group.topic} ${this.statusLabel(choice.group)}`;
	}

	renderSuggestion(match: FuzzyMatch<SeriesChoice>, el: HTMLElement): void {
		const choice = match.item;
		let nameEl: HTMLElement;
		if (choice.kind === 'new') {
			nameEl = el.createDiv({
				cls: 'version-series-choice-name',
				text: this.i18n.t('series.create'),
			});
			el.createDiv({
				cls: 'version-series-choice-detail',
				text: choice.file
					? this.i18n.t('series.createFrom', { name: choice.file.basename })
					: this.i18n.t('series.createEmpty'),
			});
		} else {
			nameEl = el.createDiv({
				cls: 'version-series-choice-name',
				text: choice.group.topic,
			});
			el.createDiv({
				cls: 'version-series-choice-detail',
				text: this.i18n.t('series.summary', {
					count: choice.group.versions.length,
					status: this.statusLabel(choice.group),
				}),
			});
		}
		nameEl.addEventListener('pointerenter', (event) =>
			this.scheduleChoicePreview(choice, nameEl, event));
		nameEl.addEventListener('pointerleave', () =>
			this.hoverPreview?.scheduleHide());
	}

	onChooseItem(choice: SeriesChoice): void {
		if (choice.kind === 'new') {
			this.openManager(choice.file, null);
			return;
		}
		this.openManager(choice.previewFile, choice.group.id);
	}

	private scheduleChoicePreview(
		choice: SeriesChoice,
		anchorEl: HTMLElement,
		event: PointerEvent,
	): void {
		if (choice.kind === 'new') {
			if (choice.file) {
				this.hoverPreview?.scheduleFile(
					choice.file,
					anchorEl,
					choice.file.basename,
					event,
				);
			} else {
				this.hoverPreview?.schedulePlaceholder(
					this.i18n.t('series.create'),
					this.i18n.t('series.createPreview'),
					anchorEl,
				);
			}
			return;
		}
		if (choice.previewFile) {
			this.hoverPreview?.scheduleFile(
				choice.previewFile,
				anchorEl,
				choice.group.topic,
				event,
			);
			return;
		}
		this.hoverPreview?.schedulePlaceholder(
			choice.group.topic,
			this.i18n.t('series.noResolvedFiles'),
			anchorEl,
		);
	}

	private statusLabel(group: VersionGroup): string {
		return this.i18n.t(SERIES_STATUS_KEYS[group.status]);
	}
}

const SERIES_STATUS_KEYS = {
	healthy: 'series.status.healthy',
	incomplete: 'series.status.incomplete',
	invalid: 'series.status.invalid',
} as const;
