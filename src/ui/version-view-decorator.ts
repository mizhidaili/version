import {
	App,
	FileView,
	MarkdownView,
	Menu,
	Notice,
	setIcon,
	setTooltip,
	TFile,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import {
	formatVersionFilename,
	getOverallVersion,
	getMissingVersions,
	getNextVersion,
	MAX_VERSION,
	VersionFile,
	VersionGroup,
	VersionIndex,
} from '../version-index';
import { VersionRegistry } from '../version-registry';
import { isVersionableFile } from '../version-file-types';
import { setMenuItemWarning } from '../menu-item-warning';
import {
	detectVersionFileFormat,
	stripVersionFileSuffix,
	VersionFileCreationError,
	VersionFileCreationErrorCode,
	type VersionFileFormat,
} from '../version-file-creation';
import { getVersionFileCreationErrorMessage } from '../version-file-creation-message';
import {
	createAndRegisterVersionFile,
	type RegisteredVersionFileResult,
	VersionFileRegistrationError,
} from '../version-file-creation-transaction';
import { CreateVersionModal } from './create-version-modal';

interface ViewControls {
	actionEl: HTMLElement;
	backlinksEl: HTMLElement;
	contentEl: HTMLElement;
	labelEl: HTMLElement;
	manageEl: HTMLElement;
	railEl: HTMLElement;
	resizeObserver: ResizeObserver;
	scrollDownCueEl: HTMLElement;
	scrollUpCueEl: HTMLElement;
	tabsEl: HTMLElement;
}

const VERSION_VIEW_TYPE_CLASSES = [
	'version-view-type-canvas',
	'version-view-type-excalidraw',
] as const;

export class VersionViewDecorator {
	private readonly controls = new Map<FileView, ViewControls>();
	private readonly standaloneActions = new Map<FileView, HTMLElement>();
	private nextLabelId = 0;

	constructor(
		private readonly app: App,
		private readonly index: VersionIndex,
		private readonly registry: VersionRegistry,
		private readonly getFilenameTemplate: () => string,
		private readonly onFilesChanged: () => void,
		private readonly onManage: (file: TFile) => void,
		private readonly onDeleteVersions: (
			group: VersionGroup,
			initialFile?: TFile,
		) => void,
		private readonly onFileActions: (
			group: VersionGroup,
			initialFile: TFile,
		) => void,
		private readonly onShowBacklinks: (group: VersionGroup) => void,
		private readonly i18n: VersionI18n,
	) {}

	refresh(): void {
		const liveViews = new Set<FileView>();

		this.app.workspace.iterateAllLeaves((leaf) => {
			const root = leaf.getRoot();
			const viewType = leaf.view.getViewType();
			if (
				root === this.app.workspace.leftSplit ||
				root === this.app.workspace.rightSplit ||
				!isEditableVersionViewType(viewType)
			) {
				return;
			}
			if (!(leaf.view instanceof FileView)) {
				return;
			}

			const view = leaf.view;
			liveViews.add(view);
			const group = view.file && isVersionableFile(view.file)
				? this.index.getGroupForFile(view.file)
				: null;
			if (view.file && !isVersionableFile(view.file)) {
				this.removeControls(view);
				this.removeStandaloneAction(view);
				return;
			}

			if (!group) {
				this.removeControls(view);
				this.ensureStandaloneAction(view, false);
				return;
			}

			if (group.status !== 'healthy') {
				this.removeControls(view);
				this.ensureStandaloneAction(view, true);
				return;
			}

			this.removeStandaloneAction(view);
			this.renderControls(view, group);
		});

		for (const view of this.controls.keys()) {
			if (!liveViews.has(view)) {
				this.removeControls(view);
			}
		}

		for (const view of this.standaloneActions.keys()) {
			if (!liveViews.has(view)) {
				this.removeStandaloneAction(view);
			}
		}
	}

	destroy(): void {
		for (const view of [...this.controls.keys()]) {
			this.removeControls(view);
		}
		for (const view of [...this.standaloneActions.keys()]) {
			this.removeStandaloneAction(view);
		}
	}

	private renderControls(view: FileView, group: VersionGroup): void {
		const controls = this.ensureControls(view);
		controls.labelEl.textContent = this.i18n.t('view.versionsAria');
		const signature = JSON.stringify([
			group.id,
			...group.versions.map((member) => [member.version, member.path]),
		]);
		const existingButtons = [
			...controls.tabsEl.querySelectorAll<HTMLButtonElement>('.version-tab'),
		];
		const canUpdateInPlace =
			controls.tabsEl.dataset.versionSignature === signature &&
			existingButtons.length === group.versions.length;

		if (canUpdateInPlace) {
			for (const [index, versionFile] of group.versions.entries()) {
				this.updateVersionButton(
					existingButtons[index],
					view,
					group,
					versionFile,
				);
			}
			this.scheduleOverflowCueUpdate(controls);
			return;
		}

		controls.tabsEl.empty();
		controls.tabsEl.dataset.versionSignature = signature;

		for (const versionFile of group.versions) {
			const button = controls.tabsEl.createEl('button', {
				cls: 'version-tab',
			});
			button.type = 'button';
			this.updateVersionButton(button, view, group, versionFile);
			button.addEventListener('click', () => {
				void this.openVersion(view, versionFile.file);
			});
			button.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				this.openVersionMenu(event, view, group, versionFile);
			});
		}
		this.scheduleOverflowCueUpdate(controls);
	}

	private updateVersionButton(
		button: HTMLButtonElement,
		view: FileView,
		group: VersionGroup,
		versionFile: VersionFile,
	): void {
		button.textContent = `V${versionFile.version}`;
		const openLabel = this.i18n.t('view.openVersionAria', {
			topic: group.topic,
			version: versionFile.version,
		});
		const tooltip = `${openLabel} · ${this.i18n.t('view.versionActions')}`;
		button.ariaLabel = tooltip;
		button.removeAttribute('title');
		setTooltip(button, tooltip, { placement: 'left' });
		const isActive = view.file?.path === versionFile.path;
		button.classList.toggle('is-active', isActive);
		button.setAttribute('aria-pressed', String(isActive));
	}

	private ensureControls(view: FileView): ViewControls {
		const existing = this.controls.get(view);
		if (
			existing &&
			existing.contentEl === view.contentEl &&
			existing.tabsEl.isConnected &&
			view.containerEl.contains(existing.tabsEl) &&
			existing.railEl.isConnected &&
			existing.labelEl.isConnected &&
			existing.actionEl.isConnected &&
			existing.backlinksEl.isConnected &&
			existing.manageEl.isConnected
		) {
			this.applyViewTypeClass(view);
			return existing;
		}
		if (existing) {
			// Some third-party views (notably Excalidraw) replace their content
			// element after the initial file-open event. Rebuild the host binding
			// so the lane and ResizeObserver never remain attached to stale DOM.
			existing.actionEl.remove();
			existing.backlinksEl.remove();
			existing.manageEl.remove();
			existing.resizeObserver.disconnect();
			existing.railEl.remove();
			existing.contentEl.removeClass('version-view-content');
			view.containerEl.removeClass('version-view-container');
			view.containerEl.removeClass(...VERSION_VIEW_TYPE_CLASSES);
			this.controls.delete(view);
		}

		this.applyViewTypeClass(view);
		view.contentEl.addClass('version-view-content');
		const railEl = view.containerEl.createDiv({
			cls: 'version-tabs-shell',
		});
		const labelId = `version-tabs-label-${++this.nextLabelId}`;
		const labelEl = railEl.createSpan({
			cls: 'version-visually-hidden',
			text: this.i18n.t('view.versionsAria'),
			attr: { id: labelId },
		});
		const tabsEl = railEl.createDiv({
			cls: 'version-tabs',
			attr: {
				'aria-labelledby': labelId,
				role: 'group',
			},
		});
		const scrollUpCueEl = railEl.createDiv({
			cls: ['version-tabs-overflow-cue', 'is-up'],
			attr: { 'aria-hidden': 'true' },
		});
		setIcon(scrollUpCueEl, 'chevron-up');
		const scrollDownCueEl = railEl.createDiv({
			cls: ['version-tabs-overflow-cue', 'is-down'],
			attr: { 'aria-hidden': 'true' },
		});
		setIcon(scrollDownCueEl, 'chevron-down');
		const actionEl = view.addAction(
			'plus',
			this.i18n.t('view.addEmpty'),
			(event) => this.handleAddVersion(view, event),
		);
		actionEl.addClass('version-add-action');
		const manageEl = view.addAction(
			'list-tree',
			this.i18n.t('manage.title'),
			() => {
				if (view.file) {
					this.onManage(view.file);
				}
			},
		);
		manageEl.addClass('version-manage-action');
		const backlinksEl = view.addAction(
			'links-coming-in',
			this.i18n.t('command.showBacklinks'),
			() => {
				const current = view.file
					? this.index.getGroupForFile(view.file)
					: null;
				if (current?.status === 'healthy') {
					this.onShowBacklinks(current);
				}
			},
		);
		backlinksEl.addClass('version-backlinks-action');

		const controls: ViewControls = {
			actionEl,
			backlinksEl,
			contentEl: view.contentEl,
			labelEl,
			manageEl,
			railEl,
			resizeObserver: new ResizeObserver(() => {
				this.updateOverflowCues(controls);
			}),
			scrollDownCueEl,
			scrollUpCueEl,
			tabsEl,
		};
		tabsEl.addEventListener('scroll', () => {
			this.updateOverflowCues(controls);
		}, { passive: true });
		controls.resizeObserver.observe(tabsEl);
		controls.resizeObserver.observe(view.contentEl);
		controls.resizeObserver.observe(view.containerEl);
		this.controls.set(view, controls);
		return controls;
	}

	private scheduleOverflowCueUpdate(controls: ViewControls): void {
		const win = controls.tabsEl.ownerDocument.defaultView;
		if (!win) {
			this.updateOverflowCues(controls);
			return;
		}
		win.requestAnimationFrame(() => {
			if (controls.tabsEl.isConnected) {
				this.updateOverflowCues(controls);
			}
		});
	}

	private updateOverflowCues(controls: ViewControls): void {
		const { clientHeight, scrollHeight, scrollTop } = controls.tabsEl;
		const hasOverflow = scrollHeight - clientHeight > 1;
		controls.scrollUpCueEl.classList.toggle(
			'is-visible',
			hasOverflow && scrollTop > 1,
		);
		controls.scrollDownCueEl.classList.toggle(
			'is-visible',
			hasOverflow && scrollTop + clientHeight < scrollHeight - 1,
		);
	}

	private removeControls(view: FileView): void {
		const controls = this.controls.get(view);
		if (!controls) {
			return;
		}

		controls.actionEl.remove();
		controls.backlinksEl.remove();
		controls.manageEl.remove();
		controls.resizeObserver.disconnect();
		controls.railEl.remove();
		controls.contentEl.removeClass('version-view-content');
		if (controls.contentEl !== view.contentEl) {
			view.contentEl.removeClass('version-view-content');
		}
		view.containerEl.removeClass('version-view-container');
		view.containerEl.removeClass(...VERSION_VIEW_TYPE_CLASSES);
		this.controls.delete(view);
	}

	private applyViewTypeClass(view: FileView): void {
		view.containerEl.addClass('version-view-container');
		view.containerEl.removeClass(...VERSION_VIEW_TYPE_CLASSES);
		view.contentEl.removeClass(...VERSION_VIEW_TYPE_CLASSES);
		const viewType = view.getViewType().toLocaleLowerCase();
		if (viewType === 'canvas') {
			view.containerEl.addClass('version-view-type-canvas');
		} else if (viewType.includes('excalidraw')) {
			view.containerEl.addClass('version-view-type-excalidraw');
		}
	}

	private ensureStandaloneAction(view: FileView, repair: boolean): void {
		if (!view.file) {
			return;
		}
		const existing = this.standaloneActions.get(view);
		const mode = repair ? 'repair' : 'create';
		if (
			existing?.dataset.versionMode === mode &&
			existing.isConnected &&
			view.containerEl.contains(existing)
		) {
			return;
		}
		if (existing) {
			this.removeStandaloneAction(view);
		}

		const actionEl = view.addAction(
			repair ? 'wrench' : 'plus',
			this.i18n.t(repair ? 'view.repairVersions' : 'view.createSecond'),
			() => {
				if (view.file) {
					this.onManage(view.file);
				}
			},
		);
		actionEl.addClass('version-start-action');
		actionEl.dataset.versionMode = mode;
		this.standaloneActions.set(view, actionEl);
	}

	private removeStandaloneAction(view: FileView): void {
		const actionEl = this.standaloneActions.get(view);
		if (!actionEl) {
			return;
		}

		actionEl.remove();
		this.standaloneActions.delete(view);
	}

	private openVersionMenu(
		event: MouseEvent,
		_view: FileView,
		group: VersionGroup,
		versionFile: VersionFile,
	): void {
		new Menu()
			.addItem((item) =>
				item
					.setTitle(this.i18n.t('view.fileActionsForVersion', {
						version: versionFile.version,
					}))
					.setIcon('list-checks')
					.onClick(() => this.onFileActions(group, versionFile.file)),
			)
			.addSeparator()
			.addItem((item) => {
				item
					.setTitle(this.i18n.t('fileExplorer.deleteVersions'))
					.setIcon('trash-2')
					.onClick(() => this.onDeleteVersions(group, versionFile.file));
				setMenuItemWarning(item);
			})
			.showAtMouseEvent(event);
	}

	private async openVersion(view: FileView, file: TFile): Promise<void> {
		try {
			if (view instanceof MarkdownView) {
				await view.save();
			}
			await view.leaf.openFile(file, { active: true });
			this.refresh();
		} catch (error) {
			new Notice(this.i18n.t('view.openFailed', {
				message: getErrorMessage(error),
			}));
		}
	}

	private handleAddVersion(view: FileView, event: MouseEvent): void {
		if (!view.file) {
			return;
		}

		const group = this.index.getGroupForFile(view.file);
		if (!group || group.status !== 'healthy') {
			return;
		}

		const missingVersions = getMissingVersions(group);
		const nextVersion = getNextVersion(group);
		if (missingVersions.length === 0) {
			if (nextVersion > MAX_VERSION) {
				new Notice(this.i18n.t('view.limitReached', {
					version: MAX_VERSION,
				}));
				return;
			}
			this.openCreateVersionModal(view, group, nextVersion, false);
			return;
		}

		const menu = new Menu().setUseNativeMenu(false);
		menu.addItem((item) =>
			item
				.setTitle(
					nextVersion <= MAX_VERSION
						? this.i18n.t('view.createVersion', {
								version: nextVersion,
							})
						: this.i18n.t('view.maximumVersion', {
								version: MAX_VERSION,
							}),
				)
				.setIcon('plus')
				.setDisabled(nextVersion > MAX_VERSION)
				.setSection('new-maximum')
				.onClick(() => {
					this.openCreateVersionModal(
						view,
						group,
						nextVersion,
						false,
					);
				}),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(this.i18n.t('view.fillMissing'))
				.setIsLabel(true)
				.setSection('missing-versions'),
		);

		for (const version of missingVersions) {
			menu.addItem((item) =>
				item
					.setTitle(`V${version}`)
					.setIcon('circle-plus')
					.setSection('missing-versions')
					.onClick(() => {
						this.openCreateVersionModal(
							view,
							group,
							version,
							true,
						);
					}),
			);
		}

		menu.showAtMouseEvent(event);
		this.markGapMenuScrollable(event);
	}

	private openCreateVersionModal(
		view: FileView,
		group: VersionGroup,
		version: number,
		fillsGap: boolean,
	): void {
		const v1 = getOverallVersion(group);
		if (!v1 || version < 1 || version > MAX_VERSION) {
			new Notice(this.i18n.t('view.range', { version: MAX_VERSION }));
			return;
		}
		let defaultFilename: string;
		try {
			defaultFilename = formatVersionFilename(
				this.getFilenameTemplate(),
				stripVersionFileSuffix(v1.file.name),
				version,
			);
		} catch (error) {
			new Notice(this.i18n.t('view.createFailed', {
				message: getErrorMessage(error),
			}));
			return;
		}
		new CreateVersionModal(
			this.app,
			version,
			defaultFilename,
			detectVersionFileFormat(view.file ?? v1.file) ?? 'markdown',
			fillsGap,
			(filename, format) => this.createSpecificVersion(
				view,
				version,
				filename,
				format,
			),
			this.i18n,
		).open();
	}

	private markGapMenuScrollable(event: MouseEvent): void {
		const target = event.currentTarget as HTMLElement | null;
		const doc = target?.ownerDocument;
		const win = doc?.defaultView;
		if (!doc || !win) {
			return;
		}

		win.requestAnimationFrame(() => {
			const ownedItems = doc.querySelectorAll<HTMLElement>(
				'.menu [data-section="missing-versions"]',
			);
			ownedItems.item(ownedItems.length - 1)
				?.closest<HTMLElement>('.menu')
				?.addClass('version-gap-menu');
		});
	}

	private async createSpecificVersion(
		view: FileView,
		version: number,
		filename: string,
		format: VersionFileFormat,
	): Promise<boolean> {
		if (!view.file || version < 1 || version > MAX_VERSION) {
			new Notice(this.i18n.t('view.range', { version: MAX_VERSION }));
			return false;
		}

		const group = this.index.getGroupForFile(view.file);
		if (!group || group.status !== 'healthy') {
			return false;
		}

		if (group.versions.some((item) => item.version === version)) {
			new Notice(this.i18n.t('view.alreadyExists', { version }));
			return false;
		}

		let result: RegisteredVersionFileResult;
		try {
			if (view instanceof MarkdownView) {
				await view.save();
			}
			result = await createAndRegisterVersionFile(
				this.app,
				{
					folderPath: group.folder,
					format,
					stem: filename,
				},
				(file) => this.registry.addMember(group.id, version, file),
				(file) => this.app.fileManager.trashFile(file),
				(file) => view.leaf.openFile(file, { active: true }),
			);
			this.onFilesChanged();
		} catch (error) {
			const creationError = error instanceof VersionFileRegistrationError
				? error.originalCause
				: error;
			const rollbackFailurePath = error instanceof VersionFileRegistrationError
				? error.rollbackFailures[0]
				: creationError instanceof VersionFileCreationError
					? creationError.rollbackFailures[0]
					: undefined;
			if (rollbackFailurePath) {
				new Notice(this.i18n.t('view.rollbackFailed', {
					path: rollbackFailurePath,
				}));
			}
			this.registry.rebuild();
			this.onFilesChanged();
			this.showCreationFailure(creationError);
			return false;
		}

		if (result.openFailed) {
			new Notice(this.i18n.t('view.openAnotherFailed', {
				message: getErrorMessage(result.openError),
			}));
		}
		this.refresh();
		return true;
	}

	private showCreationFailure(error: unknown): void {
		if (
			error instanceof VersionFileCreationError &&
			error.code === VersionFileCreationErrorCode.PathConflict &&
			error.path
		) {
			const existing = this.app.vault.getFileByPath(error.path);
			const owner = existing ? this.index.getGroupForFile(existing) : null;
			const ownerMember = owner?.versions.find(
				(member) => member.path === error.path,
			);
			new Notice(
				owner && ownerMember
					? this.i18n.t('view.createManagedExists', {
							path: error.path,
							topic: owner.topic,
							version: ownerMember.version,
						})
					: this.i18n.t('view.createExists', { path: error.path }),
			);
			return;
		}
		new Notice(this.i18n.t('view.createFailed', {
			message: getVersionFileCreationErrorMessage(error, this.i18n),
		}));
	}

}

function isEditableVersionViewType(viewType: string): boolean {
	return (
		viewType === 'canvas' ||
		viewType === 'markdown' ||
		viewType.toLocaleLowerCase().includes('excalidraw')
	);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
