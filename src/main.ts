import {
	Command,
	Menu,
	Notice,
	normalizePath,
	Plugin,
	TFile,
	TFolder,
} from 'obsidian';
import { VersionI18n, VersionLanguage } from './i18n';
import { chooseRecoveredMarkdown } from './import-recovered-markdown';
import {
	DEFAULT_SETTINGS,
	VersionSettings,
	VersionSettingTab,
} from './settings';
import {
	cloneSeriesRecords,
	hasUnsupportedExplicitSchema,
	isValidFilenameTemplate,
	memberMatchesFile,
	mergeExternalPluginData,
	normalizeExternalPluginData,
	normalizePluginData,
	ReleasedVersionDestination,
	VersionSeriesRecord,
	VersionSlotRecord,
	versionPluginDataEqual,
} from './version-data';
import {
	isVersionGroupExactlyResolved,
	VersionGroup,
} from './version-index';
import { VersionRegistry } from './version-registry';
import { isVersionableFile } from './version-file-types';
import { getVersionFileMenuState } from './version-file-menu-state';
import { SerializedDataStore } from './serialized-data-store';
import { MovePlan } from './move-theme-plans';
import {
	executeSeriesMove,
	SeriesMoveError,
	SeriesMovePlan,
} from './series-move-transaction';
import { setMenuItemWarning } from './menu-item-warning';
import { renameAndWaitForExactDestination } from './file-rename-completion';
import {
	canMergeWithNoteComposer,
	replaceNoteComposerMenuAction,
} from './note-composer-compat';
import {
	isNativeFileActionProbe,
	VERSION_NATIVE_FILE_ACTION_SOURCE,
} from './native-file-action-bridge';
import {
	resetManagedFileMenu,
	scheduleManagedFileMenuPrune,
} from './managed-representative-menu';
import { ThemeBacklinksModal } from './ui/backlinks-modal';
import { DeleteVersionsModal } from './ui/delete-versions-modal';
import { FileExplorerDecorator } from './ui/file-explorer-decorator';
import { MoveThemeModal } from './ui/move-theme-modal';
import { VersionLinkModal } from './ui/version-link-modal';
import { VersionEditorSuggest } from './ui/version-editor-suggest';
import { VersionFileActionsModal } from './ui/version-file-actions-modal';
import { VersionManagementModal } from './ui/version-management-modal';
import {
	VersionMergeFileExpectation,
	VersionMergeTargetModal,
} from './ui/version-merge-modal';
import { VersionSeriesModal } from './ui/version-series-modal';
import { VersionViewDecorator } from './ui/version-view-decorator';

export default class VersionPlugin extends Plugin {
	readonly i18n = new VersionI18n(DEFAULT_SETTINGS.language);
	settings: VersionSettings = {
		...DEFAULT_SETTINGS,
		series: [],
	};
	private registry!: VersionRegistry;
	private fileExplorer!: FileExplorerDecorator;
	private dataStore!: SerializedDataStore<VersionSettings>;
	private editorSuggest!: VersionEditorSuggest;
	private versionViews!: VersionViewDecorator;
	private settingTab: VersionSettingTab | null = null;
	private externalSettingsBase: VersionSettings | null = null;
	private externalRegistryBase: VersionSeriesRecord[] = [];
	private externalRegistryBaseTrusted = false;
	private readonly protectedExternalSnapshots: VersionSettings[] = [];
	private unloaded = false;
	private readonly internalRenamePaths = new Set<string>();
	private readonly incompleteDeleteNoticeTimers = new Map<string, number>();
	private readonly delayedUiRefreshTimers = new Set<number>();
	private readonly folderRenameCleanupTimers = new Set<number>();
	private readonly pendingFolderRenames: FolderRenameObservation[] = [];
	private externalSettingsQueue: Promise<void> = Promise.resolve();
	private renameEventQueue: Promise<void> = Promise.resolve();
	private readonly localizedCommands = new Map<
		keyof LocalizedCommandNames,
		Command
	>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.i18n.setLanguage(this.settings.language);
		this.settingTab = new VersionSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.registry = new VersionRegistry(
			this.app.vault,
			this.settings.series,
			(series) => this.persistSeries(series),
		);
		const index = this.registry.index;

		this.fileExplorer = new FileExplorerDecorator(
			this.app,
			index,
			this.i18n,
		);
		this.versionViews = new VersionViewDecorator(
			this.app,
			index,
			this.registry,
			() => this.settings.filenameTemplate,
			() => this.refreshUi(),
			(file) => this.openVersionManager(file),
			(group, file) => this.openDeleteVersions(group, file),
			(group, file) => this.openVersionFileActions(group, file),
			(group) => this.openThemeBacklinks(group),
			this.i18n,
		);
		this.editorSuggest = new VersionEditorSuggest(
			this.app,
			index,
			this.i18n,
		);
		this.registerEditorSuggest(this.editorSuggest);

		// Community plugins can load before Obsidian has finished populating the
		// Vault's file index. Legacy path-only records must stay fail-open until
		// exact-path files can be resolved, so perform the one-time identity
		// migration only after the workspace layout (and Vault index) is ready.
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) {
				return;
			}
			void this.migrateLegacyMemberIdentities();
		});

		this.localizedCommands.set('verifyInstallation', this.addCommand({
			id: 'verify-installation',
			name: this.i18n.t('command.verifyInstallation'),
			callback: () => {
				new Notice(this.i18n.t('notice.running'));
			},
		}));

		this.localizedCommands.set('insertLink', this.addCommand({
			id: 'insert-link',
			name: this.i18n.t('command.insertLink'),
			editorCallback: (editor, view) => {
				if (!view.file) {
					return;
				}

				new VersionLinkModal(
					this.app,
					index,
					editor,
					view.file,
					this.i18n,
				).open();
			},
		}));

		this.localizedCommands.set('importRecovered', this.addCommand({
			id: 'import-recovered-markdown',
			name: this.i18n.t('command.importRecovered'),
			callback: () =>
				chooseRecoveredMarkdown(this.app, this.i18n),
		}));

		this.localizedCommands.set('showBacklinks', this.addCommand({
			id: 'show-theme-backlinks',
			name: this.i18n.t('command.showBacklinks'),
			checkCallback: (checking) => {
				const activeFile = this.app.workspace.getActiveFile();
				const group = activeFile
					? index.getGroupForFile(activeFile)
					: null;

				if (!group || group.status !== 'healthy') {
					return false;
				}

				if (!checking) {
					this.openThemeBacklinks(group);
				}

				return true;
			},
		}));

		this.localizedCommands.set('manageVersions', this.addCommand({
			id: 'manage-or-create',
			name: this.i18n.t('command.manageVersions'),
			callback: () => this.openVersionSeriesPicker(
				this.app.workspace.getActiveFile(),
			),
		}));

		this.registerEvent(
			this.app.workspace.on(
				'file-menu',
				(menu: Menu, file, source) => {
					if (
						source === VERSION_NATIVE_FILE_ACTION_SOURCE ||
						isNativeFileActionProbe(menu)
					) {
						return;
					}
					if (file instanceof TFile && isVersionableFile(file)) {
						const group = index.getGroupForFile(file);
						const registeredSeriesIds = this.registry.getRecords()
							.filter((record) => record.slots.some(
								(slot) => slot.member?.path === file.path,
							))
							.map((record) => record.id);
						const menuState = getVersionFileMenuState(
							group,
							file.path,
							registeredSeriesIds.length,
						);
						const { isManagedMember, resolvedVersion } = menuState;
						if (isManagedMember) {
							resetManagedFileMenu(menu);
						}
						menu.addItem((item) =>
							item
								.setTitle(
									this.i18n.t(menuState.action === 'repair'
										? 'view.repairVersions'
										: menuState.action === 'locate'
											? 'fileExplorer.locateVersion'
											: menuState.action === 'manage'
												? 'fileExplorer.manageVersions'
												: 'fileExplorer.createVersions', {
									version: resolvedVersion?.version ?? 1,
									}),
								)
								.setIcon(
									group || registeredSeriesIds.length > 0
										? 'list-tree'
										: 'plus',
								)
								.setSection('version')
								.onClick(() => {
									if (group) {
										this.openVersionManager(file, group.id);
									} else if (registeredSeriesIds.length === 1) {
										this.openVersionManager(file, registeredSeriesIds[0]);
									} else if (registeredSeriesIds.length > 1) {
										this.openVersionSeriesPicker(
											file,
											false,
											new Set(registeredSeriesIds),
										);
									} else {
										this.versionViews.openInitialVersionModalForFile(file);
									}
								}),
						);
						if (group?.status === 'healthy') {
							menu.addItem((item) =>
								item
									.setTitle(this.i18n.t('command.showBacklinks'))
									.setIcon('links-coming-in')
									.setSection('version-group')
									.onClick(() => this.openThemeBacklinks(group)),
							);
						}
						if (group && isVersionGroupExactlyResolved(group)) {
							menu.addItem((item) =>
								item
									.setTitle(this.i18n.t('fileExplorer.fileActions'))
									.setIcon('list-checks')
									.setSection('version-group')
									.onClick(() => this.openVersionFileActions(
										group,
										file,
									)),
							);
							menu.addItem((item) =>
								item
									.setTitle(this.i18n.t('fileExplorer.moveTheme'))
									.setIcon('folder-input')
									.setSection('version-group')
									.onClick(() => this.openMoveTheme(group)),
							);
							menu.addItem((item) => {
								item
									.setTitle(this.i18n.t('fileExplorer.deleteVersions'))
									.setIcon('trash-2')
									.setSection('version-group')
									.onClick(() => this.openDeleteVersions(group));
								setMenuItemWarning(item);
							});
						}
						if (isManagedMember) {
							scheduleManagedFileMenuPrune(menu);
						} else if (
							!group &&
							registeredSeriesIds.length === 0 &&
							file.extension.toLocaleLowerCase() === 'md'
						) {
							// Note Composer enumerates physical TFiles. Replace only its
							// merge entry with Version's topic-first target picker; all
							// unrelated core and third-party menu items remain untouched.
							replaceNoteComposerMenuAction(
								this.app,
								menu,
								file,
								() => this.openMergeTarget(file),
							);
						}
					}
				},
			),
		);

		this.registerEvent(
			this.app.workspace.on('file-open', () => this.scheduleUiRefresh()),
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () =>
				this.scheduleUiRefresh(),
			),
		);

		// Vault events do not depend on the workspace layout. Register them as
		// soon as the plugin is loaded so a late onLayoutReady callback cannot
		// leave the registry and the visible UI out of sync.
		this.registerVaultEvents();
		this.scheduleUiRefresh();
		this.app.workspace.onLayoutReady(() => {
			if (!this.unloaded) {
				this.scheduleUiRefresh();
			}
		});
	}

	onunload(): void {
		this.unloaded = true;
		for (const timer of this.delayedUiRefreshTimers) {
			window.clearTimeout(timer);
		}
		this.delayedUiRefreshTimers.clear();
		for (const timer of this.folderRenameCleanupTimers) {
			window.clearTimeout(timer);
		}
		this.folderRenameCleanupTimers.clear();
		this.pendingFolderRenames.length = 0;
		for (const timer of this.incompleteDeleteNoticeTimers.values()) {
			window.clearTimeout(timer);
		}
		this.incompleteDeleteNoticeTimers.clear();
		this.fileExplorer?.destroy();
		this.versionViews?.destroy();
		this.settingTab = null;
	}

	async onExternalSettingsChange(): Promise<void> {
		if (this.unloaded || !this.registry || !this.dataStore) {
			return;
		}

		// Start capturing the bytes when Obsidian delivers the event, before
		// waiting behind an earlier reload. Otherwise an earlier conflict
		// write-back could overwrite a later external snapshot before its queued
		// handler ever reads data.json. Preserve the registry base from the same
		// moment so concurrent relationship edits remain recoverable; scalar
		// settings use the freshest accepted base when this event reaches the queue.
		const capturedRegistryBase = this.externalRegistryBaseTrusted
			? cloneSeriesRecords(this.externalRegistryBase)
			: [];
		const rawSnapshot = this.loadData().then(
			(value: unknown) => ({ ok: true as const, value }),
			(error: unknown) => ({ error, ok: false as const }),
		);
		const operation = async (): Promise<void> => {
			try {
				const captured = await rawSnapshot;
				if (!captured.ok) {
					throw captured.error;
				}
				const raw: unknown = captured.value;
				const incoming = normalizeExternalPluginData(raw);
				if (!incoming) {
					throw new Error(
						'Synchronized data.json does not contain a complete Version series list.',
					);
				}
				if (this.unloaded) {
					return;
				}

				const protectedReplay = this.protectedExternalSnapshots.some(
					(snapshot) => versionPluginDataEqual(snapshot, incoming),
				);
				const latestBase = normalizePluginData(
					this.externalSettingsBase ?? this.dataStore.get(),
				);
				const mergeBase = normalizePluginData({
					...latestBase,
					series: capturedRegistryBase,
				});
				let reconciled: VersionSettings | null = null;
				await this.registry.reload(async () => {
					if (this.unloaded) {
						throw new Error('Version unloaded during synchronized data reload.');
					}
					const next = await this.dataStore.reconcile(
						mergeBase,
						incoming,
						(mergeBase, current, capturedIncoming) => {
							if (this.unloaded) {
								throw new Error(
									'Version unloaded during synchronized data reload.',
								);
							}
							return protectedReplay
								? normalizePluginData(current)
								: mergeExternalPluginData(
									mergeBase,
									current,
									capturedIncoming,
								);
						},
						versionPluginDataEqual,
					);
					reconciled = normalizePluginData(next);
					return next.series;
				});
				if (!reconciled) {
					throw new Error('Synchronized Version data was not reconciled.');
				}
				if (!versionPluginDataEqual(reconciled, incoming)) {
					if (!protectedReplay) {
						this.protectedExternalSnapshots.push(
							normalizePluginData(incoming),
						);
						if (this.protectedExternalSnapshots.length > 8) {
							this.protectedExternalSnapshots.shift();
						}
					}
				}
				// A rejected protected replay is not evidence that another device has
				// accepted newer local edits, so it must not advance the merge base.
				// Other successful reconciliations advance to the actual accepted or
				// written snapshot; exact older inputs that lost a conflict remain
				// protected above from regressing the registry on replay.
				if (!protectedReplay) {
					this.externalSettingsBase = normalizePluginData(reconciled);
					this.externalRegistryBase = cloneSeriesRecords(incoming.series);
					this.externalRegistryBaseTrusted = true;
				}
				if (this.unloaded) {
					return;
				}

				this.i18n.setLanguage(this.settings.language);
				this.settingTab?.refreshIfVisible();
				this.editorSuggest.refreshLanguage();
				this.refreshCommandNames();
				this.scheduleUiRefresh();
			} catch (error) {
				if (!this.unloaded) {
					new Notice(this.i18n.t('view.externalSettingsReloadFailed', {
						message: error instanceof Error ? error.message : String(error),
					}));
				}
			}
		};
		const result = this.externalSettingsQueue.then(operation, operation);
		this.externalSettingsQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async setLanguage(language: VersionLanguage): Promise<void> {
		await this.updatePluginData((current) => ({ ...current, language }));
		this.i18n.setLanguage(language);
		// Refresh the open settings pane before any non-critical UI refreshes.
		// This keeps every settings label in sync even if another view supplied
		// by Obsidian or a community plugin throws while refreshing afterwards.
		this.settingTab?.refreshIfVisible();
		this.editorSuggest.refreshLanguage();
		this.refreshCommandNames();
		this.refreshUi();
	}

	async setFilenameTemplate(template: string): Promise<void> {
		const value = template.trim() || DEFAULT_SETTINGS.filenameTemplate;
		if (!isValidFilenameTemplate(value)) {
			new Notice(this.i18n.t('settings.filenameTemplateInvalid'));
			return;
		}
		await this.updatePluginData((current) => ({
			...current,
			filenameTemplate: value,
		}));
	}

	async setReleasedVersionDestination(
		destination: ReleasedVersionDestination,
	): Promise<void> {
		await this.updatePluginData((current) => ({
			...current,
			releasedVersionDestination: destination,
		}));
	}

	private refreshUi(): void {
		if (this.unloaded) {
			return;
		}

		this.fileExplorer.refresh();
		this.versionViews.refresh();
	}

	private scheduleUiRefresh(): void {
		for (const timer of this.delayedUiRefreshTimers) {
			window.clearTimeout(timer);
		}
		this.delayedUiRefreshTimers.clear();
		this.refreshUi();
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => this.refreshUi());
		});
		// Community views can replace their content after Obsidian's file-open
		// and layout-change events. Bounded delayed passes let those views settle
		// without observing or patching their private DOM.
		for (const delay of [150, 750, 2_000]) {
			const timer = window.setTimeout(() => {
				this.delayedUiRefreshTimers.delete(timer);
				if (!this.unloaded) {
					this.refreshUi();
				}
			}, delay);
			this.delayedUiRefreshTimers.add(timer);
		}
	}

	private async loadSettings(): Promise<void> {
		const raw: unknown = await this.loadData();
		if (hasUnsupportedExplicitSchema(raw)) {
			throw new Error(
				'Version data.json uses an unsupported schema and was not loaded.',
			);
		}
		this.settings = normalizePluginData(raw);
		this.externalSettingsBase = normalizePluginData(this.settings);
		this.externalRegistryBase = cloneSeriesRecords(this.settings.series);
		// data.json has no cross-device causal revision. After a process restart,
		// the first differing external registry may be an older device snapshot,
		// so merge it as concurrent (empty ancestor) instead of authorizing silent
		// relationship deletion or replacement. A successfully observed external
		// snapshot establishes the in-memory base for the rest of this session.
		this.externalRegistryBaseTrusted = false;
		this.dataStore = new SerializedDataStore(
			this.settings,
			(next) => this.saveData(next),
			(next) => {
				this.settings = next;
			},
		);
	}

	private async migrateLegacyMemberIdentities(): Promise<void> {
		if (this.unloaded) {
			return;
		}
		try {
			const migrated = await this.registry.migrateLegacyMemberIdentities();
			if (!this.unloaded && migrated > 0) {
				this.scheduleUiRefresh();
			}
		} catch (error) {
			if (!this.unloaded) {
				new Notice(this.i18n.t('view.identityMigrationFailed', {
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	}

	private async persistSeries(
		series: VersionSeriesRecord[],
	): Promise<void> {
		await this.updatePluginData((current) => ({ ...current, series }));
	}

	private updatePluginData(
		update: (current: VersionSettings) => VersionSettings,
	): Promise<void> {
		return this.dataStore.update(update);
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile) {
					this.registry.rebuild();
					this.refreshUi();
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) {
					const group = this.registry.index.getGroupForFile(file);
					const member = group?.versions.find(
						(versionFile) => versionFile.file === file,
					);
					// A uniquely resolved member of an incomplete relationship is
					// still safe to reconcile exactly. Only an invalid/ambiguous
					// relationship must remain fail-open without mutation.
					if (
						group &&
						group.status !== 'invalid' &&
						group.identityStatus === 'exact' &&
						member
					) {
						this.renameEventQueue = this.renameEventQueue.then(
							() => this.handleVaultDelete(group.id, member.version, file),
							() => this.handleVaultDelete(group.id, member.version, file),
						);
					} else {
						this.registry.rebuild();
						this.refreshUi();
					}
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (this.unloaded) {
					return;
				}
				if (file instanceof TFolder) {
					const observation = this.captureFolderRename(file, oldPath);
					if (!observation) {
						return;
					}
					this.renameEventQueue = this.renameEventQueue.then(
						() => this.handleVaultFolderRename(observation),
						() => this.handleVaultFolderRename(observation),
					);
					return;
				}
				if (
					!(file instanceof TFile) ||
					this.internalRenamePaths.has(oldPath)
				) {
					return;
				}
				// Obsidian emits descendant TFile events after a TFolder move. They
				// are already covered by the prefix transaction and must never be
				// interpreted as an independent V1 whole-series move.
				if (this.findCoveringFolderRename(oldPath, file.path)) {
					return;
				}
				this.renameEventQueue = this.renameEventQueue.then(
					() => this.handleVaultRename(file, oldPath),
					() => this.handleVaultRename(file, oldPath),
				);
			}),
		);
	}

	private captureFolderRename(
		folder: TFolder,
		oldPath: string,
	): FolderRenameObservation | null {
		const normalizedOld = normalizePath(oldPath);
		const normalizedNew = normalizePath(folder.path);
		if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
			return null;
		}
		const observation = {
			newPath: normalizedNew,
			oldPath: normalizedOld,
		};
		this.pendingFolderRenames.push(observation);
		const timer = window.setTimeout(() => {
			this.folderRenameCleanupTimers.delete(timer);
			const index = this.pendingFolderRenames.indexOf(observation);
			if (index >= 0) {
				this.pendingFolderRenames.splice(index, 1);
			}
		}, 2_000);
		this.folderRenameCleanupTimers.add(timer);
		return observation;
	}

	private findCoveringFolderRename(
		oldFilePath: string,
		newFilePath: string,
	): FolderRenameObservation | null {
		return [...this.pendingFolderRenames]
			.sort((left, right) => right.oldPath.length - left.oldPath.length)
			.find((observation) =>
				mapFolderChildPath(
					oldFilePath,
					observation.oldPath,
					observation.newPath,
				) === normalizePath(newFilePath),
			) ?? null;
	}

	private async handleVaultFolderRename(
		observation: FolderRenameObservation,
	): Promise<void> {
		if (this.unloaded) {
			return;
		}
		// At the leading TFolder event Obsidian still exposes descendants at
		// their old paths. The matching TFile events arrive as one sub-millisecond
		// burst, so yield one short task before validating the final prefix state.
		await new Promise<void>((resolve) => window.setTimeout(resolve, 24));
		if (this.unloaded) {
			return;
		}
		try {
			await this.registry.reconcileFolderRename(
				observation.oldPath,
				observation.newPath,
			);
			this.refreshUi();
		} catch (error) {
			this.registry.rebuild();
			this.refreshUi();
			if (!this.unloaded) {
				new Notice(this.i18n.t('view.registryUpdateFailed', {
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	}

	private async handleVaultDelete(
		seriesId: string,
		version: number,
		file: TFile,
	): Promise<void> {
		if (this.unloaded) {
			return;
		}
		try {
			await this.registry.recordDeletedMember(seriesId, version, file);
			this.refreshUi();
		} catch {
			this.registry.rebuild();
			this.refreshUi();
			this.scheduleIncompleteDeleteNotice(seriesId);
		}
	}

	private async handleVaultRename(file: TFile, oldPath: string): Promise<void> {
		if (this.unloaded) {
			return;
		}
		try {
			const oldPathWasRegistered = this.registry.getRecords().some((record) =>
				record.slots.some((slot) => slot.member?.path === oldPath));
			const membership = this.findRegisteredMembership(oldPath, file);
			if (
				membership?.version === 1 &&
				parentPath(oldPath) !== parentPath(file.path)
			) {
				await this.moveCompanionsAfterV1(file, oldPath, membership.seriesId);
			} else {
				const updated = await this.registry.updateMemberPath(oldPath, file);
				if (!updated && oldPathWasRegistered) {
					throw new Error(this.i18n.t('view.repairVersions'));
				}
			}
			this.refreshUi();
		} catch (error) {
			this.registry.rebuild();
			this.refreshUi();
			if (!this.unloaded) {
				new Notice(this.i18n.t('view.registryUpdateFailed', {
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	}

	private findRegisteredMembership(
		path: string,
		file: TFile,
	): { seriesId: string; version: number } | null {
		if (
			!isVersionableFile(file) ||
			this.app.vault.getFileByPath(file.path) !== file
		) {
			return null;
		}
		const matches: Array<{ seriesId: string; version: number }> = [];
		for (const record of this.registry.getRecords()) {
			for (const slot of record.slots) {
				if (
					slot.member?.path === path &&
					memberMatchesFile(slot.member, file)
				) {
					matches.push({ seriesId: record.id, version: slot.version });
				}
			}
		}
		return matches.length === 1 ? matches[0] : null;
	}

	/**
	 * The file explorer can only report the V1 move after it happened. Cascade
	 * that move to companions only while the captured relationship remains
	 * unique, healthy, and exact. If any member is compatible or unresolved, keep
	 * every companion in place and reconcile only the V1 move when that single
	 * identity can still be proven safely.
	 */
	private async moveCompanionsAfterV1(
		v1: TFile,
		oldV1Path: string,
		seriesId: string,
	): Promise<void> {
		const movedV1Path = v1.path;
		const group = this.registry.index.getGroupById(seriesId);
		const record = this.registry.getRecordById(seriesId);
		if (!record || !group || !isVersionGroupExactlyResolved(group)) {
			await this.reconcileMovedV1Only(v1, oldV1Path, seriesId);
			return;
		}
		const destinationFolder = parentPath(movedV1Path);
		const plans: SeriesMovePlan[] = [];
		for (const slot of record.slots) {
			if (!slot.member) {
				continue;
			}
			const file = slot.member.path === oldV1Path
				? v1
				: this.app.vault.getFileByPath(slot.member.path);
			if (!file || !isVersionableFile(file) || !memberMatchesFile(slot.member, file)) {
				await this.reconcileMovedV1Only(v1, oldV1Path, seriesId);
				return;
			}
			const to = normalizePath(
				destinationFolder
					? `${destinationFolder}/${file.name}`
					: file.name,
			);
			plans.push({
				alreadyMoved: slot.member.path === oldV1Path,
				file,
				from: slot.member.path,
				to,
			});
		}

		try {
			await this.moveSeriesFiles(seriesId, plans);
			new Notice(this.i18n.t('move.success', {
				count: plans.length,
				unit: this.i18n.t(
					plans.length === 1
						? 'common.version'
						: 'common.versions',
				),
				destination: destinationFolder || this.i18n.t('move.rootDestination'),
			}));
		} catch (error) {
			if (error instanceof SeriesMoveError && error.kind === 'collision') {
				const collisions = error.collisionCount;
				new Notice(this.i18n.t('move.collision', {
					count: collisions,
					subject: this.i18n.t(
						collisions === 1
							? 'move.collisionOne'
							: 'move.collisionMany',
					),
				}));
				return;
			}
			throw error;
		} finally {
			this.registry.rebuild();
			this.refreshUi();
		}
	}

	private async reconcileMovedV1Only(
		v1: TFile,
		oldV1Path: string,
		seriesId: string,
	): Promise<void> {
		if (await this.registry.updateMemberPath(oldV1Path, v1)) {
			return;
		}
		const current = this.findRegisteredMembership(v1.path, v1);
		if (current?.seriesId === seriesId && current.version === 1) {
			return;
		}
		throw new Error(this.i18n.t('view.repairVersions'));
	}

	private async moveSeriesFiles(
		seriesId: string,
		plans: SeriesMovePlan[],
		recordOverride: VersionSeriesRecord | null = null,
	): Promise<void> {
		const record = recordOverride ?? this.registry.getRecordById(seriesId);
		const group = this.registry.index.getGroupById(seriesId);
		if (!record || !group || !isVersionGroupExactlyResolved(group)) {
			throw new Error('Version series could not be resolved safely.');
		}
		const expectedRevision = this.registry.getRevision();
		try {
			await executeSeriesMove(
				record,
				plans,
				this.moveEnvironment(seriesId, record, expectedRevision),
			);
		} finally {
			this.registry.rebuild();
		}
	}

	private moveEnvironment(
		seriesId: string,
		expectedSeries?: VersionSeriesRecord,
		expectedRevision?: number,
	) {
		return {
			canRollback: (plan: SeriesMovePlan) =>
				(expectedRevision === undefined ||
					this.registry.getRevision() === expectedRevision) &&
				!this.registry.getRecords().some((record) =>
					record.slots.some((slot) => slot.member?.path === plan.to)),
			getAbstractFileByPath: (path: string) =>
				this.app.vault.getAbstractFileByPath(path),
			isPathRegistered: (path: string) =>
				this.registry.getRecords().some((record) =>
					record.slots.some((slot) => slot.member?.path === path)),
			renameFile: (
				file: TFile,
				from: string,
				to: string,
				rollback: boolean,
			) => this.renamePhysicalFile(file, from, to, rollback),
			saveSlots: (slots: VersionSlotRecord[]) =>
				this.registry.saveSeriesSlots(
					seriesId,
					slots,
					expectedSeries,
					expectedRevision,
				).then(() => undefined),
		};
	}

	private async renamePhysicalFile(
		file: TFile,
		from: string,
		to: string,
		allowDuringUnload = false,
	): Promise<void> {
		if (this.unloaded && !allowDuringUnload) {
			throw new Error('Version unloaded during a series move.');
		}
		if (file.path !== from) {
			throw new Error(`File changed before move: ${from}.`);
		}
		this.internalRenamePaths.add(from);
		try {
			await renameAndWaitForExactDestination(file, from, to, {
				cancelTimeout: (handle) => window.clearTimeout(handle as number),
				getFileByPath: (path) => this.app.vault.getFileByPath(path),
				onRename: (listener) => {
					const ref = this.app.vault.on('rename', (renamedFile, oldPath) => {
						if (renamedFile instanceof TFile) {
							listener(renamedFile, oldPath);
						}
					});
					return () => this.app.vault.offref(ref);
				},
				rename: () => this.app.fileManager.renameFile(file, to),
				scheduleTimeout: (callback, delay) =>
					window.setTimeout(callback, delay),
			});
		} finally {
			this.internalRenamePaths.delete(from);
		}
	}

	private scheduleIncompleteDeleteNotice(seriesId: string): void {
		const existing = this.incompleteDeleteNoticeTimers.get(seriesId);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}
		const timer = window.setTimeout(() => {
			this.incompleteDeleteNoticeTimers.delete(seriesId);
			if (this.unloaded) {
				return;
			}
			this.registry.rebuild();
			const record = this.registry.getRecordById(seriesId);
			const group = this.registry.index.getGroupById(seriesId);
			const survivingMembers = record?.slots.filter((slot) =>
				slot.member &&
				this.app.vault.getFileByPath(slot.member.path),
			).length ?? 0;
			if (survivingMembers > 0 && group?.status !== 'healthy') {
				new Notice(this.i18n.t('view.seriesIncompleteAfterDelete'));
				this.refreshUi();
			}
		}, 250);
		this.incompleteDeleteNoticeTimers.set(seriesId, timer);
	}

	private refreshCommandNames(): void {
		for (const [key, command] of this.localizedCommands) {
			command.name = this.i18n.t(LOCALIZED_COMMAND_NAMES[key]);
		}
	}

	private openVersionManager(
		file: TFile | null,
		seriesId: string | null = null,
	): void {
		new VersionManagementModal(
			this.app,
			this.registry,
			file,
			this.settings.filenameTemplate,
			this.settings.releasedVersionDestination,
			this.i18n,
			() => this.refreshUi(),
			seriesId,
		).open();
	}

	private openDeleteVersions(
		group: VersionGroup,
		initialFile: TFile | null = null,
	): void {
		const current = this.resolveExactGroup(group.id);
		const expectedSeries = current
			? this.registry.getRecordById(current.id)
			: null;
		if (!current || !expectedSeries) {
			new Notice(this.i18n.t('view.repairVersions'));
			return;
		}
		new DeleteVersionsModal(
			this.app,
			current,
			() => {
				this.registry.rebuild();
				this.refreshUi();
			},
			async (versions) => {
				await this.registry.releaseVersionMembers(
					current.id,
					versions,
					expectedSeries,
				);
			},
			this.i18n,
			initialFile?.path ?? null,
		).open();
	}

	private openVersionSeriesPicker(
		active: TFile | null,
		allowCreate = true,
		allowedSeriesIds: ReadonlySet<string> | null = null,
	): void {
		new VersionSeriesModal(
			this.app,
			this.registry,
			active && isVersionableFile(active) ? active : null,
			(file, seriesId) => this.openVersionManager(file, seriesId),
			this.i18n,
			allowCreate,
			allowedSeriesIds,
		).open();
	}

	private openThemeBacklinks(group: VersionGroup): void {
		new ThemeBacklinksModal(this.app, group, this.i18n).open();
	}

	private openMoveTheme(group: VersionGroup): void {
		const current = this.resolveExactGroup(group.id);
		if (!current) {
			new Notice(this.i18n.t('view.repairVersions'));
			return;
		}
		new MoveThemeModal(
			this.app,
			current,
			(plans: MovePlan[]) => this.moveSeriesFiles(current.id, plans),
			() => {
				this.registry.rebuild();
				this.refreshUi();
			},
			this.i18n,
		).open();
	}

	private openVersionFileActions(
		group: VersionGroup,
		initialFile: TFile | null,
	): void {
		const current = this.resolveExactGroup(group.id);
		if (!current) {
			new Notice(this.i18n.t('view.repairVersions'));
			return;
		}
		new VersionFileActionsModal(
			this.app,
			current,
			initialFile,
			(file) => this.openDeleteVersions(current, file),
			(file) => this.openVersionManager(file, current.id),
			() => this.openMoveTheme(current),
			(file) => this.openMergeTarget(file),
			(file, version) => this.isCurrentExactVersionMember(
				current.id,
				file,
				version,
			),
			this.i18n,
		).open();
	}

	private openMergeTarget(source: TFile): void {
		if (!canMergeWithNoteComposer(this.app, source)) {
			new Notice(this.i18n.t('merge.unavailable'));
			return;
		}

		const sourceExpectation = this.captureMergeFileExpectation(source);
		if (!sourceExpectation) {
			new Notice(this.i18n.t('view.repairVersions'));
			return;
		}
		if (sourceExpectation.version === 1) {
			new Notice(this.i18n.t('merge.v1Blocked'));
			return;
		}

		new VersionMergeTargetModal(
			this.app,
			this.registry.index,
			source,
			sourceExpectation,
			this.i18n,
			(file, expectation) => this.mergeFileExpectationStillMatches(
				file,
				expectation,
			),
			() => {
				// Note Composer updates and trashes asynchronously through the
				// Vault. Let those events settle before rebuilding the relation;
				// the existing delete listener then releases the exact slot.
				window.setTimeout(() => {
					if (!this.unloaded) {
						this.registry.rebuild();
						this.scheduleUiRefresh();
					}
				}, 100);
			},
		).open();
	}

	private resolveExactGroup(seriesId: string): VersionGroup | null {
		return this.registry.resolveExactlyMatchedGroup(seriesId);
	}

	private isCurrentExactVersionMember(
		seriesId: string,
		file: TFile,
		version: number,
	): boolean {
		const group = this.resolveExactGroup(seriesId);
		const member = group?.versions.find(
			(candidate) => candidate.version === version,
		);
		const registeredMember = this.registry.getRecordById(seriesId)?.slots.find(
			(slot) => slot.version === version && slot.member?.path === file.path,
		)?.member;
		return Boolean(
			member?.file === file &&
			this.app.vault.getFileByPath(file.path) === file &&
			registeredMember &&
			memberMatchesFile(registeredMember, file),
		);
	}

	private captureMergeFileExpectation(
		file: TFile,
	): VersionMergeFileExpectation | null {
		if (this.app.vault.getFileByPath(file.path) !== file) {
			return null;
		}
		const registrations = this.registry.getRecords().flatMap((record) =>
			record.slots.flatMap((slot) =>
				slot.member?.path === file.path
					? [{ seriesId: record.id, version: slot.version }]
					: [],
			),
		);
		if (registrations.length === 0) {
			return { seriesId: null, version: null };
		}
		if (registrations.length !== 1) {
			return null;
		}
		const registration = registrations[0];
		const group = this.resolveExactGroup(registration.seriesId);
		const member = group?.versions.find(
			(candidate) => candidate.version === registration.version,
		);
		const registeredMember = this.registry
			.getRecordById(registration.seriesId)
			?.slots.find((slot) =>
				slot.version === registration.version &&
				slot.member?.path === file.path)
			?.member;
		return member?.file === file &&
			registeredMember &&
			memberMatchesFile(registeredMember, file)
			? registration
			: null;
	}

	private mergeFileExpectationStillMatches(
		file: TFile,
		expectation: VersionMergeFileExpectation,
	): boolean {
		const current = this.captureMergeFileExpectation(file);
		return Boolean(
			current &&
			current.seriesId === expectation.seriesId &&
			current.version === expectation.version,
		);
	}

}

interface LocalizedCommandNames {
	importRecovered: 'command.importRecovered';
	insertLink: 'command.insertLink';
	manageVersions: 'command.manageVersions';
	showBacklinks: 'command.showBacklinks';
	verifyInstallation: 'command.verifyInstallation';
}

const LOCALIZED_COMMAND_NAMES: LocalizedCommandNames = {
	importRecovered: 'command.importRecovered',
	insertLink: 'command.insertLink',
	manageVersions: 'command.manageVersions',
	showBacklinks: 'command.showBacklinks',
	verifyInstallation: 'command.verifyInstallation',
};

function parentPath(path: string): string {
	const separator = path.lastIndexOf('/');
	return separator < 0 ? '' : path.slice(0, separator);
}

interface FolderRenameObservation {
	newPath: string;
	oldPath: string;
}

function mapFolderChildPath(
	path: string,
	oldFolderPath: string,
	newFolderPath: string,
): string | null {
	const normalizedPath = normalizePath(path);
	const prefix = `${oldFolderPath}/`;
	if (!normalizedPath.startsWith(prefix)) {
		return null;
	}
	return normalizePath(
		`${newFolderPath}/${normalizedPath.slice(prefix.length)}`,
	);
}
