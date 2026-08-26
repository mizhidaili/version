import { App, Modal, Notice, TFile } from 'obsidian';
import { VersionI18n } from '../i18n';
import { VersionGroup } from '../version-index';
import { VersionHoverPreview } from './hover-preview';

export interface RegisteredBacklinkTarget {
	path: string;
	version: number;
}

export interface ThemeBacklinkTarget {
	count: number;
	version: number;
}

export interface ThemeBacklink {
	count: number;
	source: TFile;
	targets: ThemeBacklinkTarget[];
}

export class ThemeBacklinksModal extends Modal {
	private hoverPreview: VersionHoverPreview | null = null;
	constructor(
		app: App,
		private readonly group: VersionGroup,
		private readonly i18n: VersionI18n,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('version-backlinks-modal');
		this.contentEl.empty();
		this.contentEl.createEl('h3', {
			text: this.i18n.t('backlinks.title', {
				topic: this.group.topic,
			}),
		});

		const backlinks = collectThemeBacklinks(this.app, this.group);
		if (backlinks.length === 0) {
			this.contentEl.createEl('p', {
				text: this.i18n.t('backlinks.empty'),
			});
			return;
		}

		const layout = this.contentEl.createDiv({
			cls: 'version-backlinks-layout',
		});
		const list = layout.createEl('ul', {
			cls: 'version-backlinks-list',
		});
		this.hoverPreview = new VersionHoverPreview(
			this.app,
			this.modalEl.ownerDocument,
			this.i18n,
		);

		for (const backlink of backlinks) {
			const item = list.createEl('li');
			const button = item.createEl('button');
			button.type = 'button';
			const nameEl = button.createSpan({
				cls: 'version-backlinks-name',
			});
			nameEl.createSpan({
				cls: 'version-backlinks-source',
				text: backlink.source.basename,
			});
			nameEl.createSpan({
				cls: 'version-backlinks-targets',
				text: formatBacklinkTargets(backlink.targets),
			});
			button.createSpan({
				cls: 'version-backlinks-count',
				text: String(backlink.count),
			});
			nameEl.addEventListener('pointerenter', (event) => {
				this.hoverPreview?.scheduleFile(
					backlink.source,
					nameEl,
					backlink.source.basename,
					event,
				);
			});
			nameEl.addEventListener('pointerleave', () =>
				this.hoverPreview?.scheduleHide());
			button.addEventListener('click', () => {
				void this.openSource(backlink.source);
			});
		}
	}

	onClose(): void {
		this.hoverPreview?.destroy();
		this.hoverPreview = null;
		this.contentEl.empty();
	}

	private async openSource(source: TFile): Promise<void> {
		try {
			this.close();
			await this.app.workspace.getLeaf(false).openFile(source, {
				active: true,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(this.i18n.t('backlinks.openFailed', { message }));
		}
	}
}

export function collectThemeBacklinks(
	app: App,
	group: VersionGroup,
): ThemeBacklink[] {
	const registeredTargets = group.versions.map((versionFile) => ({
		path: versionFile.path,
		version: versionFile.version,
	}));
	const backlinks: ThemeBacklink[] = [];

	for (const [sourcePath, destinations] of Object.entries(
		app.metadataCache.resolvedLinks,
	)) {
		const targets = collectBacklinkTargets(destinations, registeredTargets);
		const count = targets.reduce((total, target) => total + target.count, 0);

		if (count === 0) {
			continue;
		}

		const source = app.vault.getAbstractFileByPath(sourcePath);
		if (source instanceof TFile) {
			backlinks.push({ count, source, targets });
		}
	}

	return backlinks.sort((left, right) =>
		left.source.path.localeCompare(right.source.path),
	);
}

export function collectBacklinkTargets(
	destinations: Readonly<Record<string, number>>,
	registeredTargets: readonly RegisteredBacklinkTarget[],
): ThemeBacklinkTarget[] {
	return registeredTargets
		.map((target) => ({
			count: destinations[target.path] ?? 0,
			version: target.version,
		}))
		.filter((target) => target.count > 0)
		.sort((left, right) => left.version - right.version);
}

export function formatBacklinkTargets(
	targets: readonly ThemeBacklinkTarget[],
): string {
	return targets
		.map((target) =>
			target.count > 1
				? `V${target.version} × ${target.count}`
				: `V${target.version}`,
		)
		.join(' · ');
}
