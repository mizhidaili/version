import {
	App,
	FuzzyMatch,
	FuzzySuggestModal,
	Notice,
	TFolder,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import { buildMovePlans, MovePlan } from '../move-theme-plans';
import { VersionGroup } from '../version-index';

export class MoveThemeModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly group: VersionGroup,
		private readonly moveFiles: (plans: MovePlan[]) => Promise<void>,
		private readonly onFilesChanged: () => void,
		private readonly i18n: VersionI18n,
	) {
		super(app);
		this.setPlaceholder(
			this.i18n.t('move.placeholder', { topic: group.topic }),
		);
		this.emptyStateText = this.i18n.t('move.noFolders');
		this.limit = Number.POSITIVE_INFINITY;
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(true);
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot()
			? this.i18n.t('move.vaultRoot')
			: folder.path;
	}

	renderSuggestion(match: FuzzyMatch<TFolder>, el: HTMLElement): void {
		el.createDiv({
			cls: 'version-theme-suggestion-name',
			text: match.item.isRoot()
				? this.i18n.t('move.vaultRoot')
				: match.item.name,
		});
		if (!match.item.isRoot()) {
			el.createDiv({
				cls: 'version-theme-suggestion-folder',
				text: match.item.path,
			});
		}
	}

	onChooseItem(folder: TFolder): void {
		void this.moveGroup(folder);
	}

	private async moveGroup(folder: TFolder): Promise<void> {
		const destinationFolder = folder.isRoot() ? '' : folder.path;
		const plans = buildMovePlans(this.group, destinationFolder);
		const movedCount = plans.filter((plan) => plan.from !== plan.to).length;
		if (movedCount === 0) {
			new Notice(this.i18n.t('move.alreadyThere'));
			return;
		}

		const destinationCounts = new Map<string, number>();
		for (const plan of plans) {
			destinationCounts.set(
				plan.to,
				(destinationCounts.get(plan.to) ?? 0) + 1,
			);
		}
		const collisions = plans.filter((plan) => {
			const existing = this.app.vault.getAbstractFileByPath(plan.to);
			return (
				(existing !== null && existing !== plan.file) ||
				(destinationCounts.get(plan.to) ?? 0) > 1
			);
		});
		if (collisions.length > 0) {
			new Notice(this.i18n.t('move.collision', {
				count: collisions.length,
				subject: this.i18n.t(
					collisions.length === 1
						? 'move.collisionOne'
						: 'move.collisionMany',
				),
			}));
			return;
		}

		try {
			await this.moveFiles(plans);
			this.onFilesChanged();
			new Notice(this.i18n.t('move.success', {
				count: movedCount,
				unit: this.i18n.t(
					movedCount === 1
						? 'common.version'
						: 'common.versions',
				),
				destination: folder.isRoot()
					? this.i18n.t('move.rootDestination')
					: folder.path,
			}));
		} catch (error) {
			this.onFilesChanged();

			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(this.i18n.t('move.failed', { message }));
		}
	}
}
