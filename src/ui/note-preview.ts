import {
	App,
	Component,
	getLinkpath,
	MarkdownRenderer,
	Notice,
	setIcon,
	TFile,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import { isMarkdownVersionFile } from '../version-file-types';

interface NestedPreviewEntry {
	anchorEl: HTMLElement;
	containerEl: HTMLElement;
	preview: VersionNotePreview;
}

const NESTED_SHOW_DELAY_MS = 300;
const NESTED_HIDE_DELAY_MS = 160;
const PREVIEW_MARGIN = 16;
const PREVIEW_GAP = 12;

export class VersionNotePreview extends Component {
	private readonly bodyEl: HTMLElement;
	private readonly openButton: HTMLButtonElement;
	private readonly titleEl: HTMLElement;
	private renderComponent = new Component();
	private renderToken = 0;
	private currentFile: TFile | null = null;
	private nestedEntry: NestedPreviewEntry | null = null;
	private nestedHideTimer: number | null = null;
	private nestedShowTimer: number | null = null;

	constructor(
		private readonly app: App,
		containerEl: HTMLElement,
		private readonly i18n: VersionI18n,
	) {
		super();
		const card = containerEl.createDiv({
			cls: 'version-note-preview-card',
		});
		const header = card.createDiv({ cls: 'version-note-preview-header' });
		this.titleEl = header.createDiv({ cls: 'version-note-preview-title' });
		this.openButton = header.createEl('button', {
			cls: 'clickable-icon version-note-preview-open',
			attr: {
				'aria-label': this.i18n.t('preview.open'),
				type: 'button',
			},
		});
		setIcon(this.openButton, 'expand');
		this.openButton.addEventListener('click', () => {
			if (this.currentFile) {
				void this.openFile(this.currentFile);
			}
		});
		this.bodyEl = card.createDiv({ cls: 'version-note-preview-body' });
	}

	onload(): void {
		this.renderComponent.load();
	}

	onunload(): void {
		this.renderToken += 1;
		this.destroyNestedPreview();
		this.renderComponent.unload();
	}

	async show(file: TFile, label = file.basename): Promise<void> {
		const token = ++this.renderToken;
		this.destroyNestedPreview();
		this.currentFile = file;
		this.openButton.disabled = false;
		this.titleEl.setText(label);
		this.bodyEl.empty();
		this.bodyEl.createDiv({
			cls: 'version-note-preview-loading',
			text: this.i18n.t('preview.loading'),
		});

		const source = await this.app.vault.cachedRead(file);
		if (token !== this.renderToken) {
			return;
		}

		this.renderComponent.unload();
		this.renderComponent = new Component();
		this.renderComponent.load();
		this.bodyEl.empty();

		if (!source.trim()) {
			this.bodyEl.createDiv({
				cls: 'version-note-preview-empty',
				text: this.i18n.t('link.emptyVersion'),
			});
			return;
		}

		if (
			file.extension.toLocaleLowerCase() === 'canvas' ||
			file.extension.toLocaleLowerCase() === 'excalidraw' ||
			file.name.toLocaleLowerCase().endsWith('.excalidraw.md')
		) {
			const link = this.app.fileManager.generateMarkdownLink(file, '');
			await this.renderMarkdown(file, `!${link}`, '');
			return;
		}

		if (!isMarkdownVersionFile(file)) {
			this.bodyEl.createDiv({
				cls: 'version-note-preview-empty',
				text: this.i18n.t('preview.openVisual'),
			});
			return;
		}

		await this.renderMarkdown(file, source);
	}

	private async renderMarkdown(
		file: TFile,
		markdown: string,
		sourcePath = file.path,
	): Promise<void> {
		const rendered = this.bodyEl.createDiv({
			cls: ['markdown-preview-view', 'markdown-rendered'],
		});
		await MarkdownRenderer.render(
			this.app,
			markdown,
			rendered,
			sourcePath,
			this.renderComponent,
		);
		for (const target of rendered.querySelectorAll<HTMLElement>('a.internal-link')) {
			const linktext = target.dataset.href ?? target.getAttribute('href');
			if (!linktext) {
				continue;
			}
			this.renderComponent.registerDomEvent(target, 'mouseenter', () =>
				this.scheduleNestedPreview(target, linktext, file),
			);
			this.renderComponent.registerDomEvent(target, 'mouseleave', () =>
				this.scheduleNestedHide(),
			);
		}
	}

	hasActiveNestedPreview(): boolean {
		return Boolean(
			this.nestedEntry?.containerEl.isConnected ||
			this.nestedEntry?.preview.hasActiveNestedPreview(),
		);
	}

	private scheduleNestedPreview(
		targetEl: HTMLElement,
		linktext: string,
		sourceFile: TFile,
	): void {
		this.clearNestedShowTimer();
		this.clearNestedHideTimer();
		if (this.nestedEntry?.anchorEl === targetEl) {
			return;
		}
		this.destroyNestedPreview();
		const win = targetEl.ownerDocument.defaultView;
		if (!win) {
			return;
		}
		this.nestedShowTimer = win.setTimeout(() => {
			this.nestedShowTimer = null;
			void this.openNestedPreview(targetEl, linktext, sourceFile);
		}, NESTED_SHOW_DELAY_MS);
	}

	private async openNestedPreview(
		targetEl: HTMLElement,
		linktext: string,
		sourceFile: TFile,
	): Promise<void> {
		if (!targetEl.isConnected) {
			return;
		}
		const destination = this.app.metadataCache.getFirstLinkpathDest(
			getLinkpath(linktext),
			sourceFile.path,
		);
		if (!destination) {
			return;
		}
		this.destroyNestedPreview();
		const container = targetEl.ownerDocument.body.createDiv({
			cls: 'version-hover-preview popover hover-popover version-nested-hover-preview',
		});
		const childPreview = new VersionNotePreview(
			this.app,
			container,
			this.i18n,
		);
		childPreview.load();
		this.nestedEntry = {
			anchorEl: targetEl,
			containerEl: container,
			preview: childPreview,
		};
		container.addEventListener('pointerenter', () =>
			this.clearNestedHideTimer(),
		);
		container.addEventListener('pointerleave', () =>
			this.scheduleNestedHide(),
		);
		this.positionNestedPreview(container, targetEl);
		await childPreview.show(destination);
		if (this.nestedEntry?.containerEl === container) {
			this.positionNestedPreview(container, targetEl);
		}
	}

	private scheduleNestedHide(): void {
		this.clearNestedShowTimer();
		this.clearNestedHideTimer();
		const win = this.bodyEl.ownerDocument.defaultView;
		if (!win) {
			this.destroyNestedPreview();
			return;
		}
		this.nestedHideTimer = win.setTimeout(
			() => this.hideNestedIfDetached(),
			NESTED_HIDE_DELAY_MS,
		);
	}

	private hideNestedIfDetached(): void {
		this.nestedHideTimer = null;
		if (this.nestedEntry?.preview.hasActiveNestedPreview()) {
			this.scheduleNestedHide();
			return;
		}
		this.destroyNestedPreview();
	}

	private destroyNestedPreview(): void {
		this.clearNestedShowTimer();
		this.clearNestedHideTimer();
		this.nestedEntry?.preview.unload();
		this.nestedEntry?.containerEl.remove();
		this.nestedEntry = null;
	}

	private positionNestedPreview(
		container: HTMLElement,
		anchorEl: HTMLElement,
	): void {
		const win = anchorEl.ownerDocument.defaultView;
		if (!win) {
			return;
		}
		const anchor = anchorEl.getBoundingClientRect();
		const preview = container.getBoundingClientRect();
		const width = preview.width || Math.min(448, win.innerWidth - PREVIEW_MARGIN * 2);
		const height = preview.height || Math.min(368, win.innerHeight - PREVIEW_MARGIN * 2);
		const roomRight = win.innerWidth - anchor.right;
		const roomLeft = anchor.left;
		let left = roomRight >= width + PREVIEW_GAP || roomRight >= roomLeft
			? anchor.right + PREVIEW_GAP
			: anchor.left - width - PREVIEW_GAP;
		left = Math.max(
			PREVIEW_MARGIN,
			Math.min(left, win.innerWidth - width - PREVIEW_MARGIN),
		);
		const top = Math.max(
			PREVIEW_MARGIN,
			Math.min(anchor.top - 18, win.innerHeight - height - PREVIEW_MARGIN),
		);
		container.style.left = `${Math.round(left)}px`;
		container.style.top = `${Math.round(top)}px`;
	}

	private clearNestedShowTimer(): void {
		if (this.nestedShowTimer === null) {
			return;
		}
		this.bodyEl.ownerDocument.defaultView?.clearTimeout(this.nestedShowTimer);
		this.nestedShowTimer = null;
	}

	private clearNestedHideTimer(): void {
		if (this.nestedHideTimer === null) {
			return;
		}
		this.bodyEl.ownerDocument.defaultView?.clearTimeout(this.nestedHideTimer);
		this.nestedHideTimer = null;
	}

	showPlaceholder(label: string, message: string): void {
		this.renderToken += 1;
		this.destroyNestedPreview();
		this.currentFile = null;
		this.openButton.disabled = true;
		this.titleEl.setText(label);
		this.renderComponent.unload();
		this.renderComponent = new Component();
		this.renderComponent.load();
		this.bodyEl.empty();
		this.bodyEl.createDiv({
			cls: 'version-note-preview-empty',
			text: message,
		});
	}

	private async openFile(file: TFile): Promise<void> {
		try {
			await this.app.workspace.getLeaf('tab').openFile(file, {
				active: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(this.i18n.t('preview.openFailed', { message }));
		}
	}
}
