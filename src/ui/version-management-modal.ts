import {
	App,
	Modal,
	normalizePath,
	Notice,
	Scope,
	setIcon,
	TFile,
	TFolder,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import { rollbackCreatedBlankFiles } from '../created-file-rollback';
import { captureFile, CapturedFile } from '../captured-file';
import {
	memberMatchesFile,
	memberRecordFromFile,
	ReleasedVersionDestination,
	VersionMemberRecord,
	VersionSlotRecord,
} from '../version-data';
import { formatVersionFilename, MAX_VERSION } from '../version-index';
import { VersionRegistry } from '../version-registry';
import {
	getVersionableFiles,
} from '../version-file-types';
import { VersionHoverPreview } from './hover-preview';

interface ExistingAssignment {
	file: TFile;
	kind: 'existing';
}

interface MissingAssignment {
	kind: 'missing';
	member: VersionMemberRecord;
}

interface NewAssignment {
	kind: 'new';
	name: string;
}

type DraftAssignment =
	| ExistingAssignment
	| MissingAssignment
	| NewAssignment;

interface DraftSlot {
	assignment: DraftAssignment | null;
	version: number;
}

type DragSource =
	| { file: TFile; kind: 'file' }
	| { kind: 'slot'; version: number };

interface PointerDragCandidate {
	label: string;
	pointerId: number;
	suppressClick: boolean;
	source: DragSource;
	sourceEl: HTMLElement;
	startX: number;
	startY: number;
}

interface FileTreeNode {
	files: TFile[];
	folders: Map<string, FileTreeNode>;
	path: string;
}

interface ReleasedMovePlan {
	file: TFile;
	from: string;
	to: string;
}

interface CurrentSeriesTreeEntry {
	assignment: DraftAssignment | null;
	folder: string;
	label: string;
}

export class VersionManagementModal extends Modal {
	private readonly initialMemberPath: string | null;
	private readonly seriesId: string | null;
	private readonly slots: DraftSlot[];
	private availableEl!: HTMLElement;
	private cancelButton!: HTMLButtonElement;
	private doneButton!: HTMLButtonElement;
	private dragSource: DragSource | null = null;
	private keyboardDragSource: DragSource | null = null;
	private keyboardDragSourceButton: HTMLButtonElement | null = null;
	private keyboardDragSourceEl: HTMLElement | null = null;
	private keyboardDragLabel = '';
	private liveEl!: HTMLElement;
	private liveAnnouncementRaf: number | null = null;
	private suppressDragHandleClickUntil = 0;
	private dragCandidate: PointerDragCandidate | null = null;
	private dragGhost: HTMLElement | null = null;
	private dragPoint = { x: 0, y: 0 };
	private dragRaf: number | null = null;
	private dragScrollRaf: number | null = null;
	private dragSourceEl: HTMLElement | null = null;
	private dragTargetEl: HTMLElement | null = null;
	private filter = '';
	private filterInput!: HTMLInputElement;
	private readonly openFolders = new Set<string>();
	private readonly clearedAssignments = new Map<number, DraftAssignment>();
	private readonly releasedByDeletedVersion = new Set<TFile>();
	private scrollRestoreRaf: number | null = null;
	private hoverPreview!: VersionHoverPreview;
	private readonly currentSeriesFolder: string | null;
	private slotsEl!: HTMLElement;
	private submitting = false;

	constructor(
		app: App,
		private readonly registry: VersionRegistry,
		currentFile: TFile | null,
		private readonly filenameTemplate: string,
		private readonly releasedVersionDestination: ReleasedVersionDestination,
		private readonly i18n: VersionI18n,
		private readonly onSaved: () => void,
		seriesIdOverride: string | null = null,
	) {
		super(app);
		// The parent keeps Modal's native Escape-to-close shortcut. This child
		// scope lets an active keyboard drag consume Escape before it reaches it.
		this.scope = new Scope(this.scope);
		const records = registry.getRecords();
		const indexedGroup = currentFile
			? registry.index.getGroupForFile(currentFile)
			: null;
		const overrideRecord = seriesIdOverride
			? registry.getRecordById(seriesIdOverride)
			: null;
		const matchingRecords = overrideRecord
			? [overrideRecord]
			: indexedGroup
			? records.filter((record) => record.id === indexedGroup.id)
			: currentFile ? records.filter((record) =>
				record.slots.some((slot) => slot.member?.path === currentFile.path),
			) : [];
		const record = matchingRecords.length === 1 ? matchingRecords[0] : null;
		this.initialMemberPath = record && currentFile && record.slots.some((slot) =>
			slot.member && memberMatchesFile(slot.member, currentFile),
		)
			? currentFile.path
			: null;
		this.seriesId = record?.id ?? null;
		const originalV1Path = record?.slots.find(
			(slot) => slot.version === 1,
		)?.member?.path ?? null;
		this.currentSeriesFolder = originalV1Path
			? parentPathFromPath(originalV1Path)
			: null;
		if (this.currentSeriesFolder) {
			addFolderAncestors(this.openFolders, this.currentSeriesFolder);
		}
		this.slots = record
			? buildDraftSlots(this.app, record.slots)
			: [{
				assignment: currentFile
					? { file: currentFile, kind: 'existing' }
					: null,
				version: 1,
			}];
	}

	onOpen(): void {
		this.modalEl.addClass('version-management-modal');
		this.setTitle(this.i18n.t('manage.title'));
		this.hoverPreview = new VersionHoverPreview(
			this.app,
			this.modalEl.doc,
			this.i18n,
		);
		this.liveEl = this.contentEl.createDiv({
			cls: 'version-management-live-region',
			attr: {
				'aria-atomic': 'true',
				'aria-live': 'polite',
				role: 'status',
			},
		});
		this.scope.register([], 'Escape', () => {
			if (!this.keyboardDragSource) {
				return;
			}
			const handle = this.keyboardDragSourceButton;
			this.cancelKeyboardDrag();
			if (handle?.isConnected) {
				handle.focus({ preventScroll: true });
			}
			return false;
		});

		const layout = this.contentEl.createDiv({
			cls: 'version-management-layout',
		});
		this.buildLibraryPanel(layout);
		this.buildVersionBoard(layout);

		const actions = this.contentEl.createDiv({
			cls: 'version-management-actions',
		});
		const actionSpacer = actions.createDiv({
			cls: 'version-management-action-spacer',
		});
		actionSpacer.setAttribute('aria-hidden', 'true');
		this.cancelButton = actions.createEl('button', {
			text: this.i18n.t('common.cancel'),
		});
		this.cancelButton.addEventListener('click', () => this.close());
		this.doneButton = actions.createEl('button', {
			cls: 'mod-cta',
			text: this.i18n.t('manage.done'),
		});
		this.doneButton.addEventListener('click', () => void this.submit());

		this.renderAll();
		this.locateCurrentSeriesInLibrary();
		this.focusInitialMember();
	}

	close(): void {
		if (!this.submitting) {
			super.close();
		}
	}

	onClose(): void {
		this.cancelKeyboardDrag(false);
		this.finishDrag();
		if (this.liveAnnouncementRaf !== null) {
			this.modalEl.win.cancelAnimationFrame(this.liveAnnouncementRaf);
			this.liveAnnouncementRaf = null;
		}
		if (this.scrollRestoreRaf !== null) {
			this.modalEl.win.cancelAnimationFrame(this.scrollRestoreRaf);
			this.scrollRestoreRaf = null;
		}
		this.hoverPreview.destroy();
		this.contentEl.empty();
	}

	private buildLibraryPanel(layout: HTMLElement): void {
		const panel = layout.createDiv({
			cls: 'version-management-panel version-management-library-panel',
		});
		this.filterInput = panel.createEl('input', {
			cls: 'version-management-search',
			attr: {
				'aria-label': this.i18n.t('manage.search'),
				placeholder: this.i18n.t('manage.search'),
				type: 'search',
			},
		});
		this.filterInput.addEventListener('input', () => {
			this.cancelKeyboardDrag(false);
			this.filter = this.filterInput.value.trim().toLocaleLowerCase();
			this.renderAvailable();
		});
		this.availableEl = panel.createDiv({
			cls: 'version-management-available',
		});
		this.availableEl.dataset.versionDrop = 'library';
	}

	private buildVersionBoard(layout: HTMLElement): void {
		const panel = layout.createDiv({
			cls: 'version-management-panel version-management-board-panel',
		});
		this.slotsEl = panel.createDiv({ cls: 'version-management-slots' });
	}

	private renderAll(): void {
		this.cancelKeyboardDrag(false);
		const availableScrollTop = this.availableEl.scrollTop;
		const slotsScrollTop = this.slotsEl.scrollTop;
		this.slots.sort((left, right) => left.version - right.version);
		this.renderAvailable();
		this.renderSlots();
		this.cancelButton.disabled = this.submitting;
		this.doneButton.disabled = this.submitting;
		this.restoreScrollPositions(availableScrollTop, slotsScrollTop);
	}

	private restoreScrollPositions(
		availableScrollTop: number,
		slotsScrollTop: number,
	): void {
		const restore = (): void => {
			this.availableEl.scrollTop = availableScrollTop;
			this.slotsEl.scrollTop = slotsScrollTop;
		};
		restore();
		if (this.scrollRestoreRaf !== null) {
			this.modalEl.win.cancelAnimationFrame(this.scrollRestoreRaf);
		}
		this.scrollRestoreRaf = this.modalEl.win.requestAnimationFrame(() => {
			this.scrollRestoreRaf = null;
			restore();
		});
	}

	private renderAvailable(): void {
		this.availableEl.empty();
		const occupied = new Set(
			this.slots.flatMap((slot) =>
				slot.assignment?.kind === 'existing'
					? [slot.assignment.file.path]
					: [],
			),
		);
		const managedElsewhere = new Set(
			this.registry.getRecords().flatMap((record) =>
				record.id === this.seriesId
					? []
					: record.slots.flatMap((slot) => slot.member ? [slot.member.path] : []),
			),
		);
		const files = getVersionableFiles(this.app.vault)
			.filter((file) =>
				!occupied.has(file.path) &&
				!managedElsewhere.has(file.path) &&
				matchesFilter(file, this.filter),
			)
			.sort((left, right) => left.path.localeCompare(right.path));

		const currentSeries = this.getCurrentSeriesTreeEntry();
		if (files.length === 0 && !currentSeries) {
			this.availableEl.createDiv({
				cls: 'version-management-empty',
				text: this.i18n.t('manage.noFiles'),
			});
			return;
		}

		const folders = this.filter
			? this.app.vault.getAllFolders(false).filter((folder) =>
				folder.path.toLocaleLowerCase().includes(this.filter) ||
				files.some((file) => file.path.startsWith(`${folder.path}/`)) ||
				Boolean(
					currentSeries && folderContainsPath(folder.path, currentSeries.folder),
				),
			)
			: this.app.vault.getAllFolders(false);
		this.renderTreeNode(
			this.availableEl,
			buildFileTree(files, folders),
			currentSeries,
		);
	}

	private getCurrentSeriesTreeEntry(): CurrentSeriesTreeEntry | null {
		if (!this.seriesId || this.currentSeriesFolder === null) {
			return null;
		}
		const v1 = this.slots.find((slot) => slot.version === 1);
		const assignment = v1?.assignment ?? null;
		return {
			assignment,
			folder: this.currentSeriesFolder,
			label: assignment ? assignmentLabel(assignment) : this.versionLabel(1),
		};
	}

	private renderCurrentSeries(
		container: HTMLElement,
		entry: CurrentSeriesTreeEntry,
	): void {
		const row = container.createDiv({
			cls: 'version-management-current-series-row',
			attr: { 'aria-current': 'true' },
		});
		const nameWrap = row.createDiv({
			cls: 'version-management-current-series-name-wrap',
		});
		const nameEl = nameWrap.createDiv({
			cls: 'version-management-current-series-name version-management-preview-trigger',
			attr: { tabindex: '0' },
			text: entry.label,
		});
		nameEl.addEventListener('pointerenter', (event) =>
			this.scheduleAssignmentPreview(entry.assignment, 1, nameEl, event),
		);
		nameEl.addEventListener('pointerleave', () =>
			this.hoverPreview.scheduleHide(),
		);
		nameEl.addEventListener('focus', () =>
			this.scheduleAssignmentPreview(entry.assignment, 1, nameEl),
		);
		nameEl.addEventListener('blur', () => this.hoverPreview.scheduleHide());

		const count = this.slots.length;
		const badge = row.createSpan({
			cls: 'version-count-badge version-management-current-series-count',
			text: String(count),
		});
		badge.setAttribute(
			'aria-label',
			this.i18n.t('fileExplorer.countAria', {
				count,
				unit: this.i18n.t(
					count === 1 ? 'common.version' : 'common.versions',
				),
			}),
		);
	}

	private renderTreeNode(
		container: HTMLElement,
		node: FileTreeNode,
		currentSeries: CurrentSeriesTreeEntry | null,
	): void {
		for (const [folderName, child] of [...node.folders].sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			const details = container.createEl('details', {
				cls: 'version-management-folder',
			});
			details.open = Boolean(this.filter) || this.openFolders.has(child.path);
			const summary = details.createEl('summary');
			const chevron = summary.createSpan({
				cls: 'version-management-folder-chevron',
			});
			setIcon(chevron, 'chevron-right');
			summary.createSpan({ text: folderName });
			details.addEventListener('toggle', () => {
				if (details.open) {
					this.openFolders.add(child.path);
				} else {
					this.openFolders.delete(child.path);
				}
			});
			const children = details.createDiv({
				cls: 'version-management-folder-children',
			});
			this.renderTreeNode(children, child, currentSeries);
		}
		const entries: Array<
			| { file: TFile; kind: 'file'; label: string }
			| { entry: CurrentSeriesTreeEntry; kind: 'current'; label: string }
		> = node.files.map((file) => ({ file, kind: 'file', label: file.name }));
		if (currentSeries?.folder === node.path) {
			entries.push({ entry: currentSeries, kind: 'current', label: currentSeries.label });
		}
		for (const entry of entries.sort((left, right) =>
			left.label.localeCompare(right.label),
		)) {
			if (entry.kind === 'current') {
				this.renderCurrentSeries(container, entry.entry);
			} else {
				this.renderAvailableFile(container, entry.file);
			}
		}
	}

	private renderAvailableFile(container: HTMLElement, file: TFile): void {
		const row = container.createDiv({
			cls: 'version-management-file-row',
		});
		this.renderDragHandle(
			row,
			{ file, kind: 'file' },
			row,
			file.name,
		);
			const nameEl = row.createDiv({
				cls: 'version-management-file-name version-management-preview-trigger',
				attr: { tabindex: '0' },
				text: file.name,
			});
		nameEl.addEventListener('pointerenter', (event) =>
			this.hoverPreview.scheduleFile(file, nameEl, file.basename, event),
		);
		nameEl.addEventListener('pointerleave', () => this.hoverPreview.scheduleHide());
			nameEl.addEventListener('focus', () =>
				this.hoverPreview.scheduleFile(file, nameEl),
			);
			nameEl.addEventListener('blur', () => this.hoverPreview.scheduleHide());
		row.addEventListener('pointerdown', (event) => {
			if (isInteractiveTarget(event.target)) {
				return;
			}
			this.armPointerDrag(
				event,
				{ file, kind: 'file' },
				row,
				file.name,
			);
		});
	}

	private renderSlots(): void {
		this.slotsEl.empty();
		const byVersion = new Map(this.slots.map((slot) => [slot.version, slot]));
		const maximum = Math.max(1, ...this.slots.map((slot) => slot.version));
		for (let version = 1; version <= maximum; version += 1) {
			const slot = byVersion.get(version);
			if (slot) {
				this.renderSlot(slot);
			} else {
				this.renderVersionGap(version);
			}
		}

		const addRow = this.slotsEl.createDiv({
			cls: 'version-management-add-row',
		});
		addRow.createDiv({
			cls: 'version-management-add-spacer',
			attr: { 'aria-hidden': 'true' },
		});
		const addCell = addRow.createDiv({ cls: 'version-management-add-cell' });
		const add = addCell.createEl('button', {
			cls: 'clickable-icon version-management-add-slot',
			attr: {
				'aria-label': this.i18n.t('manage.addBlank'),
				type: 'button',
			},
		});
		const icon = add.createSpan({ attr: { 'aria-hidden': 'true' } });
		setIcon(icon, 'plus');
		add.addEventListener('click', () => this.addPendingVersion());
	}

	private renderSlot(slot: DraftSlot): void {
		const row = this.slotsEl.createDiv({
			cls: `version-management-slot-row${slot.assignment ? '' : ' is-vacant'}`,
		});
		row.dataset.versionDrop = String(slot.version);
		if (slot.assignment?.kind === 'existing') {
			row.dataset.versionMemberPath = slot.assignment.file.path;
		}
		const card = row.createDiv({
			cls: `version-management-slot-card${slot.assignment ? '' : ' is-empty'}`,
		});
		const body = card.createDiv({ cls: 'version-management-slot-body' });
		const previewTrigger = this.renderAssignment(body, slot);
		if (previewTrigger) {
			previewTrigger.setAttribute('tabindex', '0');
			previewTrigger.addEventListener('pointerenter', (event) =>
				this.scheduleAssignmentPreview(
					slot.assignment,
					slot.version,
					previewTrigger,
					event,
				),
			);
			previewTrigger.addEventListener('pointerleave', () =>
				this.hoverPreview.scheduleHide(),
			);
			previewTrigger.addEventListener('focus', () =>
				this.scheduleAssignmentPreview(
					slot.assignment,
					slot.version,
					previewTrigger,
				),
			);
			previewTrigger.addEventListener('blur', () =>
				this.hoverPreview.scheduleHide(),
			);
		}

		const controls = card.createDiv({ cls: 'version-management-slot-controls' });
		this.renderDragHandle(
			controls,
			slot.assignment ? { kind: 'slot', version: slot.version } : null,
			card,
			slot.assignment
				? `${this.versionLabel(slot.version)} · ${assignmentLabel(slot.assignment)}`
				: this.versionLabel(slot.version),
			slot.version,
		);
		if (slot.version !== 1 && slot.assignment) {
			const remove = controls.createEl('button', {
				cls: 'clickable-icon',
				attr: { 'aria-label': this.i18n.t('manage.remove'), type: 'button' },
			});
			setIcon(remove, 'x');
			remove.addEventListener('click', () => this.clearSlot(slot.version));
		}

		card.addEventListener('pointerdown', (event) => {
			if (!slot.assignment || isInteractiveTarget(event.target)) {
				return;
			}
			const name = assignmentLabel(slot.assignment);
			this.armPointerDrag(
				event,
				{ kind: 'slot', version: slot.version },
				card,
				`${this.versionLabel(slot.version)} · ${name}`,
			);
		});

		const versionEl = row.createDiv({
			cls: `version-management-version-number${slot.assignment ? '' : ' is-vacant'}`,
		});
		versionEl.createSpan({
			cls: 'version-management-version-label',
			text: this.versionLabel(slot.version),
		});
		if (slot.version !== 1) {
			const deleteSlot = versionEl.createEl('button', {
				cls: 'clickable-icon version-management-delete-slot',
				attr: {
					'aria-label': this.i18n.t('manage.deleteSlot', {
						version: slot.version,
					}),
					type: 'button',
				},
			});
			setIcon(deleteSlot, 'x');
			deleteSlot.addEventListener('click', () =>
				this.deleteVersionSlot(slot.version),
			);
		}
	}

	private focusInitialMember(): void {
		if (!this.initialMemberPath) {
			return;
		}
		this.modalEl.win.requestAnimationFrame(() => {
			const row = [...this.slotsEl.querySelectorAll<HTMLElement>(
				'.version-management-slot-row[data-version-member-path]',
			)].find((candidate) =>
				candidate.dataset.versionMemberPath === this.initialMemberPath,
			);
			if (!row) {
				return;
			}
			row.tabIndex = -1;
			row.addClass('is-located');
			row.scrollIntoView({ block: 'center' });
			row.focus({ preventScroll: true });
			const version = Number(row.dataset.versionDrop);
			const file = this.app.vault.getFileByPath(this.initialMemberPath ?? '');
			if (Number.isInteger(version) && file) {
				this.announce(`${this.versionLabel(version)} · ${file.name}`);
			}
		});
	}

	private locateCurrentSeriesInLibrary(): void {
		this.modalEl.win.requestAnimationFrame(() => {
			const row = this.availableEl.querySelector<HTMLElement>(
				'.version-management-current-series-row',
			);
			if (!row) {
				return;
			}
			const viewport = this.availableEl.getBoundingClientRect();
			const bounds = row.getBoundingClientRect();
			this.availableEl.scrollTop +=
				bounds.top - viewport.top - (viewport.height - bounds.height) / 2;
		});
	}

	private renderVersionGap(version: number): void {
		const row = this.slotsEl.createDiv({
			cls: 'version-management-gap-row',
		});
		row.createDiv({
			cls: 'version-management-gap-spacer',
			attr: { 'aria-hidden': 'true' },
		});
		const cell = row.createDiv({ cls: 'version-management-gap-cell' });
		const restore = cell.createEl('button', {
			cls: 'version-management-gap-marker',
			text: String(version),
			attr: {
				'aria-label': this.i18n.t('manage.restoreSlot', { version }),
				type: 'button',
			},
		});
		restore.addEventListener('click', () => this.insertVersionSlot(version));
	}

	private renderAssignment(container: HTMLElement, slot: DraftSlot): HTMLElement | null {
		const assignment = slot.assignment;
		if (!assignment) {
			container.createDiv({
				cls: 'version-management-slot-placeholder',
				text: this.i18n.t('manage.dropHere'),
			});
			return null;
		}
		if (assignment.kind === 'existing') {
			const nameEl = container.createDiv({
				cls: 'version-management-slot-name version-management-preview-trigger',
				text: assignment.file.name,
			});
			return nameEl;
		}
		if (assignment.kind === 'missing') {
			const nameEl = container.createDiv({
				cls: 'version-management-slot-name is-missing version-management-preview-trigger',
				text: this.i18n.t('manage.missing', {
					name: filenameFromPath(assignment.member.path),
				}),
			});
			return nameEl;
		}

		const input = container.createEl('input', {
			cls: 'version-management-new-name',
			attr: { type: 'text' },
			value: assignment.name,
		});
		input.addEventListener('input', () => {
			assignment.name = input.value;
		});
		container.createDiv({
			cls: 'version-management-file-path',
			text: this.i18n.t('manage.createdOnDone'),
		});
		return null;
	}

	private dropOnSlot(targetVersion: number, source = this.dragSource): void {
		if (!source) {
			return;
		}
		const target = this.slots.find((slot) => slot.version === targetVersion);
		if (!target) {
			return;
		}
		if (source.kind === 'file') {
			target.assignment = { file: source.file, kind: 'existing' };
		} else {
			const sourceSlot = this.slots.find((slot) => slot.version === source.version);
			if (!sourceSlot || sourceSlot === target) {
				return;
			}
			const assignment = sourceSlot.assignment;
			sourceSlot.assignment = target.assignment;
			target.assignment = assignment;
		}
		this.renderAllWithMotion();
	}

	private clearSlot(version: number): void {
		const slot = this.slots.find((candidate) => candidate.version === version);
		if (!slot?.assignment) {
			return;
		}
		if (version === 1) {
			new Notice(this.i18n.t('manage.v1MoveRequired'));
			return;
		}
		this.clearedAssignments.set(version, slot.assignment);
		slot.assignment = null;
		this.renderAll();
	}

	private deleteVersionSlot(version: number): void {
		if (version === 1) {
			return;
		}
		const slotIndex = this.slots.findIndex(
			(candidate) => candidate.version === version,
		);
		if (slotIndex < 0) {
			return;
		}
		const [removed] = this.slots.splice(slotIndex, 1);
		const releasedAssignment = removed?.assignment ??
			this.clearedAssignments.get(version) ?? null;
		this.clearedAssignments.delete(version);
		if (releasedAssignment?.kind === 'existing') {
			this.releasedByDeletedVersion.add(releasedAssignment.file);
		}
		this.renderAll();
	}

	private insertVersionSlot(version: number): void {
		if (
			version <= 1 ||
			version > MAX_VERSION ||
			this.slots.some((slot) => slot.version === version)
		) {
			return;
		}
		this.slots.push({ assignment: null, version });
		this.prepareBlankVersion(version);
	}

	private addPendingVersion(): void {
		const version = nextVersionNumber(this.slots);
		if (version === null) {
			new Notice(this.i18n.t('view.limitReached', { version: MAX_VERSION }));
			return;
		}
		this.slots.push({
			assignment: null,
			version,
		});
		this.prepareBlankVersion(version);
	}

	private prepareBlankVersion(version: number): void {
		const slot = this.slots.find((candidate) => candidate.version === version);
		const v1 = this.getV1ExistingFile();
		if (!slot || slot.assignment || !v1) {
			if (!v1) {
				new Notice(this.i18n.t('manage.v1Required'));
			}
			return;
		}
		const name = formatVersionFilename(
			this.filenameTemplate,
			v1.basename,
			version,
		);
		slot.assignment = { kind: 'new', name };
		const path = this.pathForNewMarkdown(name);
		if (path && this.app.vault.getAbstractFileByPath(path)) {
			new Notice(this.i18n.t('manage.nameExists', { path }));
		}
		this.renderAll();
	}

	private getV1ExistingFile(): TFile | null {
		const assignment = this.slots.find((slot) => slot.version === 1)?.assignment;
		return assignment?.kind === 'existing' ? assignment.file : null;
	}

	private pathForNewMarkdown(name: string): string | null {
		const v1 = this.getV1ExistingFile();
		if (!v1) {
			return null;
		}
		const filename = name.toLocaleLowerCase().endsWith('.md')
			? name
			: `${name}.md`;
		const folder = v1.parent?.isRoot() ? '' : v1.parent?.path ?? '';
		return normalizePath(folder ? `${folder}/${filename}` : filename);
	}

	private scheduleAssignmentPreview(
		assignment: DraftAssignment | null,
		version: number,
		anchorEl: HTMLElement,
		event: MouseEvent | null = null,
	): void {
		if (!assignment) {
			this.hoverPreview.schedulePlaceholder(
				this.versionLabel(version),
				this.i18n.t('manage.emptyPreview'),
				anchorEl,
			);
			return;
		}
		if (assignment.kind === 'existing') {
			this.hoverPreview.scheduleFile(
				assignment.file,
				anchorEl,
				`${this.versionLabel(version)} · ${assignment.file.basename}`,
				event,
			);
			return;
		}
		if (assignment.kind === 'missing') {
			this.hoverPreview.schedulePlaceholder(
				`${this.versionLabel(version)} · ${assignment.member.lastKnownName}`,
				this.i18n.t('manage.missingPreview', {
					path: assignment.member.path,
				}),
				anchorEl,
			);
			return;
		}
		this.hoverPreview.schedulePlaceholder(
			`${this.versionLabel(version)} · ${assignment.name}`,
			this.i18n.t('manage.pendingPreview'),
			anchorEl,
		);
	}

	private versionLabel(version: number): string {
		return this.i18n.t('link.version', { version });
	}

	private renderDragHandle(
		container: HTMLElement,
		source: DragSource | null,
		sourceEl: HTMLElement,
		label: string,
		targetVersion?: number,
	): void {
		const ariaLabel = source?.kind === 'slot'
			? `${this.i18n.t('manage.dragVersion')}: ${label}`
			: source
				? `${this.i18n.t('manage.move')}: ${label}`
				: `${this.i18n.t('manage.dropHere')}: ${label}`;
		const handle = container.createEl('button', {
			cls: 'clickable-icon version-management-drag-handle',
			attr: {
				'aria-label': ariaLabel,
				type: 'button',
			},
		});
		handle.dataset.versionDefaultAriaLabel = ariaLabel;
		if (source) {
			handle.setAttribute('aria-pressed', 'false');
		}
		if (targetVersion !== undefined) {
			handle.dataset.versionKeyboardTarget = String(targetVersion);
		}
		setIcon(handle, 'grip-vertical');

		handle.addEventListener('pointerdown', (event) => {
			event.stopPropagation();
			if (this.keyboardDragSource || !source) {
				return;
			}
			this.armPointerDrag(event, source, sourceEl, label, true);
		});
		handle.addEventListener('click', (event) => {
			event.stopPropagation();
			// Pointer and touch users move assignments by dragging this handle.
			// Keyboard and assistive-technology activation produces a synthesized
			// click (`detail === 0`) and uses the deliberate pick-up/drop path.
			if (event.detail !== 0) {
				return;
			}
			if (Date.now() < this.suppressDragHandleClickUntil) {
				return;
			}
			this.activateKeyboardDrag(
				source,
				sourceEl,
				label,
				handle,
				targetVersion,
			);
		});
	}

	private activateKeyboardDrag(
		source: DragSource | null,
		sourceEl: HTMLElement,
		label: string,
		handle: HTMLButtonElement,
		targetVersion?: number,
	): void {
		const activeSource = this.keyboardDragSource;
		if (activeSource) {
			if (source && dragSourcesEqual(activeSource, source)) {
				this.cancelKeyboardDrag();
				return;
			}
			if (targetVersion !== undefined) {
				const movedLabel = this.keyboardDragLabel;
				this.cancelKeyboardDrag(false);
				this.dropOnSlot(targetVersion, activeSource);
				this.announce(
					this.i18n.t('manage.keyboardMoved', {
						label: movedLabel,
						version: this.versionLabel(targetVersion),
					}),
				);
				this.focusSlotHandle(targetVersion);
				return;
			}
		}

		if (!source) {
			this.announce(`${this.i18n.t('manage.dropHere')}: ${label}`);
			return;
		}
		this.beginKeyboardDrag(source, sourceEl, label, handle);
	}

	private beginKeyboardDrag(
		source: DragSource,
		sourceEl: HTMLElement,
		label: string,
		handle: HTMLButtonElement,
	): void {
		this.cancelKeyboardDrag(false);
		this.hoverPreview.hideNow();
		this.keyboardDragSource = source;
		this.keyboardDragSourceButton = handle;
		this.keyboardDragSourceEl = sourceEl;
		this.keyboardDragLabel = label;
		handle.setAttribute('aria-pressed', 'true');
		sourceEl.addClass('is-keyboard-dragging');
		this.modalEl.addClass('is-keyboard-dragging');
		for (const target of this.slotsEl.querySelectorAll<HTMLButtonElement>(
			'.version-management-drag-handle[data-version-keyboard-target]',
		)) {
			const targetVersion = Number(target.dataset.versionKeyboardTarget);
			if (
				Number.isInteger(targetVersion) &&
				(source.kind === 'file' || source.version !== targetVersion)
			) {
				target.addClass('is-keyboard-drop-target');
					target.setAttribute(
						'aria-label',
						this.i18n.t('manage.keyboardDropTarget', {
							version: this.versionLabel(targetVersion),
						}),
					);
			}
		}
		this.announce(this.i18n.t('manage.keyboardPicked', { label }));
	}

	private cancelKeyboardDrag(announce = true): void {
		if (!this.keyboardDragSource) {
			return;
		}
		const label = this.keyboardDragLabel;
		this.keyboardDragSourceButton?.setAttribute('aria-pressed', 'false');
		this.keyboardDragSourceEl?.removeClass('is-keyboard-dragging');
		for (const target of this.contentEl.querySelectorAll<HTMLElement>(
			'.is-keyboard-drop-target',
		)) {
			target.removeClass('is-keyboard-drop-target');
		}
		for (const handle of this.contentEl.querySelectorAll<HTMLButtonElement>(
			'.version-management-drag-handle[data-version-default-aria-label]',
		)) {
			handle.setAttribute(
				'aria-label',
				handle.dataset.versionDefaultAriaLabel ?? '',
			);
		}
		this.modalEl.removeClass('is-keyboard-dragging');
		this.keyboardDragSource = null;
		this.keyboardDragSourceButton = null;
		this.keyboardDragSourceEl = null;
		this.keyboardDragLabel = '';
		if (announce) {
			this.announce(this.i18n.t('manage.keyboardCancelled', { label }));
		}
	}

	private announce(message: string): void {
		if (!this.liveEl?.isConnected) {
			return;
		}
		this.liveEl.textContent = '';
		if (this.liveAnnouncementRaf !== null) {
			this.modalEl.win.cancelAnimationFrame(this.liveAnnouncementRaf);
		}
		this.liveAnnouncementRaf = this.modalEl.win.requestAnimationFrame(() => {
			this.liveAnnouncementRaf = null;
			if (this.liveEl.isConnected) {
				this.liveEl.textContent = message;
			}
		});
	}

	private focusSlotHandle(version: number): void {
		this.modalEl.win.requestAnimationFrame(() => {
			const handle = this.slotsEl.querySelector<HTMLButtonElement>(
				`.version-management-drag-handle[data-version-keyboard-target="${version}"]`,
			);
			handle?.focus({ preventScroll: true });
		});
	}

	private armPointerDrag(
		event: PointerEvent,
		source: DragSource,
		sourceEl: HTMLElement,
		label: string,
		suppressClick = false,
	): void {
		if (event.button !== 0 || this.dragCandidate || this.dragSource) {
			return;
		}
		this.dragCandidate = {
			label,
			pointerId: event.pointerId,
			suppressClick,
			source,
			sourceEl,
			startX: event.clientX,
			startY: event.clientY,
		};
		this.dragPoint = { x: event.clientX, y: event.clientY };
		const win = this.modalEl.win;
		win.addEventListener('pointermove', this.onPointerMove, { passive: false });
		win.addEventListener('pointerup', this.onPointerUp);
		win.addEventListener('pointercancel', this.onPointerCancel);
	}

	private readonly onPointerMove = (event: PointerEvent): void => {
		const candidate = this.dragCandidate;
		if (!candidate || event.pointerId !== candidate.pointerId) {
			return;
		}
		this.dragPoint = { x: event.clientX, y: event.clientY };
		if (!this.dragSource) {
			const distance = Math.hypot(
				event.clientX - candidate.startX,
				event.clientY - candidate.startY,
			);
			if (distance < 5) {
				return;
			}
			this.startPointerDrag(candidate);
		}
		event.preventDefault();
		this.scheduleDragFrame();
	};

	private readonly onPointerUp = (event: PointerEvent): void => {
		if (event.pointerId !== this.dragCandidate?.pointerId) {
			return;
		}
		const source = this.dragSource;
		const target = this.dragTargetEl;
		const didDrag = Boolean(source);
		this.suppressDragHandleClickUntil = didDrag && this.dragCandidate?.suppressClick
			? Date.now() + 400
			: 0;
		this.finishDrag();
		if (didDrag && source && target) {
			this.commitPointerDrop(source, target);
		}
	};

	private readonly onPointerCancel = (event: PointerEvent): void => {
		if (event.pointerId === this.dragCandidate?.pointerId) {
			this.finishDrag();
		}
	};

	private startPointerDrag(candidate: PointerDragCandidate): void {
		this.cancelKeyboardDrag(false);
		this.hoverPreview.hideNow();
		this.dragSource = candidate.source;
		this.dragSourceEl = candidate.sourceEl;
		candidate.sourceEl.addClass('is-dragging');
		this.modalEl.addClass('is-pointer-dragging');
		const ghost = this.modalEl.win.document.body.createDiv({
			cls: 'version-management-drag-ghost',
		});
		const icon = ghost.createSpan();
		setIcon(
			icon,
			candidate.source.kind === 'file'
				? 'file-text'
				: 'grip-vertical',
		);
		ghost.createSpan({ text: candidate.label });
		const sourceWidth = candidate.sourceEl.getBoundingClientRect().width;
		ghost.style.width = `${Math.min(320, Math.max(180, sourceWidth))}px`;
		this.dragGhost = ghost;
		this.scheduleDragFrame();
		this.dragScrollRaf = this.modalEl.win.requestAnimationFrame(
			this.runAutoScroll,
		);
	}

	private scheduleDragFrame(): void {
		if (this.dragRaf !== null) {
			return;
		}
		this.dragRaf = this.modalEl.win.requestAnimationFrame(() => {
			this.dragRaf = null;
			this.updateDragFrame();
		});
	}

	private updateDragFrame(): void {
		if (!this.dragSource || !this.dragGhost) {
			return;
		}
		const { x, y } = this.dragPoint;
		this.dragGhost.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
		const hit = this.modalEl.win.document.elementFromPoint(x, y);
		const selector = '[data-version-drop]';
		const target = hit instanceof Element
			? hit.closest<HTMLElement>(selector)
			: null;
		const validTarget = target && this.isValidDropTarget(this.dragSource, target)
			? target
			: null;
		if (validTarget === this.dragTargetEl) {
			return;
		}
		this.dragTargetEl?.removeClass('is-drop-target');
		this.dragTargetEl = validTarget;
		this.dragTargetEl?.addClass('is-drop-target');
		this.dragGhost.toggleClass('is-invalid', !validTarget);
	}

	private isValidDropTarget(source: DragSource, target: HTMLElement): boolean {
		const destination = target.dataset.versionDrop;
		if (destination === 'library') {
			return source.kind === 'slot' && source.version !== 1;
		}
		const targetVersion = Number(destination);
		return Number.isInteger(targetVersion) &&
			targetVersion >= 1 &&
			(source.kind === 'file' || source.version !== targetVersion);
	}

	private commitPointerDrop(source: DragSource, target: HTMLElement): void {
		const destination = target.dataset.versionDrop;
		if (destination === 'library' && source.kind === 'slot') {
			this.clearSlot(source.version);
			return;
		}
		const targetVersion = Number(destination);
		if (Number.isInteger(targetVersion)) {
			this.dropOnSlot(targetVersion, source);
		}
	}

	private readonly runAutoScroll = (): void => {
		if (!this.dragSource) {
			this.dragScrollRaf = null;
			return;
		}
		const { x, y } = this.dragPoint;
		for (const container of [this.availableEl, this.slotsEl]) {
			const rect = container.getBoundingClientRect();
			if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
				continue;
			}
			const edge = Math.min(52, rect.height / 4);
			let speed = 0;
			if (y < rect.top + edge) {
				speed = -Math.ceil(((rect.top + edge - y) / edge) * 14);
			} else if (y > rect.bottom - edge) {
				speed = Math.ceil(((y - (rect.bottom - edge)) / edge) * 14);
			}
			if (speed !== 0) {
				container.scrollTop += speed;
				this.scheduleDragFrame();
			}
		}
		this.dragScrollRaf = this.modalEl.win.requestAnimationFrame(
			this.runAutoScroll,
		);
	};

	private renderAllWithMotion(): void {
		const before = new Map<number, DOMRect>();
		for (const card of this.slotsEl.querySelectorAll<HTMLElement>(
			'.version-management-slot-row[data-version-drop]',
		)) {
			const version = Number(card.dataset.versionDrop);
			before.set(version, card.getBoundingClientRect());
		}
		this.renderAll();
		if (this.modalEl.win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			return;
		}
		for (const card of this.slotsEl.querySelectorAll<HTMLElement>(
			'.version-management-slot-row[data-version-drop]',
		)) {
			const previous = before.get(Number(card.dataset.versionDrop));
			if (!previous) {
				continue;
			}
			const current = card.getBoundingClientRect();
			const deltaX = previous.left - current.left;
			const deltaY = previous.top - current.top;
			if (deltaX !== 0 || deltaY !== 0) {
				card.animate(
					[
						{ transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
						{ transform: 'translate3d(0, 0, 0)' },
					],
					{ duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
				);
			}
		}
	}

	private finishDrag(): void {
		const win = this.modalEl.win;
		win.removeEventListener('pointermove', this.onPointerMove);
		win.removeEventListener('pointerup', this.onPointerUp);
		win.removeEventListener('pointercancel', this.onPointerCancel);
		if (this.dragRaf !== null) {
			win.cancelAnimationFrame(this.dragRaf);
			this.dragRaf = null;
		}
		if (this.dragScrollRaf !== null) {
			win.cancelAnimationFrame(this.dragScrollRaf);
			this.dragScrollRaf = null;
		}
		this.dragGhost?.remove();
		this.dragGhost = null;
		this.dragSourceEl?.removeClass('is-dragging');
		this.dragSourceEl = null;
		this.dragTargetEl?.removeClass('is-drop-target');
		this.dragTargetEl = null;
		this.dragCandidate = null;
		this.dragSource = null;
		this.modalEl.removeClass('is-pointer-dragging');
		for (const element of this.contentEl.querySelectorAll(
			'.is-dragging, .is-drop-target',
		)) {
			element.removeClass('is-dragging', 'is-drop-target');
		}
	}

	private async submit(): Promise<void> {
		if (this.submitting) {
			return;
		}
		const unassigned = this.slots.find((slot) => !slot.assignment);
		if (unassigned) {
			new Notice(this.i18n.t('manage.unassignedVersion', {
				version: unassigned.version,
			}));
			return;
		}
		if (!this.slots.some((slot) => slot.version === 1)) {
			new Notice(this.i18n.t('manage.v1Required'));
			return;
		}
		const v1 = this.getV1ExistingFile();
		if (!v1) {
			new Notice(this.i18n.t('manage.v1Required'));
			return;
		}
		if (this.slots.length < 2) {
			if (!this.seriesId) {
				new Notice(this.i18n.t('manage.twoVersionsRequired'));
				return;
			}
			new DissolveSeriesConfirmModal(
				this.app,
				this.i18n,
				() => this.submitSingleRemainingVersion(v1),
			).open();
			return;
		}

		this.submitting = true;
		this.renderAll();
		const createdFiles: CapturedFile[] = [];
		const originalNewAssignments = new Map<DraftSlot, NewAssignment>();
		let relationshipSaved = false;
		try {
			const folder = v1.parent?.isRoot() ? '' : v1.parent?.path ?? '';
			const pendingPlans: Array<{ path: string; slot: DraftSlot }> = [];
			const plannedPaths = new Set<string>();
			for (const slot of this.slots) {
				const assignment = slot.assignment;
				if (assignment?.kind !== 'new') {
					continue;
				}
				const name = assignment.name.trim();
				if (!name || /[/\\\n\r]/u.test(name)) {
					throw new Error(this.i18n.t('manage.invalidName'));
				}
				const filename = name.toLocaleLowerCase().endsWith('.md')
					? name
					: `${name}.md`;
				const path = normalizePath(folder ? `${folder}/${filename}` : filename);
				if (
					plannedPaths.has(path) ||
					this.app.vault.getAbstractFileByPath(path)
				) {
					throw new Error(this.i18n.t('manage.nameExists', { path }));
				}
				plannedPaths.add(path);
				pendingPlans.push({ path, slot });
			}
			const releasedMoves = this.planReleasedMoves(v1, plannedPaths, folder);

			this.registry.preflightSeriesSlots(
				this.seriesId,
				this.slots.map((slot) => {
					const assignment = slot.assignment;
					if (!assignment) {
						throw new Error(this.i18n.t('manage.unassignedVersion', {
							version: slot.version,
						}));
					}
					if (assignment.kind === 'new') {
						const plan = pendingPlans.find((candidate) => candidate.slot === slot);
						if (!plan) {
							throw new Error(this.i18n.t('manage.invalidName'));
						}
						return {
							member: {
								lastKnownName: basenameFromPath(plan.path),
								path: plan.path,
							},
							version: slot.version,
						};
					}
					const member = assignment.kind === 'existing'
						? memberRecordFromFile(assignment.file)
						: { ...assignment.member };
					return { member, version: slot.version };
				}),
			);

			for (const plan of pendingPlans) {
				const assignment = plan.slot.assignment;
				if (assignment?.kind !== 'new') {
					throw new Error(this.i18n.t('manage.invalidName'));
				}
				originalNewAssignments.set(plan.slot, { ...assignment });
				const file = await this.app.vault.create(plan.path, '');
				createdFiles.push(captureFile(file));
				plan.slot.assignment = { file, kind: 'existing' };
			}

			const finalSlots = this.slots.map((slot): VersionSlotRecord => {
				const assignment = slot.assignment;
				if (!assignment || assignment.kind === 'new') {
					throw new Error(this.i18n.t('manage.unassignedVersion', {
						version: slot.version,
					}));
				}
				const member = assignment.kind === 'existing'
					? memberRecordFromFile(assignment.file)
					: { ...assignment.member };
				return { member, version: slot.version };
			});
			await this.registry.saveSeriesSlots(this.seriesId, finalSlots);
			relationshipSaved = true;
			const failedReleasedMoves = await this.moveReleasedNotes(releasedMoves);
			this.onSaved();
			new Notice(this.i18n.t('manage.saved'));
			if (failedReleasedMoves > 0) {
				new Notice(this.i18n.t('manage.releaseMoveFailed', {
					count: failedReleasedMoves,
				}));
			}
			this.submitting = false;
			this.close();
		} catch (error) {
			let rollbackFailures = 0;
			if (!relationshipSaved) {
				rollbackFailures = (await rollbackCreatedBlankFiles(
					this.app.vault,
					(file) => this.app.fileManager.trashFile(file),
					createdFiles,
				)).length;
				for (const [slot, assignment] of originalNewAssignments) {
					slot.assignment = assignment;
				}
			}
			new Notice(this.i18n.t('manage.saveFailed', {
				message: error instanceof Error ? error.message : String(error),
			}));
			if (rollbackFailures > 0) {
				new Notice(this.i18n.t('manage.rollbackFailed', {
					count: rollbackFailures,
				}));
			}
			this.submitting = false;
			this.renderAll();
		}
	}

	private async submitSingleRemainingVersion(v1: TFile): Promise<void> {
		if (!this.seriesId || this.submitting) {
			return;
		}
		this.submitting = true;
		this.renderAll();
		try {
			const releasedMoves = this.planReleasedMoves(v1, new Set());
			await this.registry.dissolveSeries(this.seriesId);
			const failedReleasedMoves = await this.moveReleasedNotes(releasedMoves);
			this.onSaved();
			new Notice(this.i18n.t('manage.dissolved'));
			if (failedReleasedMoves > 0) {
				new Notice(this.i18n.t('manage.releaseMoveFailed', {
					count: failedReleasedMoves,
				}));
			}
			this.submitting = false;
			this.close();
		} catch (error) {
			new Notice(this.i18n.t('manage.saveFailed', {
				message: error instanceof Error ? error.message : String(error),
			}));
			this.submitting = false;
			this.renderAll();
		}
	}

	private planReleasedMoves(
		v1: TFile,
		reservedPaths: Set<string>,
		seriesFolder = v1.parent?.isRoot() ? '' : v1.parent?.path ?? '',
	): ReleasedMovePlan[] {
		const assignedFiles = new Set(
			this.slots.flatMap((slot) =>
				slot.assignment?.kind === 'existing'
					? [slot.assignment.file]
					: [],
			),
		);
		const destinationFolder = this.releasedVersionDestination === 'vault-root'
			? ''
			: seriesFolder;
		const destinationLabel = destinationFolder ||
			this.i18n.t('move.rootDestination');
		const plans: ReleasedMovePlan[] = [];

		for (const file of this.releasedByDeletedVersion) {
			if (
				assignedFiles.has(file) ||
				this.app.vault.getFileByPath(file.path) !== file
			) {
				continue;
			}
			const to = normalizePath(
				destinationFolder
					? `${destinationFolder}/${file.name}`
					: file.name,
			);
			if (to === file.path) {
				continue;
			}
			plans.push({ file, from: file.path, to });
		}

		const targetCounts = new Map<string, number>();
		for (const plan of plans) {
			targetCounts.set(plan.to, (targetCounts.get(plan.to) ?? 0) + 1);
		}
		for (const plan of plans) {
			if (
				reservedPaths.has(plan.to) ||
				(targetCounts.get(plan.to) ?? 0) > 1 ||
				this.app.vault.getAbstractFileByPath(plan.to)
			) {
				throw new Error(this.i18n.t('manage.releaseCollision', {
					destination: destinationLabel,
					name: plan.file.name,
				}));
			}
		}
		return plans;
	}

	private async moveReleasedNotes(plans: ReleasedMovePlan[]): Promise<number> {
		const completed: ReleasedMovePlan[] = [];
		try {
			for (const plan of plans) {
				await this.app.fileManager.renameFile(plan.file, plan.to);
				completed.push(plan);
			}
			return 0;
		} catch {
			for (const plan of completed.reverse()) {
				try {
					if (!this.app.vault.getAbstractFileByPath(plan.from)) {
						await this.app.fileManager.renameFile(plan.file, plan.from);
					}
				} catch {
					// Every released note remains a normal file even if rollback fails.
				}
			}
			return plans.length;
		}
	}
}

class DissolveSeriesConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly i18n: VersionI18n,
		private readonly onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('version-dissolve-confirm-modal');
		this.setTitle(this.i18n.t('manage.dissolveConfirmTitle'));
		this.contentEl.createEl('p', {
			text: this.i18n.t('manage.dissolveConfirmDescription'),
		});
		const actions = this.contentEl.createDiv({
			cls: 'version-dissolve-confirm-actions',
		});
		const keep = actions.createEl('button', {
			text: this.i18n.t('manage.keepSeries'),
		});
		keep.type = 'button';
		keep.addEventListener('click', () => this.close());
		const dissolve = actions.createEl('button', {
			cls: 'mod-warning',
			text: this.i18n.t('manage.dissolve'),
		});
		dissolve.type = 'button';
		dissolve.addEventListener('click', () => {
			this.close();
			void this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function buildDraftSlots(
	app: App,
	recordSlots: Array<{ member: VersionMemberRecord | null; version: number }>,
): DraftSlot[] {
	const validSlots = recordSlots.filter(
		(slot) =>
			Number.isInteger(slot.version) &&
			slot.version >= 1 &&
			slot.version <= MAX_VERSION &&
			slot.member !== null,
	);
	return validSlots.map((stored) => {
		const member = stored.member;
		if (!member) {
			throw new Error('Filtered Version member unexpectedly became empty.');
		}
		const file = app.vault.getFileByPath(member.path);
		return {
			assignment: file && memberMatchesFile(member, file)
				? { file, kind: 'existing' }
				: { kind: 'missing', member: { ...member } },
			version: stored.version,
		};
	});
}

function buildFileTree(files: TFile[], folders: TFolder[]): FileTreeNode {
	const root: FileTreeNode = { files: [], folders: new Map(), path: '' };
	for (const folder of [...folders].sort((left, right) =>
		left.path.localeCompare(right.path),
	)) {
		ensureFolderNode(root, folder.path);
	}
	for (const file of files) {
		const parts = file.path.split('/');
		parts.pop();
		const node = ensureFolderNode(root, parts.join('/'));
		node.files.push(file);
	}
	return root;
}

function ensureFolderNode(root: FileTreeNode, path: string): FileTreeNode {
	let node = root;
	let currentPath = '';
	for (const part of path.split('/').filter(Boolean)) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		let child = node.folders.get(part);
		if (!child) {
			child = { files: [], folders: new Map(), path: currentPath };
			node.folders.set(part, child);
		}
		node = child;
	}
	return node;
}

function matchesFilter(file: TFile, filter: string): boolean {
	return !filter || file.path.toLocaleLowerCase().includes(filter);
}

function nextVersionNumber(slots: DraftSlot[]): number | null {
	const maximum = Math.max(0, ...slots.map((slot) => slot.version));
	return maximum < MAX_VERSION ? maximum + 1 : null;
}

function assignmentLabel(assignment: DraftAssignment): string {
	if (assignment.kind === 'existing') {
		return assignment.file.name;
	}
	if (assignment.kind === 'missing') {
		return assignment.member.lastKnownName;
	}
	return assignment.name;
}

function dragSourcesEqual(left: DragSource, right: DragSource): boolean {
	if (left.kind !== right.kind) {
		return false;
	}
	if (left.kind === 'file' && right.kind === 'file') {
		return left.file === right.file;
	}
	if (left.kind === 'slot' && right.kind === 'slot') {
		return left.version === right.version;
	}
	return false;
}

function parentPathFromPath(path: string): string {
	const separator = path.lastIndexOf('/');
	return separator < 0 ? '' : path.slice(0, separator);
}

function folderContainsPath(folder: string, target: string): boolean {
	return folder === target || Boolean(target && target.startsWith(`${folder}/`));
}

function addFolderAncestors(folders: Set<string>, path: string): void {
	let current = '';
	for (const part of path.split('/').filter(Boolean)) {
		current = current ? `${current}/${part}` : part;
		folders.add(current);
	}
}

function filenameFromPath(path: string): string {
	return path.split('/').at(-1) ?? path;
}

function isInputTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as Element).instanceOf !== 'function') {
		return false;
	}
	const element = target as Element;
	return (
		element.instanceOf(HTMLInputElement) ||
		element.instanceOf(HTMLTextAreaElement)
	);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as Element).instanceOf !== 'function') {
		return false;
	}
	const element = target as Element;
	return (
		isInputTarget(target) ||
		element.instanceOf(HTMLButtonElement) ||
		Boolean(element.closest('button, input, textarea'))
	);
}

function basenameFromPath(path: string): string {
	const filename = path.split('/').pop() ?? path;
	return filename.toLocaleLowerCase().endsWith('.md')
		? filename.slice(0, -3)
		: filename;
}
