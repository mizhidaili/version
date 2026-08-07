import {
	App,
	FuzzyMatch,
	FuzzySuggestModal,
	Notice,
	TFile,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import { mergeWithNoteComposer } from '../note-composer-compat';
import { VersionGroup, VersionIndex } from '../version-index';
import { VersionChoiceModal, renderThemeSuggestion } from './version-link-modal';
import { VersionHoverPreview } from './hover-preview';

type MergeTarget =
	| { file: TFile; kind: 'file' }
	| { group: VersionGroup; kind: 'group' };

export class VersionMergeTargetModal extends FuzzySuggestModal<MergeTarget> {
	private hoverPreview: VersionHoverPreview | null = null;

	constructor(
		app: App,
		private readonly index: VersionIndex,
		private readonly source: TFile,
		private readonly i18n: VersionI18n,
		private readonly onMerged: () => void,
	) {
		super(app);
		this.setPlaceholder(this.i18n.t('merge.chooseTarget'));
		this.limit = Number.POSITIVE_INFINITY;
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.modalEl.addClass('version-merge-target-modal');
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

	getItems(): MergeTarget[] {
		const groups = this.index.getGroups();
		const healthyPaths = new Set(groups.flatMap((group) =>
			group.versions.map((member) => member.path)));
		const targets: MergeTarget[] = groups
			.filter((group) => group.versions.some((member) =>
				member.path !== this.source.path && member.file.extension === 'md'))
			.map((group) => ({ group, kind: 'group' }));

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.path !== this.source.path && !healthyPaths.has(file.path)) {
				targets.push({ file, kind: 'file' });
			}
		}

		return targets.sort((left, right) =>
			this.getItemText(left).localeCompare(this.getItemText(right)));
	}

	getItemText(target: MergeTarget): string {
		return target.kind === 'group'
			? `${target.group.topic} ${target.group.folder}`
			: target.file.path;
	}

	renderSuggestion(match: FuzzyMatch<MergeTarget>, el: HTMLElement): void {
		if (match.item.kind === 'group') {
			const nameEl = renderThemeSuggestion(match.item.group, el);
			const v1 = match.item.group.versions.find((member) => member.version === 1);
			if (v1) {
				this.bindPreview(nameEl, v1.file, match.item.group.topic);
			}
			return;
		}

		const row = el.createDiv({ cls: 'version-merge-file-suggestion' });
		const nameEl = row.createDiv({
			cls: 'version-theme-suggestion-name',
			text: match.item.file.basename,
		});
		if (!match.item.file.parent?.isRoot()) {
			row.createDiv({
				cls: 'version-theme-suggestion-folder',
				text: match.item.file.parent?.path,
			});
		}
		this.bindPreview(nameEl, match.item.file, match.item.file.basename);
	}

	onChooseItem(target: MergeTarget): void {
		if (target.kind === 'file') {
			void this.mergeInto(target.file);
			return;
		}

		new VersionChoiceModal(
			this.app,
			target.group,
			(choice) => void this.mergeInto(choice.file),
			this.i18n,
			{
				includeOverall: false,
				placeholder: this.i18n.t('link.chooseVersion', {
					topic: target.group.topic,
				}),
				versionFilter: (member) =>
					member.path !== this.source.path && member.file.extension === 'md',
			},
		).open();
	}

	private bindPreview(
		nameEl: HTMLElement,
		file: TFile,
		label: string,
	): void {
		nameEl.addEventListener('pointerenter', (event) => {
			this.hoverPreview?.scheduleFile(file, nameEl, label, event);
		});
		nameEl.addEventListener('pointerleave', () =>
			this.hoverPreview?.scheduleHide());
	}

	private async mergeInto(target: TFile): Promise<void> {
		try {
			await mergeWithNoteComposer(this.app, target, this.source);
			this.onMerged();
		} catch (error) {
			new Notice(this.i18n.t('merge.failed', {
				message: error instanceof Error ? error.message : String(error),
			}));
		}
	}
}
