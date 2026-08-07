import {
	App,
	FileView,
	MarkdownView,
	Menu,
	Notice,
	normalizePath,
	setIcon,
	TFile,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import { rollbackCreatedBlankFiles } from '../created-file-rollback';
import { captureFile, CapturedFile } from '../captured-file';
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
import { CreateVersionModal } from './create-version-modal';

interface ViewControls {
	actionEl: HTMLElement;
	backlinksEl: HTMLElement;
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

const EXCALIDRAW_TOP_ALIGNED_CLASS = 'version-excalidraw-rail-top-aligned';
const EXCALIDRAW_TOP_ALIGNMENT_MIN_WIDTH = 48 * 16;

export class VersionViewDecorator {
	private readonly controls = new Map<FileView, ViewControls>();
	private readonly standaloneActions = new Map<FileView, HTMLElement>();

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
		button.ariaLabel = this.i18n.t('view.openVersionAria', {
			topic: group.topic,
			version: versionFile.version,
		});
		button.title = this.i18n.t('view.versionActions');
		const isActive = view.file?.path === versionFile.path;
		button.classList.toggle('is-active', isActive);
		button.setAttribute('aria-pressed', String(isActive));
	}

	private ensureControls(view: FileView): ViewControls {
		this.applyViewTypeClass(view);
		this.updateVisualRailAnchor(view);
		const existing = this.controls.get(view);
		if (
			existing &&
			existing.tabsEl.isConnected &&
			view.contentEl.contains(existing.tabsEl) &&
			existing.railEl.isConnected &&
			existing.actionEl.isConnected &&
			existing.backlinksEl.isConnected &&
			existing.manageEl.isConnected
		) {
			return existing;
		}
		if (existing) {
			// Some third-party views (notably Excalidraw) replace their content
			// element after the initial file-open event. Discard the detached
			// controls instead of returning a stale cached set.
			existing.actionEl.remove();
			existing.backlinksEl.remove();
			existing.manageEl.remove();
			existing.resizeObserver.disconnect();
			existing.railEl.remove();
			this.controls.delete(view);
		}

		view.contentEl.addClass('version-view-content');
		const railEl = view.contentEl.createDiv({
			cls: 'version-tabs-shell',
		});
		const tabsEl = railEl.createDiv({
			cls: 'version-tabs',
			attr: {
				'aria-label': this.i18n.t('view.versionsAria'),
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
			manageEl,
			railEl,
			resizeObserver: new ResizeObserver(() => {
				this.updateVisualRailAnchor(view);
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
		view.contentEl.removeClass('version-view-content');
		view.contentEl.removeClass(...VERSION_VIEW_TYPE_CLASSES);
		view.contentEl.removeClass(EXCALIDRAW_TOP_ALIGNED_CLASS);
		this.controls.delete(view);
	}

	private applyViewTypeClass(view: FileView): void {
		view.contentEl.removeClass(...VERSION_VIEW_TYPE_CLASSES);
		view.contentEl.removeClass(EXCALIDRAW_TOP_ALIGNED_CLASS);
		const viewType = view.getViewType().toLocaleLowerCase();
		if (viewType === 'canvas') {
			view.contentEl.addClass('version-view-type-canvas');
		} else if (viewType.includes('excalidraw')) {
			view.contentEl.addClass('version-view-type-excalidraw');
		}
	}

	private updateVisualRailAnchor(view: FileView): void {
		const canShareRegularTopAnchor =
			view.getViewType().toLocaleLowerCase().includes('excalidraw') &&
			view.contentEl.clientWidth >= EXCALIDRAW_TOP_ALIGNMENT_MIN_WIDTH;
		view.contentEl.classList.toggle(
			EXCALIDRAW_TOP_ALIGNED_CLASS,
			canShareRegularTopAnchor,
		);
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
				v1.file.basename,
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
			fillsGap,
			(filename) => this.createSpecificVersion(
				view,
				version,
				filename,
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

		const path = normalizePath(
			group.folder
				? `${group.folder}/${filename}.md`
				: `${filename}.md`,
		);

		if (this.app.vault.getAbstractFileByPath(path)) {
			const existing = this.app.vault.getFileByPath(path);
			const owner = existing ? this.index.getGroupForFile(existing) : null;
			const ownerMember = owner?.versions.find((member) => member.path === path);
			new Notice(
				owner && ownerMember
					? this.i18n.t('view.createManagedExists', {
							path,
							topic: owner.topic,
							version: ownerMember.version,
						})
					: this.i18n.t('view.createExists', { path }),
			);
			return false;
		}

		let createdFile: TFile | null = null;
		let createdCapture: CapturedFile | null = null;
		let registered = false;
		try {
			if (view instanceof MarkdownView) {
				await view.save();
			}
			createdFile = await this.app.vault.create(path, '');
			createdCapture = captureFile(createdFile);
			await this.registry.addMember(group.id, version, createdFile);
			registered = true;
			this.onFilesChanged();
			await view.leaf.openFile(createdFile, { active: true });
			this.refresh();
			return true;
		} catch (error) {
			if (createdFile && createdCapture && !registered) {
				const rollbackFailures = await rollbackCreatedBlankFiles(
					this.app.vault,
					(file) => this.app.fileManager.trashFile(file),
					[createdCapture],
				);
				if (rollbackFailures.length > 0) {
					new Notice(this.i18n.t('view.rollbackFailed', {
						path: createdFile.path,
					}));
				}
			}
			this.registry.rebuild();
			this.onFilesChanged();
			new Notice(this.i18n.t('view.createFailed', {
				message: getErrorMessage(error),
			}));
			return false;
		}
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
