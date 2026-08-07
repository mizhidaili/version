import {
	App,
	FileSystemAdapter,
	FuzzyMatch,
	FuzzySuggestModal,
	Modal,
	Notice,
	normalizePath,
	Platform,
	Setting,
	TFile,
	TFolder,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import {
	canOpenFileRecoveryHistory,
	openFileRecoveryHistory,
} from '../file-recovery-compat';
import {
	collectNativeFileActions,
	groupCopyPathActions,
	NativeFileAction,
} from '../native-file-action-bridge';
import { VersionFile, VersionGroup } from '../version-index';
import { buildCopyFilename } from '../version-file-name';
import { VersionHoverPreview } from './hover-preview';

const NATIVE_SUBMENU_OPEN_DELAY_MS = 320;
const NATIVE_SUBMENU_CLOSE_DELAY_MS = 160;

export class VersionFileActionsModal extends Modal {
	private actionsEl!: HTMLElement;
	private hoverPreview!: VersionHoverPreview;
	private readonly nativeActionFlyouts = new Map<HTMLElement, {
		close: () => void;
		trigger: HTMLButtonElement;
	}>();
	private readonly nativeActionTimerIds = new Set<number>();
	private selected: VersionFile;
	private versionsEl!: HTMLElement;

	constructor(
		app: App,
		private readonly group: VersionGroup,
		initialFile: TFile | null,
		private readonly onDelete: (file: TFile) => void,
		private readonly onManage: (file: TFile) => void,
		private readonly onMoveSeries: () => void,
		private readonly onMerge: (file: TFile) => void,
		private readonly i18n: VersionI18n,
	) {
		super(app);
		this.selected =
			group.versions.find((member) => member.path === initialFile?.path) ??
			group.versions[0];
	}

	onOpen(): void {
		this.modalEl.addClass('version-file-actions-modal');
		this.setTitle(this.i18n.t('actions.title', { topic: this.group.topic }));
		const layout = this.contentEl.createDiv({
			cls: 'version-file-actions-layout',
		});
		this.versionsEl = layout.createDiv({
			cls: 'version-file-actions-versions',
		});
		this.hoverPreview = new VersionHoverPreview(
			this.app,
			this.modalEl.ownerDocument,
			this.i18n,
		);
		this.actionsEl = layout.createDiv({
			cls: 'version-file-actions-list',
		});
		this.actionsEl.addEventListener('scroll', () => {
			this.closeNativeActionFlyouts();
		});
		this.renderVersions();
		this.renderActions();
	}

	onClose(): void {
		this.destroyNativeActionFlyouts();
		this.hidePreviews();
		this.contentEl.empty();
	}

	private renderVersions(focusVersion: number | null = null): void {
		this.hidePreviews();
		this.versionsEl.empty();
		this.versionsEl.createEl('h3', { text: this.i18n.t('actions.versions') });
		let focusButton: HTMLButtonElement | null = null;
		for (const member of this.group.versions) {
			const button = this.versionsEl.createEl('button', {
				cls: `version-file-actions-version${member.path === this.selected.path ? ' is-selected' : ''}`,
				attr: { type: 'button' },
			});
			const text = button.createSpan({
				cls: 'version-file-actions-version-text',
			});
			const nameEl = text.createSpan({
				cls: 'version-file-actions-version-name',
				text: member.file.basename,
			});
			text.createSpan({
				cls: 'version-file-actions-version-detail',
				text: this.i18n.t('delete.versionLabel', {
					version: member.version,
				}),
			});
			nameEl.addEventListener('pointerenter', (event) => {
				this.hoverPreview.scheduleFile(member.file, nameEl,
					`V${member.version} · ${member.file.basename}`, event);
			});
			nameEl.addEventListener('pointerleave', () => {
				this.hoverPreview.scheduleHide();
			});
			button.addEventListener('click', () => {
				this.selected = member;
				this.renderVersions(member.version);
				this.renderActions();
			});
			if (member.version === focusVersion) {
				focusButton = button;
			}
		}
		if (focusButton) {
			focusButton.focus({ preventScroll: true });
		}
	}

	private hidePreviews(): void {
		this.hoverPreview.destroy();
	}

	private renderActions(): void {
		this.destroyNativeActionFlyouts();
		this.actionsEl.empty();
		this.actionsEl.createEl('h3', { text: this.i18n.t('actions.actions') });
		const nativeActions = groupCopyPathActions(
			collectNativeFileActions(this.app, this.selected.file),
			this.i18n.t('actions.copyPath'),
		);
		const copyPathActions = nativeActions.filter(isCopyPathAction);
		const versionHistoryActions = nativeActions.filter(isVersionHistoryAction);
		const generalNativeActions = nativeActions.filter((action) =>
			!isCopyPathAction(action) && !isVersionHistoryAction(action));

		this.addAction('actions.open', () => this.openSelected(false));
		this.addAction('actions.openNewTab', () =>
			this.openSelected('tab'));
		this.addAction('actions.openSplit', () =>
			this.openSelected('split'));
		if (Platform.isDesktopApp) {
			this.addAction('actions.openWindow', () =>
				this.openSelected('window'));
		}
		this.actionsEl.createDiv({ cls: 'version-file-actions-separator' });
		this.addAction('actions.duplicate', () => this.duplicateSelected());
		this.addAction(
			this.selected.version === 1 ? 'actions.moveSeries' : 'actions.move',
			() => {
				if (this.selected.version === 1) {
					this.close();
					this.onMoveSeries();
					return;
				}
				this.moveSelected();
			},
		);
		for (const action of generalNativeActions) {
			this.addNativeAction(action, this.actionsEl, 0);
		}
		if (this.selected.file.extension.toLocaleLowerCase() === 'md') {
			this.addAction('merge.action', () => {
				const file = this.selected.file;
				this.close();
				this.onMerge(file);
			});
		}

		this.actionsEl.createDiv({ cls: 'version-file-actions-separator' });
		if (copyPathActions.length === 0) {
			this.addAction('actions.copyPath', () => this.copyPath());
		} else {
			for (const action of copyPathActions) {
				this.addNativeAction(action, this.actionsEl, 0);
			}
		}

		this.actionsEl.createDiv({ cls: 'version-file-actions-separator' });
		if (versionHistoryActions.length > 0) {
			for (const action of versionHistoryActions) {
				this.addNativeAction(action, this.actionsEl, 0);
			}
		} else if (canOpenFileRecoveryHistory(this.app)) {
			this.addAction('actions.versionHistory', () => {
				if (!openFileRecoveryHistory(this.app, this.selected.file)) {
					new Notice(this.i18n.t('actions.failed', {
						message: this.i18n.t('actions.versionHistoryUnavailable'),
					}));
				}
			});
		}
		if (Platform.isDesktopApp && this.app.vault.adapter instanceof FileSystemAdapter) {
			this.actionsEl.createDiv({ cls: 'version-file-actions-separator' });
			this.addAction('actions.defaultApp', () =>
				this.openWithDefaultApp());
			this.addAction('actions.reveal', () =>
				this.revealInSystem());
		}

		this.actionsEl.createDiv({ cls: 'version-file-actions-separator' });
		this.addAction(
			this.selected.version === 1 ? 'view.renameTheme' : 'actions.rename',
			() => this.renameSelected(),
		);
		this.addAction('actions.manage', () => {
			const file = this.selected.file;
			this.close();
			this.onManage(file);
		});
		// This is intentionally a batch entry point rather than an exact-version
		// delete command. The next dialog excludes V1 and explains how to replace
		// the representative before its real file can leave the relationship.
		this.addAction('actions.delete', () => {
			const file = this.selected.file;
			this.close();
			this.onDelete(file);
		}, true);
	}

	private addNativeAction(
		action: NativeFileAction,
		container: HTMLElement,
		depth: number,
	): void {
		const wrapper = container.createDiv({
			cls: `version-native-file-action${depth > 0 ? ' is-child' : ''}`,
		});
		const button = wrapper.createEl('button', {
			cls: `version-file-action${action.warning ? ' is-warning' : ''}`,
			attr: { type: 'button' },
		});
		button.createSpan({
			cls: 'version-native-file-action-title',
			text: action.title,
		});
		button.disabled = action.disabled;
		if (depth > 0) {
			button.setAttribute('role', 'menuitem');
		}

		if (action.children.length === 0) {
			button.addEventListener('click', (event) => {
				void this.runNativeAction(action, event);
			});
			return;
		}

		button.setAttribute('aria-haspopup', 'menu');
		button.setAttribute('aria-expanded', 'false');
		button.createSpan({
			cls: 'version-native-file-action-chevron',
			text: '›',
		});
		const children = this.modalEl.ownerDocument.body.createDiv({
			cls: 'version-native-file-action-flyout',
		});
		children.setAttribute('role', 'menu');
		children.hidden = true;
		for (const child of action.children) {
			this.addNativeAction(child, children, depth + 1);
		}
		const getChildButtons = (): HTMLButtonElement[] =>
			Array.from(children.querySelectorAll<HTMLButtonElement>(
				'.version-file-action:not(:disabled)',
			));
		const win = this.modalEl.ownerDocument.defaultView;
		let openTimer: number | null = null;
		let closeTimer: number | null = null;
		const cancelTimer = (timer: number | null): null => {
			if (timer !== null && win) {
				win.clearTimeout(timer);
				this.nativeActionTimerIds.delete(timer);
			}
			return null;
		};
		const setOpen = (open: boolean): void => {
			openTimer = cancelTimer(openTimer);
			closeTimer = cancelTimer(closeTimer);
			if (open) {
				for (const [flyout, entry] of this.nativeActionFlyouts) {
					if (flyout !== children && !flyout.contains(button)) {
						entry.close();
					}
				}
				children.hidden = false;
				this.positionNativeActionFlyout(button, children);
			} else {
				children.hidden = true;
			}
			button.setAttribute('aria-expanded', String(open));
		};
		this.nativeActionFlyouts.set(children, {
			close: () => setOpen(false),
			trigger: button,
		});
		const scheduleOpen = (): void => {
			closeTimer = cancelTimer(closeTimer);
			if (!children.hidden || openTimer !== null || !win) {
				return;
			}
			openTimer = win.setTimeout(() => {
				this.nativeActionTimerIds.delete(openTimer as number);
				openTimer = null;
				setOpen(true);
			}, NATIVE_SUBMENU_OPEN_DELAY_MS);
			this.nativeActionTimerIds.add(openTimer);
		};
		const scheduleClose = (): void => {
			openTimer = cancelTimer(openTimer);
			if (children.hidden || closeTimer !== null || !win) {
				return;
			}
			closeTimer = win.setTimeout(() => {
				this.nativeActionTimerIds.delete(closeTimer as number);
				closeTimer = null;
				setOpen(false);
			}, NATIVE_SUBMENU_CLOSE_DELAY_MS);
			this.nativeActionTimerIds.add(closeTimer);
		};
		const containsFocusTarget = (target: EventTarget | null): boolean =>
			target instanceof Node &&
			(wrapper.contains(target) || children.contains(target));
		button.addEventListener('click', (event) => {
			event.stopPropagation();
			setOpen(children.hidden);
		});
		wrapper.addEventListener('pointerenter', scheduleOpen);
		wrapper.addEventListener('pointerleave', scheduleClose);
		children.addEventListener('pointerenter', () => {
			closeTimer = cancelTimer(closeTimer);
		});
		children.addEventListener('pointerleave', scheduleClose);
		button.addEventListener('keydown', (event) => {
			if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
				event.preventDefault();
				setOpen(true);
				getChildButtons()[0]?.focus();
			} else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
				event.preventDefault();
				setOpen(false);
			}
		});
		children.addEventListener('keydown', (event) => {
			const buttons = getChildButtons();
			const current = buttons.indexOf(event.target as HTMLButtonElement);
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const step = event.key === 'ArrowDown' ? 1 : -1;
				const next = current < 0
					? 0
					: (current + step + buttons.length) % buttons.length;
				buttons[next]?.focus();
			} else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
				event.preventDefault();
				setOpen(false);
				button.focus();
			}
		});
		wrapper.addEventListener('focusout', (event) => {
			if (!containsFocusTarget(event.relatedTarget)) {
				scheduleClose();
			}
		});
		children.addEventListener('focusin', () => {
			closeTimer = cancelTimer(closeTimer);
		});
		children.addEventListener('focusout', (event) => {
			if (!containsFocusTarget(event.relatedTarget)) {
				scheduleClose();
			}
		});
	}

	private positionNativeActionFlyout(
		trigger: HTMLButtonElement,
		flyout: HTMLElement,
	): void {
		const doc = this.modalEl.ownerDocument;
		const viewportWidth = doc.documentElement.clientWidth;
		const viewportHeight = doc.documentElement.clientHeight;
		const gap = 6;
		const viewportPadding = 8;
		flyout.setCssProps({
			left: '0px',
			top: '0px',
			visibility: 'hidden',
		});
		const triggerRect = trigger.getBoundingClientRect();
		const flyoutRect = flyout.getBoundingClientRect();
		let left = triggerRect.right + gap;
		if (left + flyoutRect.width > viewportWidth - viewportPadding) {
			left = Math.max(
				viewportPadding,
				triggerRect.left - flyoutRect.width - gap,
			);
		}
		const top = Math.min(
			Math.max(viewportPadding, triggerRect.top),
			Math.max(
				viewportPadding,
				viewportHeight - flyoutRect.height - viewportPadding,
			),
		);
		flyout.setCssProps({
			left: `${left}px`,
			top: `${top}px`,
			visibility: '',
		});
	}

	private closeNativeActionFlyouts(): void {
		for (const entry of this.nativeActionFlyouts.values()) {
			entry.close();
		}
	}

	private destroyNativeActionFlyouts(): void {
		const win = this.modalEl.ownerDocument.defaultView;
		for (const timer of this.nativeActionTimerIds) {
			win?.clearTimeout(timer);
		}
		this.nativeActionTimerIds.clear();
		for (const [flyout, entry] of this.nativeActionFlyouts) {
			entry.close();
			flyout.remove();
		}
		this.nativeActionFlyouts.clear();
	}

	private async runNativeAction(
		action: NativeFileAction,
		event: MouseEvent | KeyboardEvent,
	): Promise<void> {
		if (!action.run || action.disabled) {
			return;
		}
		try {
			this.close();
			await Promise.resolve(action.run(event));
		} catch (error) {
			new Notice(this.i18n.t('actions.failed', {
				message: getErrorMessage(error),
			}));
		}
	}

	private addAction(
		key: ActionTranslationKey,
		onClick: () => void | Promise<void>,
		warning = false,
	): void {
		const button = this.actionsEl.createEl('button', {
			cls: `version-file-action${warning ? ' is-warning' : ''}`,
			attr: { type: 'button' },
		});
		button.createSpan({ text: this.i18n.t(key) });
		button.addEventListener('click', () => void onClick());
	}

	private async openSelected(
		leaf: false | 'split' | 'tab' | 'window',
	): Promise<void> {
		await this.app.workspace.getLeaf(leaf).openFile(this.selected.file, {
			active: true,
		});
		this.close();
	}

	private async duplicateSelected(): Promise<void> {
		try {
			const path = findCopyPath(this.app, this.selected.file);
			const markdown = await this.app.vault.cachedRead(this.selected.file);
			const copy = await this.app.vault.create(path, markdown);
			new Notice(this.i18n.t('actions.duplicated', { path: copy.path }));
			await this.app.workspace.getLeaf('tab').openFile(copy, { active: true });
		} catch (error) {
			new Notice(this.i18n.t('actions.failed', {
				message: getErrorMessage(error),
			}));
		}
	}

	private moveSelected(): void {
		new MoveSingleVersionModal(
			this.app,
			this.selected.file,
			() => this.close(),
			this.i18n,
		).open();
	}

	private renameSelected(): void {
		new RenameVersionFileModal(
			this.app,
			this.selected.file,
			this.selected.version === 1,
			() => this.close(),
			this.i18n,
		).open();
	}

	private async copyPath(): Promise<void> {
		try {
			const clipboard = this.modalEl.win.navigator.clipboard;
			await clipboard.writeText(this.selected.file.path);
			new Notice(this.i18n.t('actions.pathCopied'));
		} catch (error) {
			new Notice(this.i18n.t('actions.failed', {
				message: getErrorMessage(error),
			}));
		}
	}

	private async openWithDefaultApp(): Promise<void> {
		try {
			const path = this.requireSystemPath();
			const error = await getElectronShell().openPath(path);
			if (error) {
				throw new Error(error);
			}
		} catch (error) {
			new Notice(this.i18n.t('actions.failed', {
				message: getErrorMessage(error),
			}));
		}
	}

	private revealInSystem(): void {
		try {
			const path = this.requireSystemPath();
			getElectronShell().showItemInFolder(path);
		} catch (error) {
			new Notice(this.i18n.t('actions.failed', {
				message: getErrorMessage(error),
			}));
		}
	}

	private requireSystemPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('A local filesystem path is not available.');
		}
		return adapter.getFullPath(this.selected.file.path);
	}
}

class RenameVersionFileModal extends Modal {
	private name: string;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly renameTopic: boolean,
		private readonly onRenamed: () => void,
		private readonly i18n: VersionI18n,
	) {
		super(app);
		this.name = file.basename;
	}

	onOpen(): void {
		this.setTitle(this.i18n.t(
			this.renameTopic ? 'view.renameTheme' : 'actions.renameTitle',
		));
		new Setting(this.contentEl)
			.setName(this.i18n.t('actions.filename'))
			.addText((text) => text
				.setValue(this.name)
				.onChange((value) => {
					this.name = value;
				}));
		new Setting(this.contentEl)
			.addButton((button) => button
				.setButtonText(this.i18n.t('common.cancel'))
				.onClick(() => this.close()))
			.addButton((button) => button
				.setButtonText(this.i18n.t(
					this.renameTopic ? 'view.renameTheme' : 'actions.rename',
				))
				.setCta()
				.onClick(() => void this.submit()));
	}

	private async submit(): Promise<void> {
		const name = this.name.trim();
		if (!name || /[/\\\n\r]/u.test(name)) {
			new Notice(this.i18n.t('create.invalidFilename'));
			return;
		}
		const folder = this.file.parent?.isRoot() ? '' : this.file.parent?.path ?? '';
		const extension = this.file.extension ? `.${this.file.extension}` : '';
		const path = normalizePath(
			folder ? `${folder}/${name}${extension}` : `${name}${extension}`,
		);
		if (path !== this.file.path && this.app.vault.getAbstractFileByPath(path)) {
			new Notice(this.i18n.t('view.createExists', { path }));
			return;
		}
		try {
			await this.app.fileManager.renameFile(this.file, path);
			this.onRenamed();
			this.close();
		} catch (error) {
			new Notice(this.i18n.t('actions.failed', {
				message: getErrorMessage(error),
			}));
		}
	}
}

class MoveSingleVersionModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly file: TFile,
		private readonly onMoved: () => void,
		private readonly i18n: VersionI18n,
	) {
		super(app);
		this.setPlaceholder(this.i18n.t('actions.movePlaceholder', {
			name: file.basename,
		}));
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(true);
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot() ? this.i18n.t('move.vaultRoot') : folder.path;
	}

	renderSuggestion(match: FuzzyMatch<TFolder>, el: HTMLElement): void {
		el.createDiv({ text: this.getItemText(match.item) });
	}

	onChooseItem(folder: TFolder): void {
		void this.move(folder);
	}

	private async move(folder: TFolder): Promise<void> {
		const destination = folder.isRoot() ? '' : folder.path;
		const path = normalizePath(
			destination ? `${destination}/${this.file.name}` : this.file.name,
		);
		if (path === this.file.path) {
			return;
		}
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(this.i18n.t('view.createExists', { path }));
			return;
		}
		try {
			await this.app.fileManager.renameFile(this.file, path);
			this.onMoved();
		} catch (error) {
			new Notice(this.i18n.t('actions.failed', {
				message: getErrorMessage(error),
			}));
		}
	}
}

type ActionTranslationKey =
	| 'actions.copyPath'
	| 'actions.defaultApp'
	| 'actions.delete'
	| 'actions.duplicate'
	| 'actions.manage'
	| 'actions.move'
	| 'actions.moveSeries'
	| 'actions.open'
	| 'actions.openNewTab'
	| 'actions.openSplit'
	| 'actions.openWindow'
	| 'actions.rename'
	| 'actions.reveal'
	| 'actions.versionHistory'
	| 'merge.action'
	| 'view.renameTheme';

function isVersionHistoryAction(action: NativeFileAction): boolean {
	const title = action.title.normalize('NFKC').toLocaleLowerCase();
	return /version history|版本历史|バージョン履歴|versionshistorik/iu.test(title);
}

function isCopyPathAction(action: NativeFileAction): boolean {
	const title = action.title.normalize('NFKC').toLocaleLowerCase();
	if (action.children.length > 0) {
		return /copy path|复制路径|パスをコピー|kopiér sti|kopier sti/iu.test(title);
	}
	// Obsidian 1.13 can flatten the three Copy path submenu entries in a
	// programmatically collected Menu. Any of them proves that native path
	// variants are present, so do not add Version's one-value fallback too.
	return /obsidian url|vault.*relative path|absolute path|库.*相对路径|绝对路径|保管庫.*相対.*パス|絶対.*パス|relativ.*sti|absolut.*sti/iu.test(title);
}

function findCopyPath(app: App, file: TFile): string {
	const folder = file.parent?.isRoot() ? '' : file.parent?.path ?? '';
	let suffix = 1;
	while (true) {
		const name = buildCopyFilename(file, suffix);
		const path = normalizePath(folder ? `${folder}/${name}` : name);
		if (!app.vault.getAbstractFileByPath(path)) {
			return path;
		}
		suffix += 1;
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getElectronShell(): typeof import('electron').shell {
	// Electron's renderer module is exposed through CommonJS in Obsidian desktop.
	// Loading it only when a desktop action runs keeps the plugin loadable on mobile.
	// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Obsidian exposes Electron through CommonJS only in its desktop renderer.
	const electron = require('electron') as typeof import('electron');
	return electron.shell;
}
