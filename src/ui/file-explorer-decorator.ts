import { App } from 'obsidian';
import { VersionI18n } from '../i18n';
import {
	getOverallVersion,
	VersionGroup,
	VersionIndex,
} from '../version-index';

const FILE_TITLE_SELECTOR = '.nav-file-title[data-path]';

/**
 * File Explorer has no public API for hiding individual rows or adding a badge.
 * Keep all DOM compatibility work isolated here and always fail open: if the
 * V1 row or a healthy series cannot be resolved, no member row is hidden.
 */
export class FileExplorerDecorator {
	private destroyed = false;
	private readonly observers = new Map<HTMLElement, MutationObserver>();
	private refreshFrame: number | null = null;
	private refreshQueued = false;

	constructor(
		private readonly app: App,
		private readonly index: VersionIndex,
		private readonly i18n: VersionI18n,
	) {}

	refresh(): void {
		if (this.destroyed) {
			return;
		}
		for (const observer of this.observers.values()) {
			observer.disconnect();
		}
		this.observers.clear();

		for (const root of this.getRoots()) {
			this.clearRoot(root);
			this.decorateRoot(root);
			this.observeRoot(root);
		}
	}

	destroy(): void {
		this.destroyed = true;
		if (this.refreshFrame !== null) {
			window.cancelAnimationFrame(this.refreshFrame);
			this.refreshFrame = null;
		}
		this.refreshQueued = false;
		for (const observer of this.observers.values()) {
			observer.disconnect();
		}
		this.observers.clear();

		for (const root of this.getRoots()) {
			this.clearRoot(root);
		}
	}

	private getRoots(): HTMLElement[] {
		return this.app.workspace
			.getLeavesOfType('file-explorer')
			.map((leaf) => leaf.view.containerEl);
	}

	private decorateRoot(root: HTMLElement): void {
		const titlesByPath = new Map<string, HTMLElement>();

		for (const element of root.querySelectorAll(FILE_TITLE_SELECTOR)) {
			if (!element.instanceOf(HTMLElement)) {
				continue;
			}

			const path = element.dataset.path;
			if (path) {
				titlesByPath.set(path, element);
			}
		}

		for (const group of this.index.getGroups()) {
			this.decorateGroup(group, titlesByPath);
		}
	}

	private decorateGroup(
		group: VersionGroup,
		titlesByPath: Map<string, HTMLElement>,
	): void {
		const v1 = getOverallVersion(group);
		if (!v1) {
			return;
		}

		const v1Title = titlesByPath.get(v1.path);
		if (!v1Title) {
			return;
		}

		for (const versionFile of group.versions) {
			if (versionFile.path === v1.path) {
				continue;
			}
			const titleEl = titlesByPath.get(versionFile.path);
			if (!titleEl) {
				continue;
			}
			const row = titleEl.closest<HTMLElement>('.nav-file');
			if (!row) {
				continue;
			}
			row.addClass('version-file-hidden');
		}

		v1Title.addClass('version-theme-entry');
		const activeFile = this.app.workspace.getActiveFile();
		const activeGroup = activeFile
			? this.index.getGroupForFile(activeFile)
			: null;
		if (
			activeFile?.path !== v1.path &&
			activeGroup?.key === group.key
		) {
			// Obsidian marks the real active member row with `is-active`. V2+
			// rows are intentionally hidden, so mirror that native state onto
			// the visible V1 representative without changing file identity.
			v1Title.addClass('is-active', 'version-theme-active');
		}
		const badge = v1Title.createSpan({
			cls: 'version-count-badge',
			text: String(group.versions.length),
		});
		badge.setAttribute(
			'aria-label',
			this.i18n.t('fileExplorer.countAria', {
				count: group.versions.length,
				unit: this.i18n.t(
					group.versions.length === 1
						? 'common.version'
						: 'common.versions',
				),
			}),
		);
	}

	private clearRoot(root: HTMLElement): void {
		const activePath = this.app.workspace.getActiveFile()?.path;
		for (const title of root.querySelectorAll('.version-theme-active')) {
			title.removeClass('version-theme-active');
			if (
				title.instanceOf(HTMLElement) &&
				title.dataset.path !== activePath
			) {
				title.removeClass('is-active');
			}
		}

		for (const hidden of root.querySelectorAll('.version-file-hidden')) {
			hidden.removeClass('version-file-hidden');
		}

		for (const title of root.querySelectorAll('.version-theme-entry')) {
			title.querySelector('.version-count-badge')?.remove();
			title.removeClass('version-theme-entry');
		}
	}

	private observeRoot(root: HTMLElement): void {
		const Observer = root.ownerDocument.defaultView?.MutationObserver;
		if (!Observer) {
			return;
		}

		const observer = new Observer(() => this.queueRefresh());
		observer.observe(root, { childList: true, subtree: true });
		this.observers.set(root, observer);
	}

	private queueRefresh(): void {
		if (this.destroyed || this.refreshQueued) {
			return;
		}

		this.refreshQueued = true;
		this.refreshFrame = window.requestAnimationFrame(() => {
			this.refreshFrame = null;
			this.refreshQueued = false;
			if (!this.destroyed) {
				this.refresh();
			}
		});
	}

}
