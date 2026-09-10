import { App } from 'obsidian';
import { VersionI18n } from '../i18n';
import {
	getOverallVersion,
	VersionGroup,
	VersionIndex,
} from '../version-index';

const FILE_EXPLORER_CONTAINER_SELECTOR = '.nav-files-container';
const FILE_TITLE_SELECTOR = '.nav-file-title';

/**
 * Desktop currently stores the path on the title itself. The mobile drawer can
 * mount the same title with the path on its owning row while it is being
 * virtualized, so accept either DOM shape without deriving anything from the
 * displayed filename.
 */
export function getFileExplorerTitlePath(titleEl: HTMLElement): string | null {
	return titleEl.dataset.path ??
		titleEl.closest<HTMLElement>('.nav-file[data-path]')?.dataset.path ??
		null;
}

/**
 * File Explorer has no public API for hiding individual rows or adding a badge.
 * Keep all DOM compatibility work isolated here. Genuinely invalid or
 * unresolved registry groups fail open, but a healthy group's visibility must
 * not depend on whether its representative row is currently mounted (for
 * example, while the V1 parent folder is collapsed).
 */
export interface FileExplorerVisibilityPlan {
	hiddenPaths: string[];
	representativePath: string;
}

export function buildFileExplorerVisibilityPlan(
	group: VersionGroup,
): FileExplorerVisibilityPlan | null {
	// This plan changes only mounted File Explorer rows. A healthy group whose
	// identities resolve through the narrow cross-device compatibility rule can
	// therefore use its complete registry paths here; mutation workflows remain
	// gated by isVersionGroupExactlyResolved at their own call sites.
	if (group.status !== 'healthy') {
		return null;
	}

	const representative = getOverallVersion(group);
	if (!representative) {
		return null;
	}

	return {
		hiddenPaths: group.versions
			.filter((versionFile) => versionFile.path !== representative.path)
			.map((versionFile) => versionFile.path),
		representativePath: representative.path,
	};
}

export class FileExplorerDecorator {
	private destroyed = false;
	private discoveryObserver: MutationObserver | null = null;
	private discoveryRoot: HTMLElement | null = null;
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
		this.observeWorkspaceForExplorerRoots();
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
		this.discoveryObserver?.disconnect();
		this.discoveryObserver = null;
		this.discoveryRoot = null;
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
		const roots = new Set(
			this.app.workspace
				.getLeavesOfType('file-explorer')
				.map((leaf) => leaf.view.containerEl),
		);
		const workspaceRoot = this.app.workspace.containerEl;
		if (!workspaceRoot) {
			return [...roots];
		}

		// On mobile the drawer may mount its File Explorer content before (or
		// without) getLeavesOfType exposing a live leaf. Discover the narrowly
		// scoped native container as a fallback and avoid decorating it twice
		// when a normal leaf root already owns it.
		for (const container of workspaceRoot.querySelectorAll<HTMLElement>(
			FILE_EXPLORER_CONTAINER_SELECTOR,
		)) {
			if (![...roots].some((root) => root.contains(container))) {
				roots.add(container);
			}
		}
		return [...roots];
	}

	private decorateRoot(root: HTMLElement): void {
		const titlesByPath = new Map<string, HTMLElement>();

		for (const element of root.querySelectorAll<HTMLElement>(FILE_TITLE_SELECTOR)) {
			const path = getFileExplorerTitlePath(element);
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
		const visibility = buildFileExplorerVisibilityPlan(group);
		if (!visibility) {
			return;
		}

		for (const hiddenPath of visibility.hiddenPaths) {
			const titleEl = titlesByPath.get(hiddenPath);
			if (!titleEl) {
				continue;
			}
			const row = titleEl.closest<HTMLElement>('.nav-file');
			if (!row) {
				continue;
			}
			row.addClass('version-file-hidden');
		}

		const v1Title = titlesByPath.get(visibility.representativePath);
		if (!v1Title) {
			return;
		}

		v1Title.addClass('version-theme-entry');
		const activeFile = this.app.workspace.getActiveFile();
		const activeGroup = activeFile
			? this.index.getGroupForFile(activeFile)
			: null;
		if (
			activeFile?.path !== visibility.representativePath &&
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
				getFileExplorerTitlePath(title) !== activePath
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
		observer.observe(root, {
			attributeFilter: ['data-path'],
			attributes: true,
			childList: true,
			subtree: true,
		});
		this.observers.set(root, observer);
	}

	private observeWorkspaceForExplorerRoots(): void {
		const root = this.app.workspace.containerEl;
		if (!root || this.discoveryRoot === root) {
			return;
		}

		this.discoveryObserver?.disconnect();
		this.discoveryObserver = null;
		this.discoveryRoot = root;
		const Observer = root.ownerDocument.defaultView?.MutationObserver;
		if (!Observer) {
			return;
		}

		this.discoveryObserver = new Observer((records) => {
			for (const record of records) {
				for (const node of [...record.addedNodes, ...record.removedNodes]) {
					if (this.containsFileExplorerMarkup(node)) {
						this.queueRefresh();
						return;
					}
				}
			}
		});
		this.discoveryObserver.observe(root, {
			childList: true,
			subtree: true,
		});
	}

	private containsFileExplorerMarkup(node: Node): boolean {
		if (!node.instanceOf(HTMLElement)) {
			return false;
		}
		return (
			node.matches(FILE_EXPLORER_CONTAINER_SELECTOR) ||
			node.matches(FILE_TITLE_SELECTOR) ||
			Boolean(node.querySelector(
				`${FILE_EXPLORER_CONTAINER_SELECTOR}, ${FILE_TITLE_SELECTOR}`,
			))
		);
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
