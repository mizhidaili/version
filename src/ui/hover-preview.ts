import { App, TFile } from 'obsidian';
import { VersionI18n } from '../i18n';
import { VersionNotePreview } from './note-preview';

type PreviewRequest =
	| { file: TFile; kind: 'file'; label: string }
	| { kind: 'placeholder'; label: string; message: string };

interface PreviewEntry {
	anchorEl: HTMLElement;
	containerEl: HTMLElement;
	preview: VersionNotePreview;
}

const SHOW_DELAY_MS = 650;
const HIDE_DELAY_MS = 160;
const VIEWPORT_MARGIN = 16;
const ANCHOR_GAP = 12;

export class VersionHoverPreview {
	private entry: PreviewEntry | null = null;
	private hideTimer: number | null = null;
	private showTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly document: Document,
		private readonly i18n: VersionI18n,
	) {}

	scheduleFile(
		file: TFile,
		anchorEl: HTMLElement,
		label = file.basename,
		_event: MouseEvent | null = null,
	): void {
		this.schedule({ file, kind: 'file', label }, anchorEl);
	}

	schedulePlaceholder(
		label: string,
		message: string,
		anchorEl: HTMLElement,
	): void {
		this.schedule({ kind: 'placeholder', label, message }, anchorEl);
	}

	scheduleHide(): void {
		this.clearShowTimer();
		this.clearHideTimer();
		const win = this.document.defaultView;
		if (!win) {
			this.hideNow();
			return;
		}
		this.hideTimer = win.setTimeout(() => this.hideIfDetached(), HIDE_DELAY_MS);
	}

	hideNow(): void {
		this.clearShowTimer();
		this.clearHideTimer();
		this.entry?.preview.unload();
		this.entry?.containerEl.remove();
		this.entry = null;
	}

	destroy(): void {
		this.hideNow();
	}

	private schedule(request: PreviewRequest, anchorEl: HTMLElement): void {
		this.clearShowTimer();
		if (this.entry?.anchorEl === anchorEl) {
			this.clearHideTimer();
			return;
		}
		this.hideNow();
		const win = this.document.defaultView;
		if (!win) {
			return;
		}
		this.showTimer = win.setTimeout(() => {
			this.showTimer = null;
			void this.show(request, anchorEl);
		}, SHOW_DELAY_MS);
	}

	private async show(request: PreviewRequest, anchorEl: HTMLElement): Promise<void> {
		if (!anchorEl.isConnected) {
			return;
		}
		const container = this.document.body.createDiv({
			cls: 'version-hover-preview popover hover-popover',
		});
		container.addEventListener('pointerenter', () => this.clearHideTimer());
		container.addEventListener('pointerleave', () => this.scheduleHide());

		const preview = new VersionNotePreview(this.app, container, this.i18n);
		preview.load();
		const entry = { anchorEl, containerEl: container, preview };
		this.entry = entry;
		this.position(container, anchorEl);

		if (request.kind === 'file') {
			await preview.show(request.file, request.label);
		} else {
			preview.showPlaceholder(request.label, request.message);
		}
		if (this.entry === entry) {
			this.position(container, anchorEl);
		}
	}

	private position(
		container: HTMLElement,
		anchorEl: HTMLElement,
	): void {
		const win = this.document.defaultView;
		if (!win) {
			return;
		}
		const anchor = anchorEl.getBoundingClientRect();
		const preview = container.getBoundingClientRect();
		const width = preview.width || Math.min(480, win.innerWidth - VIEWPORT_MARGIN * 2);
		const height = preview.height || Math.min(440, win.innerHeight - VIEWPORT_MARGIN * 2);
		const roomRight = win.innerWidth - anchor.right;
		const roomLeft = anchor.left;
		const placeRight = roomRight >= width + ANCHOR_GAP || roomRight >= roomLeft;
		let left = placeRight
			? anchor.right + ANCHOR_GAP
			: anchor.left - width - ANCHOR_GAP;
		left = Math.max(
			VIEWPORT_MARGIN,
			Math.min(left, win.innerWidth - width - VIEWPORT_MARGIN),
		);
		const top = Math.max(
			VIEWPORT_MARGIN,
			Math.min(
				anchor.top - 18,
				win.innerHeight - height - VIEWPORT_MARGIN,
			),
		);
		container.style.left = `${Math.round(left)}px`;
		container.style.top = `${Math.round(top)}px`;
	}

	private clearShowTimer(): void {
		if (this.showTimer === null) {
			return;
		}
		this.document.defaultView?.clearTimeout(this.showTimer);
		this.showTimer = null;
	}

	private hideIfDetached(): void {
		this.hideTimer = null;
		if (this.entry?.preview.hasActiveNestedPreview()) {
			const win = this.document.defaultView;
			if (win) {
				this.hideTimer = win.setTimeout(
					() => this.hideIfDetached(),
					HIDE_DELAY_MS,
				);
			}
			return;
		}
		this.hideNow();
	}

	private clearHideTimer(): void {
		if (this.hideTimer === null) {
			return;
		}
		this.document.defaultView?.clearTimeout(this.hideTimer);
		this.hideTimer = null;
	}
}
