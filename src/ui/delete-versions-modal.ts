import {
	App,
	ButtonComponent,
	Modal,
	Notice,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import {
	captureVersionForTrash,
	CapturedVersionForTrash,
	isUnchangedCapturedFile,
	trashCapturedVersions,
} from '../delete-versions-safety';
import { VersionFile, VersionGroup } from '../version-index';
import { VersionHoverPreview } from './hover-preview';

export class DeleteVersionsModal extends Modal {
	private readonly selectedPaths = new Set<string>();
	private cancelButton: ButtonComponent | null = null;
	private readonly versionCheckboxes = new Map<string, HTMLInputElement>();
	private deleteButton: ButtonComponent | null = null;
	private hoverPreview: VersionHoverPreview | null = null;
	private selectAllCheckbox: HTMLInputElement | null = null;
	private submitting = false;
	private updatingSelection = false;
	private readonly capturedVersions = new Map<string, CapturedVersionForTrash>();

	constructor(
		app: App,
		private readonly group: VersionGroup,
		private readonly onFilesChanged: () => void,
		private readonly releaseVersions: (
			versions: CapturedVersionForTrash[],
		) => Promise<void>,
		private readonly i18n: VersionI18n,
		private readonly initialPath: string | null = null,
	) {
		super(app);
		for (const versionFile of group.versions) {
			this.capturedVersions.set(
				versionFile.path,
				captureVersionForTrash(versionFile),
			);
		}
	}

	onOpen(): void {
		this.modalEl.addClass('version-delete-modal');
		const initial = this.group.versions.find(
			(versionFile) => versionFile.path === this.initialPath,
		);
		this.titleEl.setText(
			this.i18n.t('delete.title', { topic: this.group.topic }),
		);

		const selectAll = this.contentEl.createEl('label', {
			cls: 'version-delete-select-all',
		});
		this.selectAllCheckbox = selectAll.createEl('input', {
			attr: { type: 'checkbox' },
		});
		selectAll.createSpan({ text: this.i18n.t('delete.selectAll') });
		this.selectAllCheckbox.addEventListener('change', () => {
			this.setAllSelected(Boolean(this.selectAllCheckbox?.checked));
		});
		this.contentEl.createDiv({
			cls: 'version-delete-v1-note',
			text: this.i18n.t('delete.v1RequiresAll'),
		});

		const layout = this.contentEl.createDiv({
			cls: 'version-delete-layout',
		});
		const listEl = layout.createDiv({
			cls: 'version-delete-list',
		});
		this.hoverPreview = new VersionHoverPreview(
			this.app,
			this.modalEl.ownerDocument,
			this.i18n,
		);
		for (const versionFile of this.group.versions) {
			if (versionFile.version !== 1) {
				this.addVersionChoice(listEl, versionFile);
			}
		}

		const actions = this.contentEl.createDiv({
			cls: 'version-delete-actions',
		});
		this.cancelButton = new ButtonComponent(actions)
			.setButtonText(this.i18n.t('common.cancel'))
			.onClick(() => this.close());
		this.deleteButton = new ButtonComponent(actions)
			.setButtonText(this.i18n.t('delete.moveSelected'))
			.setClass('mod-warning')
			.setDisabled(true)
			.onClick(() => {
				void this.submit();
			});

		// Build every selection-dependent control before applying the context
		// passed from the exact-version actions modal. Otherwise a later button
		// constructor can silently reset the correctly synchronized state.
		if (initial?.version !== 1) {
			this.updatingSelection = true;
			if (initial) {
				this.selectedPaths.add(initial.path);
				const checkbox = this.versionCheckboxes.get(initial.path);
				if (checkbox) {
					checkbox.checked = true;
				}
			}
			this.updatingSelection = false;
		}
		this.syncSelectionState();

	}

	close(): void {
		if (this.submitting) {
			return;
		}
		super.close();
	}

	onClose(): void {
		this.hoverPreview?.destroy();
		this.hoverPreview = null;
		this.contentEl.empty();
		this.versionCheckboxes.clear();
		this.deleteButton = null;
		this.cancelButton = null;
		this.selectAllCheckbox = null;
	}

	private addVersionChoice(
		containerEl: HTMLElement,
		versionFile: VersionFile,
	): void {
		const choice = containerEl.createEl('label', {
			cls: 'version-delete-choice',
		});
		const checkbox = choice.createEl('input', {
			attr: { type: 'checkbox' },
		});
		this.versionCheckboxes.set(versionFile.path, checkbox);
		const text = choice.createDiv({ cls: 'version-delete-choice-text' });
		const nameEl = text.createDiv({
			cls: 'version-delete-choice-name',
			text: versionFile.file.basename,
		});
		text.createDiv({
			cls: 'version-delete-choice-version',
			text: this.i18n.t('delete.versionLabel', {
				version: versionFile.version,
			}),
		});
		checkbox.addEventListener('change', () => {
			if (this.updatingSelection) {
				return;
			}
			if (checkbox.checked) {
				this.selectedPaths.add(versionFile.path);
			} else {
				this.selectedPaths.delete(versionFile.path);
			}
			this.syncSelectionState();
		});
		nameEl.addEventListener('pointerenter', (event) => {
			this.hoverPreview?.scheduleFile(
				versionFile.file,
				nameEl,
				`V${versionFile.version} · ${versionFile.file.basename}`,
				event,
			);
		});
		nameEl.addEventListener('pointerleave', () =>
			this.hoverPreview?.scheduleHide());
	}

	private setAllSelected(selected: boolean): void {
		if (this.updatingSelection) {
			return;
		}

		this.updatingSelection = true;
		this.selectedPaths.clear();
		for (const versionFile of this.group.versions) {
			if (versionFile.version !== 1 && selected) {
				this.selectedPaths.add(versionFile.path);
			}
			const checkbox = this.versionCheckboxes.get(versionFile.path);
			if (checkbox) {
				checkbox.checked = selected;
			}
		}
		this.updatingSelection = false;
		this.syncSelectionState();
	}

	private syncSelectionState(): void {
		const selectedCount = this.selectedPaths.size;
		const totalCount = this.group.versions.filter(
			(versionFile) => versionFile.version !== 1,
		).length;
		this.updatingSelection = true;
		if (this.selectAllCheckbox) {
			this.selectAllCheckbox.checked = totalCount > 0 && selectedCount === totalCount;
			this.selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < totalCount;
		}
		this.updatingSelection = false;
		this.deleteButton
			?.setButtonText(
				selectedCount === 0
					? this.i18n.t('delete.moveSelected')
					: this.i18n.t('delete.moveCount', {
							count: selectedCount,
							unit: this.i18n.t(
								selectedCount === 1
									? 'common.version'
									: 'common.versions',
							),
						}),
			)
			.setDisabled(selectedCount === 0 || this.submitting);
	}

	private async submit(): Promise<void> {
		if (this.submitting || this.selectedPaths.size === 0) {
			return;
		}

		const selectedVersions = this.group.versions
			.filter((versionFile) =>
				this.selectedPaths.has(versionFile.path),
			);
		if (selectedVersions.length === 0) {
			new Notice(this.i18n.t('delete.selectedMissing'));
			this.close();
			return;
		}

		// Resolve and verify every selection before the first destructive call.
		// A file can be deleted and replaced at the same path while this dialog is
		// open; path equality alone must never authorize trashing the replacement.
		const selectedCaptures = selectedVersions.flatMap((versionFile) => {
			const captured = this.capturedVersions.get(versionFile.path);
			return captured ? [captured] : [];
		});
		const changedSelections = selectedCaptures.filter((captured) => {
			const live = this.app.vault.getFileByPath(captured.path);
			return !isUnchangedCapturedFile(live, captured);
		});
		if (changedSelections.length > 0 || selectedCaptures.length !== selectedVersions.length) {
			new Notice(this.i18n.t('delete.selectedChanged', {
				count: changedSelections.length +
					(selectedVersions.length - selectedCaptures.length),
			}));
			this.onFilesChanged();
			this.close();
			return;
		}

		this.submitting = true;
		this.cancelButton?.setDisabled(true);
		this.syncSelectionState();
		try {
			// Release the exact V2+ members first. If trash subsequently fails, the
			// file remains an ordinary visible note instead of corrupting the series.
			await this.releaseVersions(selectedCaptures);
		} catch (error) {
			this.submitting = false;
			new Notice(this.i18n.t('delete.releaseFailed', {
				message: error instanceof Error ? error.message : String(error),
			}));
			this.onFilesChanged();
			super.close();
			return;
		}
		const { deletedCount, failedPaths } = await trashCapturedVersions(
			this.app.vault,
			(file) => this.app.fileManager.trashFile(file),
			selectedCaptures,
		);

		this.onFilesChanged();
		super.close();

		if (deletedCount > 0) {
			new Notice(this.i18n.t('delete.moved', {
				count: deletedCount,
				subject: this.i18n.t(
					deletedCount === 1
						? 'delete.subjectOne'
						: 'delete.subjectMany',
				),
			}));
		}
		if (failedPaths.length > 0) {
			new Notice(this.i18n.t('delete.failed', {
				count: failedPaths.length,
				unit: this.i18n.t(
					failedPaths.length === 1
						? 'common.version'
						: 'common.versions',
				),
			}));
		}
	}
}
