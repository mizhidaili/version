import assert from 'node:assert/strict';
import { FileView, Modal, TFile, Vault } from 'obsidian';
import { findRecoveryPath } from '../src/import-recovered-markdown';
import {
	cloneSeriesRecords,
	isValidFilenameTemplate,
	isVersionPluginDataSnapshot,
	memberMatchesFile,
	memberResolvesToFile,
	memberRecordFromFile,
	mergeExternalPluginData,
	normalizeExternalPluginData,
	normalizePluginData,
	VersionMemberRecord,
	VersionSeriesRecord,
	versionPluginDataEqual,
} from '../src/version-data';
import {
	getMissingVersions,
	getNextVersion,
	isVersionGroupExactlyResolved,
	VersionIndex,
} from '../src/version-index';
import { VersionRegistry } from '../src/version-registry';
import { getVersionFileMenuState } from '../src/version-file-menu-state';
import { SerializedDataStore } from '../src/serialized-data-store';
import { filterAllowedSeries } from '../src/series-choice-filter';
import {
	rollbackCreatedBlankFiles,
	rollbackCreatedFilesIfUnchanged,
} from '../src/created-file-rollback';
import { captureFile } from '../src/captured-file';
import {
	captureVersionForTrash,
	isUnchangedCapturedFile,
	orderVersionsForTrash,
	trashCapturedVersions,
} from '../src/delete-versions-safety';
import { SUPPORTED_LANGUAGES, VersionI18n } from '../src/i18n';
import { buildCopyFilename } from '../src/version-file-name';
import { buildMovePlans } from '../src/move-theme-plans';
import {
	countPlannedSeriesDestinationCollisions,
	executeSeriesMove,
	SeriesMoveError,
	SeriesMovePlan,
} from '../src/series-move-transaction';
import { setMenuItemWarning } from '../src/menu-item-warning';
import { renameAndWaitForExactDestination } from '../src/file-rename-completion';
import {
	pruneManagedFileMenu,
	resetManagedFileMenu,
} from '../src/managed-representative-menu';
import {
	extractNativeFileActions,
	groupCopyPathActions,
	shouldIncludeNativeFileAction,
} from '../src/native-file-action-bridge';
import {
	trackPointerFocus,
	VersionManagementModal,
} from '../src/ui/version-management-modal';
import { VersionViewDecorator } from '../src/ui/version-view-decorator';
import {
	canOpenFileRecoveryHistory,
	openFileRecoveryHistory,
} from '../src/file-recovery-compat';
import {
	buildFileExplorerVisibilityPlan,
	FileExplorerDecorator,
	getFileExplorerTitlePath,
} from '../src/ui/file-explorer-decorator';
import {
	collectBacklinkTargets,
	collectThemeBacklinks,
	formatBacklinkTargets,
} from '../src/ui/backlinks-modal';
import {
	buildVersionFileName,
	buildVersionFilePath,
	createPreparedVersionFile,
	createVersionFile,
	detectVersionFileFormat,
	getBlankCanvasContent,
	isValidExcalidrawMarkdown,
	isValidLegacyExcalidrawJson,
	prepareVersionFile,
	stripVersionFileSuffix,
	VersionFileCreationError,
	VersionFileCreationErrorCode,
} from '../src/version-file-creation';
import {
	createAndRegisterVersionFile,
	VersionFileRegistrationError,
} from '../src/version-file-creation-transaction';

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
	assert.ok(condition, message);
	assertions += 1;
}

function equal<T>(actual: T, expected: T, message: string): void {
	assert.equal(actual, expected, message);
	assertions += 1;
}

function memberAt(
	vault: Vault,
	path: string,
	lastKnownName = path.split('/').at(-1)?.replace(/\.[^.]+$/u, '') ?? path,
): VersionMemberRecord {
	const file = vault.getFileByPath(path);
	return file
		? memberRecordFromFile(file)
		: {
				identity: { ctime: 0 },
				lastKnownName,
				path,
			};
}

const VALID_EXCALIDRAW_MARKDOWN = `---
excalidraw-plugin: parsed
---
# Drawing
\`\`\`json
{"type":"excalidraw","elements":[],"appState":{}}
\`\`\`
`;

const VALID_LEGACY_EXCALIDRAW = JSON.stringify({
	appState: {},
	elements: [],
	files: {},
	source: 'https://excalidraw.com',
	type: 'excalidraw',
	version: 2,
});

function makeCreationApp(
	vault: Vault,
	plugin: unknown = null,
	enabled = plugin !== null,
): never {
	return {
		fileManager: {
			trashFile: async (file: TFile) => {
				(vault as unknown as InstanceType<typeof Vault>).delete(file);
			},
		},
		plugins: {
			enabledPlugins: new Set(
				enabled ? ['obsidian-excalidraw-plugin'] : [],
			),
			plugins: plugin === null
				? {}
				: { 'obsidian-excalidraw-plugin': plugin },
		},
		vault,
	} as never;
}

function makeExcalidrawPlugin(
	vault: Vault,
	getBlankDrawing: () => Promise<string> | string,
): unknown {
	return {
		createDrawing: async (
			filename: string,
			folderPath: string,
			content: string,
		) => vault.create(
			folderPath === '/' ? filename : `${folderPath}/${filename}`,
			content,
		),
		getBlankDrawing,
	};
}

async function run(): Promise<void> {
equal(detectVersionFileFormat('Topic.md'), 'markdown', 'Markdown format is detected');
equal(detectVersionFileFormat('Board.canvas'), 'canvas', 'Canvas format is detected');
equal(
	detectVersionFileFormat('Sketch.excalidraw.md'),
	'excalidraw',
	'compound Excalidraw Markdown is detected before generic Markdown',
);
equal(
	detectVersionFileFormat('Legacy.excalidraw'),
	'excalidraw',
	'legacy Excalidraw JSON is detected',
);
equal(
	stripVersionFileSuffix('Sketch.excalidraw.md'),
	'Sketch',
	'compound Excalidraw suffix is removed as one unit',
);
equal(
	buildVersionFileName('Draft.md', 'canvas'),
	'Draft.canvas',
	'changing format never duplicates an old supported suffix',
);
equal(
	buildVersionFilePath(' Folder ', 'Draft', 'canvas'),
	' Folder /Draft.canvas',
	'creation preserves legal leading and trailing spaces in a real parent folder',
);
assert.deepEqual(JSON.parse(getBlankCanvasContent()), { edges: [], nodes: [] });
assertions += 1;
equal(
	isValidExcalidrawMarkdown(VALID_EXCALIDRAW_MARKDOWN),
	true,
	'blank Excalidraw Markdown requires a marker and drawing payload',
);
equal(
	isValidLegacyExcalidrawJson(VALID_LEGACY_EXCALIDRAW),
	true,
	'legacy compatibility JSON is accepted as a real Excalidraw drawing',
);

const formatCreationVault = new Vault() as unknown as Vault;
const formatCreationApp = makeCreationApp(formatCreationVault);
const preparedMarkdown = await prepareVersionFile(formatCreationApp, {
	folderPath: 'Versions',
	format: 'markdown',
	stem: 'Topic V2',
});
equal(preparedMarkdown.path, 'Versions/Topic V2.md', 'Markdown uses an exact .md path');
equal(preparedMarkdown.content, '', 'Markdown starts as empty text');
const createdMarkdown = await createPreparedVersionFile(
	formatCreationApp,
	preparedMarkdown,
);
equal(
	await formatCreationVault.read(createdMarkdown),
	'',
	'prepared Markdown content is written unchanged',
);
const createdCanvas = await createVersionFile(formatCreationApp, {
	folderPath: 'Versions',
	format: 'canvas',
	stem: 'Topic V3',
});
assert.deepEqual(
	JSON.parse(await formatCreationVault.read(createdCanvas)),
	{ edges: [], nodes: [] },
	'Canvas creation writes valid empty Canvas JSON',
);
assertions += 1;

let excalidrawTemplateCalls = 0;
const excalidrawMarkdownVault = new Vault() as unknown as Vault;
const excalidrawMarkdownApp = makeCreationApp(
	excalidrawMarkdownVault,
	makeExcalidrawPlugin(excalidrawMarkdownVault, async () => {
		excalidrawTemplateCalls += 1;
		return VALID_EXCALIDRAW_MARKDOWN;
	}),
);
const preparedExcalidrawMarkdown = await prepareVersionFile(
	excalidrawMarkdownApp,
	{ folderPath: 'Versions', format: 'excalidraw', stem: 'Topic V4' },
);
equal(excalidrawTemplateCalls, 1, 'Excalidraw content comes from its enabled plugin API');
equal(
	preparedExcalidrawMarkdown.path,
	'Versions/Topic V4.excalidraw.md',
	'Excalidraw Markdown receives its compound suffix',
);
const createdExcalidrawMarkdown = await createPreparedVersionFile(
	excalidrawMarkdownApp,
	preparedExcalidrawMarkdown,
);
equal(
	await excalidrawMarkdownVault.read(createdExcalidrawMarkdown),
	VALID_EXCALIDRAW_MARKDOWN,
	'API-provided Excalidraw Markdown is written byte-for-byte',
);

const legacyExcalidrawVault = new Vault() as unknown as Vault;
const legacyExcalidrawApp = makeCreationApp(
	legacyExcalidrawVault,
	makeExcalidrawPlugin(
		legacyExcalidrawVault,
		() => VALID_LEGACY_EXCALIDRAW,
	),
);
const preparedLegacyExcalidraw = await prepareVersionFile(
	legacyExcalidrawApp,
	{ folderPath: '', format: 'excalidraw', stem: 'Legacy V2' },
);
equal(
	preparedLegacyExcalidraw.path,
	'Legacy V2.excalidraw',
	'Excalidraw compatibility mode receives a legacy .excalidraw path',
);

const disabledExcalidrawVault = new Vault() as unknown as Vault;
await assert.rejects(
	() => prepareVersionFile(makeCreationApp(disabledExcalidrawVault), {
		folderPath: '',
		format: 'excalidraw',
		stem: 'Disabled',
	}),
	(error: unknown) =>
		error instanceof VersionFileCreationError &&
		error.code === VersionFileCreationErrorCode.ExcalidrawPluginUnavailable,
);
assertions += 1;
equal(
	disabledExcalidrawVault.getFileByPath('Disabled.excalidraw.md'),
	null,
	'a disabled Excalidraw plugin never leaves a placeholder file',
);

await assert.rejects(
	() => prepareVersionFile(
		makeCreationApp(new Vault() as unknown as Vault, {
			getBlankDrawing: () => VALID_EXCALIDRAW_MARKDOWN,
		}),
		{ folderPath: '', format: 'excalidraw', stem: 'Missing API' },
	),
	(error: unknown) =>
		error instanceof VersionFileCreationError &&
		error.code === VersionFileCreationErrorCode.ExcalidrawApiUnavailable,
);
assertions += 1;
const invalidExcalidrawVault = new Vault() as unknown as Vault;
await assert.rejects(
	() => prepareVersionFile(
		makeCreationApp(
			invalidExcalidrawVault,
			makeExcalidrawPlugin(invalidExcalidrawVault, () => 'not a drawing'),
		),
		{ folderPath: '', format: 'excalidraw', stem: 'Invalid drawing' },
	),
	(error: unknown) =>
		error instanceof VersionFileCreationError &&
		error.code === VersionFileCreationErrorCode.InvalidExcalidrawContent,
);
assertions += 1;
const failingExcalidrawVault = new Vault() as unknown as Vault;
await assert.rejects(
	() => prepareVersionFile(
		makeCreationApp(
			failingExcalidrawVault,
			makeExcalidrawPlugin(failingExcalidrawVault, () => {
				throw new Error('template failed');
			}),
		),
		{ folderPath: '', format: 'excalidraw', stem: 'API failure' },
	),
	(error: unknown) =>
		error instanceof VersionFileCreationError &&
		error.code ===
			VersionFileCreationErrorCode.ExcalidrawContentPreparationFailed,
);
assertions += 1;

const excalidrawRaceVault = new Vault() as unknown as Vault;
let excalidrawRaceFolder: string | null = null;
let excalidrawRaceFilename: string | null = null;
const excalidrawRaceApp = makeCreationApp(excalidrawRaceVault, {
	createDrawing: async (
		filename: string,
		folderPath: string,
		content: string,
	) => {
		excalidrawRaceFilename = filename;
		excalidrawRaceFolder = folderPath;
		await excalidrawRaceVault.create(filename, 'user-created conflict');
		return excalidrawRaceVault.create(
			'Race_0.excalidraw.md',
			content,
		);
	},
	getBlankDrawing: () => VALID_EXCALIDRAW_MARKDOWN,
});
await assert.rejects(
	() => createVersionFile(excalidrawRaceApp, {
		folderPath: '',
		format: 'excalidraw',
		stem: 'Race',
	}),
	(error: unknown) =>
		error instanceof VersionFileCreationError &&
		error.code === VersionFileCreationErrorCode.PathConflict &&
		error.path === 'Race.excalidraw.md',
);
assertions += 1;
equal(excalidrawRaceFilename, 'Race.excalidraw.md', 'Excalidraw receives the exact filename');
equal(excalidrawRaceFolder, '/', 'root Excalidraw creation passes a truthy root folder');
equal(
	excalidrawRaceVault.getFileByPath('Race_0.excalidraw.md'),
	null,
	'an unchanged unique-name race artifact is safely removed',
);
const excalidrawRaceConflict = excalidrawRaceVault.getFileByPath(
	'Race.excalidraw.md',
);
check(excalidrawRaceConflict, 'the conflicting user file remains visible');
equal(
	await excalidrawRaceVault.read(excalidrawRaceConflict),
	'user-created conflict',
	'the conflicting user file content is preserved',
);

const editedExcalidrawRaceVault = new Vault() as unknown as Vault;
const editedExcalidrawRaceApp = makeCreationApp(editedExcalidrawRaceVault, {
	createDrawing: async (
		filename: string,
		_folderPath: string,
		content: string,
	) => {
		await editedExcalidrawRaceVault.create(filename, 'user-created conflict');
		const uniqueFile = await editedExcalidrawRaceVault.create(
			'Edited race_0.excalidraw.md',
			content,
		);
		editedExcalidrawRaceVault.modify(uniqueFile, 'user edit during API wait');
		return uniqueFile;
	},
	getBlankDrawing: () => VALID_EXCALIDRAW_MARKDOWN,
});
await assert.rejects(
	() => createVersionFile(editedExcalidrawRaceApp, {
		folderPath: '',
		format: 'excalidraw',
		stem: 'Edited race',
	}),
	(error: unknown) =>
		error instanceof VersionFileCreationError &&
		error.code === VersionFileCreationErrorCode.PathConflict &&
		error.rollbackFailures[0] === 'Edited race_0.excalidraw.md',
);
assertions += 1;
const editedExcalidrawRaceFile = editedExcalidrawRaceVault.getFileByPath(
	'Edited race_0.excalidraw.md',
);
check(editedExcalidrawRaceFile, 'an edited unique-name race artifact is preserved');
equal(
	await editedExcalidrawRaceVault.read(editedExcalidrawRaceFile),
	'user edit during API wait',
	'unsafe Excalidraw race cleanup never removes user edits',
);

const invalidExcalidrawReturnVault = new Vault() as unknown as Vault;
await assert.rejects(
	() => createVersionFile(
		makeCreationApp(invalidExcalidrawReturnVault, {
			createDrawing: async () => null,
			getBlankDrawing: () => VALID_EXCALIDRAW_MARKDOWN,
		}),
		{ folderPath: '', format: 'excalidraw', stem: 'Invalid return' },
	),
	(error: unknown) =>
		error instanceof VersionFileCreationError &&
		error.code === VersionFileCreationErrorCode.ExcalidrawApiUnavailable,
);
assertions += 1;
equal(
	invalidExcalidrawReturnVault.getFileByPath('Invalid return.excalidraw.md'),
	null,
	'an incompatible Excalidraw API return never creates or registers a placeholder',
);

const conflictCreationVault = new Vault(['Taken.md']) as unknown as Vault;
await assert.rejects(
	() => createVersionFile(makeCreationApp(conflictCreationVault), {
		folderPath: '',
		format: 'markdown',
		stem: 'Taken',
	}),
	(error: unknown) =>
		error instanceof VersionFileCreationError &&
		error.code === VersionFileCreationErrorCode.PathConflict &&
		error.path === 'Taken.md',
);
assertions += 1;

const openFailureVault = new Vault() as unknown as Vault;
let registeredAfterOpenFailure: TFile | null = null;
const openFailureResult = await createAndRegisterVersionFile(
	makeCreationApp(openFailureVault),
	{ folderPath: '', format: 'markdown', stem: 'Open failure' },
	async (file) => {
		registeredAfterOpenFailure = file;
	},
	async (file) => {
		(openFailureVault as unknown as InstanceType<typeof Vault>).delete(file);
	},
	async () => {
		throw new Error('editor unavailable');
	},
);
equal(
	registeredAfterOpenFailure,
	openFailureResult.file,
	'opening happens only after the new file is registered',
);
check(openFailureResult.openError instanceof Error, 'opening failure is reported separately');
equal(
	openFailureVault.getFileByPath('Open failure.md'),
	openFailureResult.file,
	'an opening failure preserves the committed file and relationship input',
);

const canvasRegistrationFailureVault = new Vault() as unknown as Vault;
await assert.rejects(
	() => createAndRegisterVersionFile(
		makeCreationApp(canvasRegistrationFailureVault),
		{ folderPath: '', format: 'canvas', stem: 'Rollback canvas' },
		async () => {
			throw new Error('registry write failed');
		},
		async (file) => {
			(canvasRegistrationFailureVault as unknown as InstanceType<typeof Vault>)
				.delete(file);
		},
	),
	(error: unknown) =>
		error instanceof VersionFileRegistrationError &&
		error.rollbackFailures.length === 0,
);
assertions += 1;
equal(
	canvasRegistrationFailureVault.getFileByPath('Rollback canvas.canvas'),
	null,
	'an unchanged non-empty Canvas blank is rolled back after registration fails',
);

const excalidrawRegistrationFailureVault = new Vault() as unknown as Vault;
await assert.rejects(
	() => createAndRegisterVersionFile(
		makeCreationApp(
			excalidrawRegistrationFailureVault,
			makeExcalidrawPlugin(
				excalidrawRegistrationFailureVault,
				() => VALID_EXCALIDRAW_MARKDOWN,
			),
		),
		{ folderPath: '', format: 'excalidraw', stem: 'Rollback drawing' },
		async () => {
			throw new Error('registry write failed');
		},
		async (file) => {
			(excalidrawRegistrationFailureVault as unknown as InstanceType<typeof Vault>)
				.delete(file);
		},
	),
	(error: unknown) =>
		error instanceof VersionFileRegistrationError &&
		error.rollbackFailures.length === 0,
);
assertions += 1;
equal(
	excalidrawRegistrationFailureVault.getFileByPath(
		'Rollback drawing.excalidraw.md',
	),
	null,
	'an unchanged API-created Excalidraw blank is rolled back after registration fails',
);

const editedCreationVault = new Vault() as unknown as Vault;
let editedRollbackTrashCalls = 0;
await assert.rejects(
	() => createAndRegisterVersionFile(
		makeCreationApp(editedCreationVault),
		{ folderPath: '', format: 'canvas', stem: 'User edited' },
		async (file) => {
			(editedCreationVault as unknown as InstanceType<typeof Vault>)
				.modify(file, '{"user":"content"}');
			throw new Error('registry write failed');
		},
		async () => {
			editedRollbackTrashCalls += 1;
		},
	),
	(error: unknown) =>
		error instanceof VersionFileRegistrationError &&
		error.rollbackFailures[0] === 'User edited.canvas',
);
assertions += 1;
equal(editedRollbackTrashCalls, 0, 'rollback never trashes a newly edited file');
check(
	editedCreationVault.getFileByPath('User edited.canvas'),
	'a newly edited file remains visible and readable after registration fails',
);

const attributedTargets = collectBacklinkTargets(
	{
		'Topic.md': 1,
		'Topic V3.md': 2,
		'Unrelated.md': 7,
	},
	[
		{ path: 'Topic V3.md', version: 3 },
		{ path: 'Topic.md', version: 1 },
		{ path: 'Topic V5.canvas', version: 5 },
	],
);
assert.deepEqual(
	attributedTargets,
	[
		{ count: 1, version: 1 },
		{ count: 2, version: 3 },
	],
	'backlink targets use registered paths, preserve gaps, count repeats, and sort numerically',
);
assertions += 1;
equal(
	formatBacklinkTargets(attributedTargets),
	'V1 · V3 × 2',
	'backlink target details keep compact per-version counts',
);
assert.deepEqual(
	collectBacklinkTargets(
		{
			'Arbitrary/First visual.canvas': 1,
			'Arbitrary/Second thought.md': 3,
		},
		[
			{ path: 'Arbitrary/First visual.canvas', version: 10 },
			{ path: 'Arbitrary/Second thought.md', version: 2 },
		],
	),
	[
		{ count: 3, version: 2 },
		{ count: 1, version: 10 },
	],
	'backlink targets use arbitrary registry paths and numeric V2/V10 ordering',
);
assertions += 1;

const backlinkVault = new Vault([
	'Topic.md',
	'Topic V3.md',
	'Source.md',
]);
const topicFile = backlinkVault.getFileByPath('Topic.md');
const topicV3File = backlinkVault.getFileByPath('Topic V3.md');
check(topicFile instanceof TFile, 'backlink fixture has representative file');
check(topicV3File instanceof TFile, 'backlink fixture has registered V3 file');
const groupedBacklinks = collectThemeBacklinks(
	{
		metadataCache: {
			resolvedLinks: {
				'Missing source.md': { 'Topic.md': 1 },
				'Source.md': {
					'Topic V3.md': 2,
					'Topic.md': 1,
					'Unrelated.md': 7,
				},
				'Unlinked.md': { 'Unrelated.md': 3 },
			},
		},
		vault: backlinkVault,
	} as never,
	{
		versions: [
			{
				file: topicFile,
				path: 'Topic.md',
				version: 1,
			},
			{
				file: topicV3File,
				path: 'Topic V3.md',
				version: 3,
			},
		],
	} as never,
);
equal(groupedBacklinks.length, 1, 'missing and unrelated backlink sources are omitted');
equal(groupedBacklinks[0]?.source.path, 'Source.md', 'one source remains one row');
equal(groupedBacklinks[0]?.count, 3, 'source row retains the aggregate backlink count');
assert.deepEqual(
	groupedBacklinks[0]?.targets,
	[
		{ count: 1, version: 1 },
		{ count: 2, version: 3 },
	],
	'aggregate backlink row records the exact registered target versions',
);
assertions += 1;

let warningState = false;
setMenuItemWarning({
	setWarning(value: boolean) {
		warningState = value;
	},
});
equal(warningState, true, 'supported hosts receive the destructive menu warning');
assert.doesNotThrow(() => setMenuItemWarning({}));
assertions += 1;

let nativeMenuRemoved = false;
let lateMenuRemoved = false;
let forcedCustomMenu = 0;
const managedFileMenu = {
	items: [{
		section: 'danger',
		dom: { remove: () => { nativeMenuRemoved = true; } },
	}],
	sections: ['danger'],
	setUseNativeMenu(value: boolean) {
		if (!value) {
			forcedCustomMenu += 1;
		}
		return this;
	},
};
resetManagedFileMenu(managedFileMenu as never);
equal(managedFileMenu.items.length, 0,
	'managed file menu reset removes core single-file actions');
equal(nativeMenuRemoved, true,
	'managed file menu reset detaches existing native action DOM');
managedFileMenu.items.push(
	{ section: 'version', dom: { remove() {} } },
	{ section: 'version-group', dom: { remove() {} } },
	{ section: 'action', dom: { remove: () => { lateMenuRemoved = true; } } },
);
managedFileMenu.sections.push('version', 'version-group', 'action');
pruneManagedFileMenu(managedFileMenu as never);
assert.deepEqual(
	managedFileMenu.items.map((item) => item.section),
	['version', 'version-group'],
);
assertions += 1;
assert.deepEqual(managedFileMenu.sections, ['version', 'version-group']);
assertions += 1;
equal(lateMenuRemoved, true,
	'late single-file actions are removed after file-menu dispatch');
equal(forcedCustomMenu, 2,
	'managed-file containment forces the auditable DOM menu at both stages');

const bridgedNativeActions = extractNativeFileActions({
	items: [
		{
			callback() {},
			section: 'action',
			title: '收藏',
		},
		{
			callback() {},
			section: 'version',
			title: '打开版本历史',
		},
		{
			callback() {},
			section: 'action-primary',
			title: '新建绘图文件',
		},
		{
			section: 'action',
			submenu: {
				items: [
					{ callback() {}, title: '复制 Obsidian URL' },
					{ callback() {}, title: '复制库内路径' },
					{ callback() {}, title: '复制绝对路径' },
				],
			},
			title: '复制路径',
		},
		{
			callback() {},
			icon: 'copy',
			section: 'action',
			title: '创建副本',
		},
		{
			callback() {},
			section: 'action',
			title: '将该笔记合并到',
		},
	],
});
assert.deepEqual(
	bridgedNativeActions.map((action) => action.title),
	['收藏', '打开版本历史', '复制路径'],
);
assertions += 1;
equal(
	bridgedNativeActions.at(-1)?.children.length,
	3,
	'native copy-path variants remain available as a grouped submenu',
);
equal(
	shouldIncludeNativeFileAction({
		section: 'third-party',
		title: 'Plugin action',
	}),
	true,
	'unknown third-party exact-file contributions remain available',
);
equal(
	shouldIncludeNativeFileAction({
		icon: 'git-merge',
		section: 'action',
		title: 'Untranslated merge action',
	}),
	false,
	'native Note Composer merge is reserved for Version aggregation',
);
equal(
	shouldIncludeNativeFileAction({
		section: 'action-primary',
		title: 'New drawing file',
	}),
	false,
	'Excalidraw new-drawing action is not repeated inside exact-file actions',
);
equal(
	shouldIncludeNativeFileAction({
		section: 'action-primary',
		title: '新建绘图文件',
	}),
	false,
	'localized Excalidraw new-drawing action is filtered precisely',
);
const groupedCopyPaths = groupCopyPathActions([
	{
		children: [], disabled: false, run: () => {}, section: 'action',
		title: '收藏', warning: false,
	},
	{
		children: [], disabled: false, run: () => {}, section: 'action',
		title: '复制 Obsidian URL', warning: false,
	},
	{
		children: [], disabled: false, run: () => {}, section: 'action',
		title: '复制库内相对路径', warning: false,
	},
	{
		children: [], disabled: false, run: () => {}, section: 'action',
		title: '复制绝对路径', warning: false,
	},
	{
		children: [], disabled: false, run: () => {}, section: 'version',
		title: '打开版本历史', warning: false,
	},
], '复制路径');
assert.deepEqual(
	groupedCopyPaths.map((action) => action.title),
	['收藏', '复制路径', '打开版本历史'],
);
assertions += 1;
assert.deepEqual(
	groupedCopyPaths[1]?.children.map((action) => action.title),
	['复制 Obsidian URL', '复制库内相对路径', '复制绝对路径'],
);
assertions += 1;

let openedHistoryPath = '';
const fileRecoveryApp = {
	internalPlugins: {
		plugins: {
			'file-recovery': {
				enabled: true,
				instance: {
					openModal(path: string) {
						openedHistoryPath = path;
					},
				},
			},
		},
	},
};
equal(
	canOpenFileRecoveryHistory(fileRecoveryApp as never),
	true,
	'file recovery compatibility is enabled only when its modal API exists',
);
equal(
	openFileRecoveryHistory(
		fileRecoveryApp as never,
		new TFile('Folder/History.md'),
	),
	true,
	'file recovery compatibility opens the exact selected file history',
);
equal(
	openedHistoryPath,
	'Folder/History.md',
	'file recovery receives the exact selected path',
);
equal(
	canOpenFileRecoveryHistory({} as never),
	false,
	'missing private file recovery API fails hidden',
);

const vault = new Vault([
	'实验 (V1).md',
	'实验 (V2).md',
	'别处/完全不同的名字.md',
]) as unknown as Vault;
const index = new VersionIndex(vault);
index.rebuild([]);
equal(index.getGroups().length, 0, 'filenames alone never create a series');

index.rebuild([{
	id: 'explicit',
	slots: [
		{ member: memberAt(vault, '实验 (V1).md'), version: 1 },
		{ member: memberAt(vault, '别处/完全不同的名字.md'), version: 2 },
	],
}]);
const explicit = index.getGroupById('explicit');
check(explicit, 'explicit arbitrary-name series resolves');
equal(explicit.status, 'healthy', 'all explicit members make a healthy series');
equal(explicit.topic, '实验 (V1)', 'real V1 basename represents the series');
equal(explicit.versions[1].file.basename, '完全不同的名字', 'V2 keeps its real name');

const visibilityVault = new Vault([
	'Collapsed/Representative.md',
	'Visible/Parallel.md',
	'Root parallel.canvas',
]) as unknown as Vault;
const visibilityIndex = new VersionIndex(visibilityVault);
visibilityIndex.rebuild([{
	id: 'mixed-folder-visibility',
	slots: [
		{ member: memberAt(visibilityVault, 'Root parallel.canvas'), version: 3 },
		{ member: memberAt(visibilityVault, 'Collapsed/Representative.md'), version: 1 },
		{ member: memberAt(visibilityVault, 'Visible/Parallel.md'), version: 2 },
	],
}]);
const visibilityGroup = visibilityIndex.getGroupById('mixed-folder-visibility');
check(visibilityGroup, 'mixed-folder visibility fixture resolves');
const originalVisibilityPaths = visibilityGroup.versions.map((member) => member.path);
const visibilityPlan = buildFileExplorerVisibilityPlan(visibilityGroup);
check(visibilityPlan, 'healthy mixed-folder series produces a visibility plan');
equal(
	visibilityPlan.representativePath,
	'Collapsed/Representative.md',
	'V1 remains the sole representative regardless of slot record order',
);
assert.deepEqual(
	visibilityPlan.hiddenPaths,
	['Visible/Parallel.md', 'Root parallel.canvas'],
	'mixed-parent non-V1 members are hidden by their registered paths',
);
assertions += 1;
const mountedWhileRepresentativeFolderIsCollapsed = new Set([
	'Visible/Parallel.md',
	'Root parallel.canvas',
]);
assert.deepEqual(
	visibilityPlan.hiddenPaths.filter((path) =>
		mountedWhileRepresentativeFolderIsCollapsed.has(path)),
	['Visible/Parallel.md', 'Root parallel.canvas'],
	'mounted non-representatives remain hidden when the V1 DOM row is unmounted',
);
assertions += 1;
equal(
	visibilityPlan.hiddenPaths.includes(visibilityPlan.representativePath),
	false,
	'the representative is never included in the hidden set',
);
assert.deepEqual(
	visibilityGroup.versions.map((member) => member.path),
	originalVisibilityPaths,
	'visibility planning never rewrites or relocates registered member paths',
);
assertions += 1;
equal(
	buildFileExplorerVisibilityPlan({
		...visibilityGroup,
		status: 'incomplete',
	}),
	null,
	'unresolved groups fail visible instead of hiding member rows',
);
equal(
	buildFileExplorerVisibilityPlan({
		...visibilityGroup,
		status: 'invalid',
	}),
	null,
	'invalid groups fail visible instead of hiding member rows',
);
equal(
	getFileExplorerTitlePath({
		dataset: { path: 'Desktop/Topic.md' },
		closest: () => null,
	} as unknown as HTMLElement),
	'Desktop/Topic.md',
	'desktop File Explorer titles use their own exact data-path',
);
equal(
	getFileExplorerTitlePath({
		dataset: {},
		closest: () => ({ dataset: { path: 'Mobile/Topic.md' } }),
	} as unknown as HTMLElement),
	'Mobile/Topic.md',
	'mobile drawer titles may resolve the exact data-path from their owning row',
);
equal(
	getFileExplorerTitlePath({
		dataset: {},
		closest: () => null,
	} as unknown as HTMLElement),
	null,
	'File Explorer DOM without an exact data-path is never guessed from its text',
);

function makeExplorerTitleFixture(path: string): {
	badges: Array<{ attributes: Map<string, string>; text: string }>;
	rowClasses: Set<string>;
	title: unknown;
	titleClasses: Set<string>;
} {
	const rowClasses = new Set<string>();
	const titleClasses = new Set<string>();
	const badges: Array<{ attributes: Map<string, string>; text: string }> = [];
	return {
		badges,
		rowClasses,
		title: {
			addClass: (...classes: string[]) => {
				for (const className of classes) {
					titleClasses.add(className);
				}
			},
			closest: () => ({
				addClass: (...classes: string[]) => {
					for (const className of classes) {
						rowClasses.add(className);
					}
				},
			}),
			createSpan: (options: { text: string }) => {
				const badge = {
					attributes: new Map<string, string>(),
					text: options.text,
				};
				badges.push(badge);
				return {
					setAttribute: (name: string, value: string) => {
						badge.attributes.set(name, value);
					},
				};
			},
			dataset: { path },
		},
		titleClasses,
	};
}

function makeMobileExplorerActiveTitleFixture(path: string): {
	root: unknown;
	titleClasses: Set<string>;
} {
	const titleClasses = new Set(['is-active', 'version-theme-active']);
	const row = { dataset: { path } };
	const title = {
		dataset: {},
		closest: (selector: string) =>
			selector === '.nav-file[data-path]' ? row : null,
		instanceOf: () => true,
		removeClass: (...classes: string[]) => {
			for (const className of classes) {
				titleClasses.delete(className);
			}
		},
	};
	return {
		root: {
			querySelectorAll: (selector: string) =>
				selector === '.version-theme-active' &&
				titleClasses.has('version-theme-active')
					? [title]
					: [],
		},
		titleClasses,
	};
}

const explorerDecorator = new FileExplorerDecorator(
	{ workspace: { getActiveFile: () => null } } as never,
	visibilityIndex,
	new VersionI18n('en'),
);
const explorerHarness = explorerDecorator as unknown as {
	decorateGroup(group: typeof visibilityGroup, titles: Map<string, unknown>): void;
	getRoots(): unknown[];
	observeRoot(root: unknown): void;
};
const collapsedV2Title = makeExplorerTitleFixture('Visible/Parallel.md');
const collapsedV3Title = makeExplorerTitleFixture('Root parallel.canvas');
explorerHarness.decorateGroup(
	visibilityGroup,
	new Map([
		['Root parallel.canvas', collapsedV3Title.title],
		['Visible/Parallel.md', collapsedV2Title.title],
	]),
);
equal(
	collapsedV2Title.rowClasses.has('version-file-hidden'),
	true,
	'a mounted V2 row is hidden while the V1 folder is collapsed',
);
equal(
	collapsedV3Title.rowClasses.has('version-file-hidden'),
	true,
	'a reordered mounted V3 row is hidden while the V1 row is absent',
);
const expandedV1Title = makeExplorerTitleFixture('Collapsed/Representative.md');
explorerHarness.decorateGroup(
	visibilityGroup,
	new Map([
		['Visible/Parallel.md', collapsedV2Title.title],
		['Collapsed/Representative.md', expandedV1Title.title],
		['Root parallel.canvas', collapsedV3Title.title],
	]),
);
equal(
	expandedV1Title.titleClasses.has('version-theme-entry'),
	true,
	'expanding the V1 folder restores the representative decoration',
);
equal(expandedV1Title.badges[0]?.text, '3', 'the remounted V1 badge counts real members');
const remountedV1Title = makeExplorerTitleFixture('Collapsed/Representative.md');
explorerHarness.decorateGroup(
	visibilityGroup,
	new Map([
		['Collapsed/Representative.md', remountedV1Title.title],
		['Root parallel.canvas', collapsedV3Title.title],
		['Visible/Parallel.md', collapsedV2Title.title],
	]),
);
equal(
	remountedV1Title.titleClasses.has('version-theme-entry'),
	true,
	'a newly allocated V1 DOM row is decorated after virtualization remount',
);
equal(remountedV1Title.badges[0]?.text, '3', 'a remounted V1 receives one fresh count');

let mobileActivePath = 'Collapsed/Representative.md';
const mobileActiveDecorator = new FileExplorerDecorator(
	{
		workspace: {
			getActiveFile: () => ({ path: mobileActivePath }),
		},
	} as never,
	visibilityIndex,
	new VersionI18n('en'),
);
const mobileActiveHarness = mobileActiveDecorator as unknown as {
	clearRoot(root: unknown): void;
};
const originalHTMLElementDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	'HTMLElement',
);
Object.defineProperty(globalThis, 'HTMLElement', {
	configurable: true,
	value: class ExplorerHTMLElementFixture {},
});
try {
	const mobileActiveTitle = makeMobileExplorerActiveTitleFixture(
		'Collapsed/Representative.md',
	);
	mobileActiveHarness.clearRoot(mobileActiveTitle.root);
	equal(
		mobileActiveTitle.titleClasses.has('version-theme-active'),
		false,
		'cleanup removes the Version-owned active marker from a mobile parent-path row',
	);
	equal(
		mobileActiveTitle.titleClasses.has('is-active'),
		true,
		'cleanup preserves the native active highlight when the mobile parent path is current',
	);

	mobileActiveTitle.titleClasses.add('is-active');
	mobileActiveTitle.titleClasses.add('version-theme-active');
	mobileActivePath = 'Visible/Parallel.md';
	mobileActiveHarness.clearRoot(mobileActiveTitle.root);
	equal(
		mobileActiveTitle.titleClasses.has('version-theme-active'),
		false,
		'switch cleanup removes the Version-owned marker from the former representative',
	);
	equal(
		mobileActiveTitle.titleClasses.has('is-active'),
		false,
		'switch cleanup removes a stale mirrored highlight using the mobile parent path',
	);

	mobileActivePath = 'Collapsed/Representative.md';
	const remountedMobileActiveTitle = makeMobileExplorerActiveTitleFixture(
		'Collapsed/Representative.md',
	);
	mobileActiveHarness.clearRoot(remountedMobileActiveTitle.root);
	equal(
		remountedMobileActiveTitle.titleClasses.has('version-theme-active'),
		false,
		'a remounted mobile row clears its Version-owned active marker',
	);
	equal(
		remountedMobileActiveTitle.titleClasses.has('is-active'),
		true,
		'a remounted mobile row preserves its native highlight from the parent data-path',
	);
} finally {
	if (!originalHTMLElementDescriptor) {
		Reflect.deleteProperty(globalThis, 'HTMLElement');
	} else {
		Object.defineProperty(globalThis, 'HTMLElement', {
			...originalHTMLElementDescriptor,
		});
	}
}

let observedExplorerOptions: MutationObserverInit | null = null;
class ExplorerMutationObserverFixture {
	constructor(_callback: MutationCallback) {}
	disconnect(): void {}
	observe(_target: Node, options: MutationObserverInit): void {
		observedExplorerOptions = options;
	}
}
explorerHarness.observeRoot({
	ownerDocument: {
		defaultView: { MutationObserver: ExplorerMutationObserverFixture },
	},
});
assert.deepEqual(
	observedExplorerOptions,
	{
		attributeFilter: ['data-path'],
		attributes: true,
		childList: true,
		subtree: true,
	},
	'File Explorer observes child remounts and virtualized data-path reuse only',
);
assertions += 1;

const fallbackExplorerContainer = {};
const coveredExplorerContainer = {};
const leafExplorerRoot = {
	contains: (element: unknown) => element === coveredExplorerContainer,
};
const mobileRootDecorator = new FileExplorerDecorator(
	{
		workspace: {
			containerEl: {
				querySelectorAll: () => [
					coveredExplorerContainer,
					fallbackExplorerContainer,
				],
			},
			getLeavesOfType: () => [{
				view: { containerEl: leafExplorerRoot },
			}],
		},
	} as never,
	visibilityIndex,
	new VersionI18n('en'),
);
const mobileRootHarness = mobileRootDecorator as unknown as {
	getRoots(): unknown[];
};
assert.deepEqual(
	mobileRootHarness.getRoots(),
	[leafExplorerRoot, fallbackExplorerContainer],
	'mobile drawer discovery adds a native File Explorer container only when no normal leaf root owns it',
);
assertions += 1;

const releaseVault = new Vault([
	'Release V1.md',
	'Release V2.md',
	'Release V4.md',
	'Release V5.md',
]) as unknown as Vault;
let releasedRecords = [{
	id: 'release-series',
	slots: [
		{ member: memberAt(releaseVault, 'Release V1.md'), version: 1 },
		{ member: memberAt(releaseVault, 'Release V2.md'), version: 2 },
		{ member: memberAt(releaseVault, 'Release V4.md'), version: 4 },
		{ member: memberAt(releaseVault, 'Release V5.md'), version: 5 },
	],
}];
const releaseRegistry = new VersionRegistry(
	releaseVault,
	releasedRecords,
	async (next) => {
		releasedRecords = next;
	},
);
const releaseV4 = releaseRegistry.index.getGroupById('release-series')?.versions
	.find((member) => member.version === 4);
check(releaseV4, 'release fixture resolves V4');
const releaseV4Result = await releaseRegistry.releaseVersionMembers(
	'release-series',
	[captureVersionForTrash(releaseV4)],
);
equal(releaseV4Result.dissolved, false, 'releasing a middle version keeps the series');
equal(
	releaseRegistry.index.getGroupById('release-series')?.status,
	'healthy',
	'releasing a registered member leaves the remaining series healthy',
);
assert.deepEqual(
	getMissingVersions(releaseRegistry.index.getGroupById('release-series')!),
	[3, 4],
	'a released middle member becomes a numeric gap without filename inference',
);
assertions += 1;
const releaseV5 = releaseRegistry.index.getGroupById('release-series')?.versions
	.find((member) => member.version === 5);
check(releaseV5, 'release fixture resolves the maximum member');
await releaseRegistry.releaseVersionMembers(
	'release-series',
	[captureVersionForTrash(releaseV5)],
);
assert.deepEqual(
	getMissingVersions(releaseRegistry.index.getGroupById('release-series')!),
	[],
	'releasing the maximum version removes trailing numeric gaps',
);
assertions += 1;

const dissolveReleaseVault = new Vault([
	'Dissolve release V1.md',
	'Dissolve release V2.md',
]) as unknown as Vault;
let dissolveReleaseRecords = [{
	id: 'dissolve-release',
	slots: [
		{ member: memberAt(dissolveReleaseVault, 'Dissolve release V1.md'), version: 1 },
		{ member: memberAt(dissolveReleaseVault, 'Dissolve release V2.md'), version: 2 },
	],
}];
const dissolveReleaseRegistry = new VersionRegistry(
	dissolveReleaseVault,
	dissolveReleaseRecords,
	async (next) => {
		dissolveReleaseRecords = next;
	},
);
const soleCompanion = dissolveReleaseRegistry.index
	.getGroupById('dissolve-release')?.versions.find((member) => member.version === 2);
check(soleCompanion, 'two-member release fixture resolves V2');
const dissolveResult = await dissolveReleaseRegistry.releaseVersionMembers(
	'dissolve-release',
	[captureVersionForTrash(soleCompanion)],
);
equal(dissolveResult.dissolved, true, 'releasing the sole companion explicitly dissolves the series');
equal(
	dissolveReleaseRegistry.getRecordById('dissolve-release'),
	null,
	'dissolved release leaves V1 as an ordinary unregistered file',
);
await assert.rejects(
	() => releaseRegistry.releaseVersionMembers('release-series', [
		captureVersionForTrash(
			releaseRegistry.index.getGroupById('release-series')!.versions[0],
		),
	]),
	/V1 must be replaced/u,
);
assertions += 1;

const nativeDeleteVault = new Vault([
	'Native V1.md',
	'Native V2.md',
	'Native V4.md',
]) as unknown as Vault;
let nativeDeleteRecords = [{
	id: 'native-delete',
	slots: [
		{ member: memberAt(nativeDeleteVault, 'Native V1.md'), version: 1 },
		{ member: memberAt(nativeDeleteVault, 'Native V2.md'), version: 2 },
		{ member: memberAt(nativeDeleteVault, 'Native V4.md'), version: 4 },
	],
}];
const nativeDeleteRegistry = new VersionRegistry(
	nativeDeleteVault,
	nativeDeleteRecords,
	async (next) => {
		nativeDeleteRecords = next;
	},
);
const deletedNativeV2 = nativeDeleteVault.getFileByPath('Native V2.md');
check(deletedNativeV2, 'native delete fixture resolves V2 before deletion');
(nativeDeleteVault as unknown as InstanceType<typeof Vault>).delete(deletedNativeV2);
const nativeV2Result = await nativeDeleteRegistry.recordDeletedMember(
	'native-delete',
	2,
	deletedNativeV2,
);
equal(nativeV2Result.dissolved, false, 'native deletion of a middle member keeps the series');
equal(
	nativeDeleteRegistry.index.getGroupById('native-delete')?.status,
	'healthy',
	'native deletion removes the stale slot instead of leaving an incomplete series',
);
assert.deepEqual(
	getMissingVersions(nativeDeleteRegistry.index.getGroupById('native-delete')!),
	[2, 3],
	'native middle deletion creates visible numeric gaps up to the remaining maximum',
);
assertions += 1;
const deletedNativeV1 = nativeDeleteVault.getFileByPath('Native V1.md');
check(deletedNativeV1, 'native delete fixture resolves V1 before deletion');
(nativeDeleteVault as unknown as InstanceType<typeof Vault>).delete(deletedNativeV1);
const nativeV1Result = await nativeDeleteRegistry.recordDeletedMember(
	'native-delete',
	1,
	deletedNativeV1,
);
equal(nativeV1Result.dissolved, true, 'native V1 deletion dissolves the relationship safely');
equal(
	nativeDeleteRegistry.getRecordById('native-delete'),
	null,
	'native V1 deletion cannot leave other members hidden without a representative',
);

const incompleteDeleteVault = new Vault([
	'Incomplete V1.md',
	'Incomplete V2.md',
]) as unknown as Vault;
let incompleteDeleteRecords = [{
	id: 'incomplete-native-delete',
	slots: [
		{ member: memberAt(incompleteDeleteVault, 'Incomplete V1.md'), version: 1 },
		{ member: memberAt(incompleteDeleteVault, 'Incomplete V2.md'), version: 2 },
		{ member: memberAt(incompleteDeleteVault, 'Missing V3.md'), version: 3 },
	],
}];
const incompleteDeleteRegistry = new VersionRegistry(
	incompleteDeleteVault,
	incompleteDeleteRecords,
	async (next) => {
		incompleteDeleteRecords = next;
	},
);
equal(
	incompleteDeleteRegistry.index.getGroupById('incomplete-native-delete')?.status,
	'incomplete',
	'incomplete native-delete fixture starts fail-open',
);
const incompleteV2 = incompleteDeleteVault.getFileByPath('Incomplete V2.md');
check(incompleteV2, 'incomplete native-delete fixture resolves its exact V2');
(incompleteDeleteVault as unknown as InstanceType<typeof Vault>).delete(incompleteV2);
await incompleteDeleteRegistry.recordDeletedMember(
	'incomplete-native-delete',
	2,
	incompleteV2,
);
assert.deepEqual(
	incompleteDeleteRegistry.getRecordById('incomplete-native-delete')?.slots
		.map((slot) => slot.version),
	[1, 3],
	'native deletion removes an exact resolved slot even when another slot was already unresolved',
);
assertions += 1;
const incompleteV1 = incompleteDeleteVault.getFileByPath('Incomplete V1.md');
check(incompleteV1, 'incomplete native-delete fixture still resolves its exact V1');
(incompleteDeleteVault as unknown as InstanceType<typeof Vault>).delete(incompleteV1);
await incompleteDeleteRegistry.recordDeletedMember(
	'incomplete-native-delete',
	1,
	incompleteV1,
);
equal(
	incompleteDeleteRegistry.getRecordById('incomplete-native-delete'),
	null,
	'native V1 deletion dissolves an already-incomplete relationship',
);

const visualVault = new Vault([
	'主题.md',
	'白板.canvas',
	'草图.excalidraw',
	'图片.png',
]) as unknown as Vault;
const visualIndex = new VersionIndex(visualVault);
visualIndex.rebuild([{
	id: 'visual-notes',
	slots: [
		{ member: memberAt(visualVault, '主题.md'), version: 1 },
		{ member: memberAt(visualVault, '白板.canvas'), version: 2 },
		{ member: memberAt(visualVault, '草图.excalidraw'), version: 3 },
	],
}]);
equal(
	visualIndex.getGroupById('visual-notes')?.status,
	'healthy',
	'Canvas and Excalidraw files can be explicit Version members',
);
const visualGroup = visualIndex.getGroupById('visual-notes');
check(visualGroup, 'visual series remains available for move planning');

const swapVault = new Vault() as unknown as Vault;
const swapVaultMock = swapVault as unknown as {
	add(path: string, content?: string): TFile;
	create(path: string, content: string): Promise<TFile>;
	files: Map<string, TFile>;
};
const swapV1 = swapVaultMock.add('Swap/Topic.md', '# Topic\n');
const swapV2 = swapVaultMock.add(
	'Swap/Board.canvas',
	'{"nodes":[],"edges":[]}',
);
const swapV3 = swapVaultMock.add('Swap/Angle.md', '# Angle\n');
const swapV4 = swapVaultMock.add(
	'Swap/Sketch.excalidraw',
	VALID_LEGACY_EXCALIDRAW,
);
const swapFiles = [swapV1, swapV2, swapV3, swapV4];
const swapInitialRecords = [{
	id: 'mixed-format-swap',
	slots: [
		{ member: memberRecordFromFile(swapV1), version: 1 },
		{ member: memberRecordFromFile(swapV2), version: 2 },
		{ member: memberRecordFromFile(swapV3), version: 3 },
		{ member: memberRecordFromFile(swapV4), version: 4 },
	],
}];
let swapPersistCalls = 0;
let swapPersisted: ReturnType<VersionRegistry['getRecords']> | null = null;
const swapRegistry = new VersionRegistry(
	swapVault,
	swapInitialRecords,
	async (records) => {
		swapPersistCalls += 1;
		swapPersisted = records;
	},
);
equal(
	swapRegistry.index.getGroupById('mixed-format-swap')?.status,
	'healthy',
	'a Markdown, Canvas, Markdown, and Excalidraw series starts healthy',
);
const swapSnapshot = async (): Promise<Array<{
	content: string;
	ctime: number;
	parent: string;
	path: string;
}>> => Promise.all(swapFiles.map(async (file) => ({
	content: await swapVault.read(file),
	ctime: file.stat.ctime,
	parent: file.parent?.path ?? '',
	path: file.path,
})));
const swapBefore = await swapSnapshot();
const swapFileCountBefore = swapVaultMock.files.size;
let swapCreateCalls = 0;
let swapRenameCalls = 0;
let swapTrashCalls = 0;
swapVaultMock.create = async () => {
	swapCreateCalls += 1;
	throw new Error('pure slot swap must not create a file');
};
const swapApp = {
	fileManager: {
		renameFile: async () => {
			swapRenameCalls += 1;
		},
		trashFile: async () => {
			swapTrashCalls += 1;
		},
	},
	vault: swapVault,
} as never;
let swapSavedCallbacks = 0;
const swapModal = new VersionManagementModal(
	swapApp,
	swapRegistry,
	swapV3,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => {
		swapSavedCallbacks += 1;
	},
);
const swapModalHarness = swapModal as unknown as {
	dropOnSlot(
		targetVersion: number,
		source: { kind: 'slot'; version: number },
	): void;
	renderAll(): void;
	renderAllWithMotion(): void;
	submit(): Promise<void>;
};
swapModalHarness.renderAll = () => undefined;
swapModalHarness.renderAllWithMotion = () => undefined;
swapModalHarness.dropOnSlot(4, { kind: 'slot', version: 3 });
await swapModalHarness.submit();

equal(swapPersistCalls, 1, 'a pure V3/V4 swap persists exactly once');
equal(swapSavedCallbacks, 1, 'a successful pure swap reports one saved relationship');
equal(swapCreateCalls, 0, 'a pure slot swap never creates a file');
equal(swapRenameCalls, 0, 'a pure slot swap never moves or renames a file');
equal(swapTrashCalls, 0, 'a pure slot swap never trashes a file');
equal(
	swapVaultMock.files.size,
	swapFileCountBefore,
	'a pure slot swap preserves the exact file count',
);
assert.deepEqual(
	await swapSnapshot(),
	swapBefore,
	'a pure slot swap preserves every path, ctime, parent folder, and byte content',
);
assertions += 1;
assert.deepEqual(
	swapRegistry.getRecordById('mixed-format-swap')?.slots.map((slot) => [
		slot.version,
		slot.member?.path,
	]),
	[
		[1, 'Swap/Topic.md'],
		[2, 'Swap/Board.canvas'],
		[3, 'Swap/Sketch.excalidraw'],
		[4, 'Swap/Angle.md'],
	],
	'a pure swap changes only the V3/V4 slot-to-member mapping',
);
assertions += 1;
check(swapPersisted, 'the swapped registry mapping was persisted');
const reloadedSwapRegistry = new VersionRegistry(
	swapVault,
	swapPersisted,
	async () => undefined,
);
assert.deepEqual(
	reloadedSwapRegistry.getRecordById('mixed-format-swap')?.slots.map((slot) => [
		slot.version,
		slot.member?.path,
	]),
	swapRegistry.getRecordById('mixed-format-swap')?.slots.map((slot) => [
		slot.version,
		slot.member?.path,
	]),
	'saving and reloading preserves the exact swapped mapping',
);
assertions += 1;
equal(
	reloadedSwapRegistry.index.getGroupById('mixed-format-swap')?.status,
	'healthy',
	'the reloaded mixed-format swap remains healthy',
);

const managementCreationVault = new Vault() as unknown as Vault;
const managementCreationMock = managementCreationVault as unknown as {
	add(path: string, content?: string): TFile;
};
const managementV1 = managementCreationMock.add(
	'Batch/Topic.md',
	'# Existing V1\n',
);
let managementExcalCreateCalls = 0;
const managementCreationApp = makeCreationApp(managementCreationVault, {
	createDrawing: async (
		filename: string,
		folderPath: string,
		content: string,
	) => {
		managementExcalCreateCalls += 1;
		return managementCreationVault.create(
			folderPath === '/' ? filename : `${folderPath}/${filename}`,
			content,
		);
	},
	getBlankDrawing: () => VALID_EXCALIDRAW_MARKDOWN,
});
let managementPersisted: ReturnType<VersionRegistry['getRecords']> | null = null;
const managementCreationRegistry = new VersionRegistry(
	managementCreationVault,
	[],
	async (records) => {
		managementPersisted = records;
	},
);
const managementCreationModal = new VersionManagementModal(
	managementCreationApp,
	managementCreationRegistry,
	managementV1,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => undefined,
);
const managementCreationHarness = managementCreationModal as unknown as {
	addPendingVersion(): void;
	renderAll(): void;
	slots: Array<{
		assignment: null | {
			file?: TFile;
			format?: 'markdown' | 'canvas' | 'excalidraw';
			kind: 'existing' | 'missing' | 'new';
			name?: string;
		};
		version: number;
	}>;
	submit(): Promise<void>;
};
managementCreationHarness.renderAll = () => undefined;
managementCreationHarness.addPendingVersion();
const pendingCanvas = managementCreationHarness.slots.find(
	(slot) => slot.version === 2,
)?.assignment;
check(pendingCanvas?.kind === 'new', 'management stages a real V2 creation plan');
pendingCanvas.format = 'canvas';
managementCreationHarness.addPendingVersion();
const pendingExcalidraw = managementCreationHarness.slots.find(
	(slot) => slot.version === 3,
)?.assignment;
check(pendingExcalidraw?.kind === 'new', 'management stages a real V3 creation plan');
pendingExcalidraw.format = 'excalidraw';
await managementCreationHarness.submit();

const createdManagementCanvas = managementCreationVault.getFileByPath(
	'Batch/Topic (V2).canvas',
);
check(createdManagementCanvas, 'management creates the selected Canvas member');
assert.deepEqual(
	JSON.parse(await managementCreationVault.read(createdManagementCanvas)),
	{ edges: [], nodes: [] },
	'management uses the shared valid blank Canvas content',
);
assertions += 1;
const createdManagementExcalidraw = managementCreationVault.getFileByPath(
	'Batch/Topic (V3).excalidraw.md',
);
check(createdManagementExcalidraw, 'management creates the selected Excalidraw member');
equal(
	await managementCreationVault.read(createdManagementExcalidraw),
	VALID_EXCALIDRAW_MARKDOWN,
	'management delegates Excalidraw creation to the same public API service',
);
equal(managementExcalCreateCalls, 1, 'management invokes Excalidraw createDrawing once');
check(managementPersisted, 'mixed-format management creation persists a registry');
assert.deepEqual(
	managementCreationRegistry.getRecords()[0]?.slots.map((slot) => [
		slot.version,
		slot.member?.path,
	]),
	[
		[1, 'Batch/Topic.md'],
		[2, 'Batch/Topic (V2).canvas'],
		[3, 'Batch/Topic (V3).excalidraw.md'],
	],
	'management stores only the real mixed-format member paths in numbered slots',
);
assertions += 1;
for (const slot of managementCreationRegistry.getRecords()[0]?.slots ?? []) {
	assert.deepEqual(
		Object.keys(slot.member ?? {}).sort(),
		['identity', 'lastKnownName', 'path'],
		'registry members retain path and identity metadata without a format field',
	);
	assertions += 1;
}

const managementCancelVault = new Vault(['Cancel/Board.canvas']) as unknown as Vault;
const managementCancelV1 = managementCancelVault.getFileByPath(
	'Cancel/Board.canvas',
);
check(managementCancelV1, 'management cancellation fixture has a Canvas V1');
let managementCancelCreates = 0;
let managementCancelSaves = 0;
const managementCancelVaultMock = managementCancelVault as unknown as {
	create(path: string, content: string): Promise<TFile>;
};
managementCancelVaultMock.create = async () => {
	managementCancelCreates += 1;
	throw new Error('cancelled management must not create');
};
const managementCancelRegistry = new VersionRegistry(
	managementCancelVault,
	[],
	async () => {
		managementCancelSaves += 1;
	},
);
const managementCancelModal = new VersionManagementModal(
	makeCreationApp(managementCancelVault),
	managementCancelRegistry,
	managementCancelV1,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => undefined,
);
const managementCancelHarness = managementCancelModal as unknown as {
	addPendingVersion(): void;
	close(): void;
	renderAll(): void;
	slots: Array<{
		assignment: null | { format?: string; kind: string };
		version: number;
	}>;
};
managementCancelHarness.renderAll = () => undefined;
managementCancelHarness.addPendingVersion();
equal(
	managementCancelHarness.slots.find((slot) => slot.version === 2)
		?.assignment?.format,
	'canvas',
	'a pending management file defaults to the currently opened Canvas format',
);
managementCancelHarness.close();
equal(managementCancelCreates, 0, 'Cancel leaves every staged file uncreated');
equal(managementCancelSaves, 0, 'Cancel leaves the registry unchanged');
equal(
	managementCancelVault.getFileByPath('Cancel/Board (V2).canvas'),
	null,
	'Cancel leaves no staged Canvas file in the vault',
);

const survivorOwnedVault = new Vault([
	'Survivor owned/Topic.md',
	'Survivor owned/V2.md',
	'Survivor owned/Shared released.md',
	'Survivor owned/T2.md',
]) as unknown as Vault;
const survivorOwnedReleased = survivorOwnedVault.getFileByPath(
	'Survivor owned/Shared released.md',
);
check(survivorOwnedReleased, 'overlapping release fixture resolves the shared source');
const survivorOwnedRecords = [
	{
		id: 'survivor-owned-s',
		slots: [
			{ member: memberAt(survivorOwnedVault, 'Survivor owned/Topic.md'), version: 1 },
			{ member: memberAt(survivorOwnedVault, 'Survivor owned/V2.md'), version: 2 },
			{ member: memberRecordFromFile(survivorOwnedReleased), version: 3 },
		],
	},
	{
		id: 'survivor-owned-t',
		slots: [
			{ member: memberRecordFromFile(survivorOwnedReleased), version: 1 },
			{ member: memberAt(survivorOwnedVault, 'Survivor owned/T2.md'), version: 2 },
		],
	},
];
let survivorOwnedPersists = 0;
const survivorOwnedRegistry = new VersionRegistry(
	survivorOwnedVault,
	survivorOwnedRecords,
	async () => {
		survivorOwnedPersists += 1;
	},
);
let survivorOwnedRenameCalls = 0;
const survivorOwnedModal = new VersionManagementModal(
	{
		fileManager: {
			renameFile: async (file: TFile, to: string) => {
				survivorOwnedRenameCalls += 1;
				(survivorOwnedVault as unknown as InstanceType<typeof Vault>)
					.rename(file.path, to);
			},
		},
		vault: survivorOwnedVault,
	} as never,
	survivorOwnedRegistry,
	survivorOwnedVault.getFileByPath('Survivor owned/Topic.md'),
	'{{name}} (V{{version}})',
	'vault-root',
	new VersionI18n('en'),
	() => undefined,
	'survivor-owned-s',
);
const survivorOwnedHarness = survivorOwnedModal as unknown as {
	deleteVersionSlot(version: number): void;
	renderAll(): void;
	submit(): Promise<void>;
};
survivorOwnedHarness.renderAll = () => undefined;
survivorOwnedHarness.deleteVersionSlot(3);
await survivorOwnedHarness.submit();
equal(survivorOwnedPersists, 1, 'repair saves the remaining S relationship once');
equal(
	survivorOwnedRenameCalls,
	0,
	'a released source still owned by surviving T is never moved',
);
equal(
	survivorOwnedVault.getFileByPath('Survivor owned/Shared released.md'),
	survivorOwnedReleased,
	'the surviving relationship keeps its shared source at the exact original path',
);
equal(
	survivorOwnedVault.getFileByPath('Shared released.md'),
	null,
	'no destination file is created for a source still registered by T',
);
check(
	survivorOwnedRegistry.getRecordById('survivor-owned-t')?.slots.some(
		(slot) => slot.member?.path === 'Survivor owned/Shared released.md',
	),
	'the saved registry retains T ownership of the skipped source',
);

const preSubmitRenameVault = new Vault([
	'Pre-submit rename/Topic.md',
	'Pre-submit rename/V2.md',
	'Pre-submit rename/Released.md',
]) as unknown as Vault;
const preSubmitRenamedFile = preSubmitRenameVault.getFileByPath(
	'Pre-submit rename/Released.md',
);
check(preSubmitRenamedFile, 'pre-submit rename fixture resolves its released file');
let preSubmitRenamePersists = 0;
const preSubmitRenameRegistry = new VersionRegistry(
	preSubmitRenameVault,
	[{
		id: 'pre-submit-rename',
		slots: [
			{ member: memberAt(preSubmitRenameVault, 'Pre-submit rename/Topic.md'), version: 1 },
			{ member: memberAt(preSubmitRenameVault, 'Pre-submit rename/V2.md'), version: 2 },
			{ member: memberRecordFromFile(preSubmitRenamedFile), version: 3 },
		],
	}],
	async () => {
		preSubmitRenamePersists += 1;
	},
);
let preSubmitPhysicalRenameCalls = 0;
const preSubmitRenameModal = new VersionManagementModal(
	{
		fileManager: {
			renameFile: async (file: TFile, to: string) => {
				preSubmitPhysicalRenameCalls += 1;
				(preSubmitRenameVault as unknown as InstanceType<typeof Vault>)
					.rename(file.path, to);
			},
		},
		vault: preSubmitRenameVault,
	} as never,
	preSubmitRenameRegistry,
	preSubmitRenameVault.getFileByPath('Pre-submit rename/Topic.md'),
	'{{name}} (V{{version}})',
	'vault-root',
	new VersionI18n('en'),
	() => undefined,
);
	const preSubmitRenameHarness = preSubmitRenameModal as unknown as {
		deleteVersionSlot(version: number): void;
		releasedByDeletedVersion: Map<TFile, { path: string }>;
	renderAll(): void;
	submit(): Promise<void>;
};
preSubmitRenameHarness.renderAll = () => undefined;
preSubmitRenameHarness.deleteVersionSlot(3);
equal(
		preSubmitRenameHarness.releasedByDeletedVersion.get(preSubmitRenamedFile)?.path,
	'Pre-submit rename/Released.md',
	'deleting a slot captures its immutable source path immediately',
);
(preSubmitRenameVault as unknown as InstanceType<typeof Vault>).rename(
	'Pre-submit rename/Released.md',
	'External rename/Released.md',
);
await preSubmitRenameHarness.submit();
equal(preSubmitRenamePersists, 1, 'the remaining relationship saves after the external rename');
equal(
	preSubmitPhysicalRenameCalls,
	0,
	'a released-file plan never follows a TFile renamed before submission',
);
equal(
	preSubmitRenameVault.getFileByPath('External rename/Released.md'),
	preSubmitRenamedFile,
	'the externally renamed released file remains at its user-selected path',
);
equal(
	preSubmitRenameVault.getFileByPath('Released.md'),
	null,
	'no stale release move recreates a vault-root destination',
);
equal(
	preSubmitRenameRegistry.getRecordById('pre-submit-rename')?.slots.length,
	2,
	'the submitted relationship removes only the deleted slot',
);

const registeredReleaseDestinationVault = new Vault([
	'Registered release/Topic.md',
	'Registered release/V2.md',
	'Registered release/Released.md',
	'Registered release/T2.md',
]) as unknown as Vault;
const registeredReleaseSource = registeredReleaseDestinationVault.getFileByPath(
	'Registered release/Released.md',
);
check(registeredReleaseSource, 'registry-only release fixture resolves its source');
const registeredReleaseRecords = [
	{
		id: 'registered-release-s',
		slots: [
			{
				member: memberAt(
					registeredReleaseDestinationVault,
					'Registered release/Topic.md',
				),
				version: 1,
			},
			{
				member: memberAt(
					registeredReleaseDestinationVault,
					'Registered release/V2.md',
				),
				version: 2,
			},
			{ member: memberRecordFromFile(registeredReleaseSource), version: 3 },
		],
	},
	{
		id: 'registered-release-t',
		slots: [
			{ member: memberAt(registeredReleaseDestinationVault, 'Released.md'), version: 1 },
			{
				member: memberAt(
					registeredReleaseDestinationVault,
					'Registered release/T2.md',
				),
				version: 2,
			},
		],
	},
];
let registeredReleasePersists = 0;
let registeredReleaseRenames = 0;
const registeredReleaseRegistry = new VersionRegistry(
	registeredReleaseDestinationVault,
	registeredReleaseRecords,
	async () => {
		registeredReleasePersists += 1;
	},
);
const registeredReleaseModal = new VersionManagementModal(
	{
		fileManager: {
			renameFile: async (file: TFile, to: string) => {
				registeredReleaseRenames += 1;
				(registeredReleaseDestinationVault as unknown as InstanceType<typeof Vault>)
					.rename(file.path, to);
			},
		},
		vault: registeredReleaseDestinationVault,
	} as never,
	registeredReleaseRegistry,
	registeredReleaseDestinationVault.getFileByPath('Registered release/Topic.md'),
	'{{name}} (V{{version}})',
	'vault-root',
	new VersionI18n('en'),
	() => undefined,
	'registered-release-s',
);
const registeredReleaseHarness = registeredReleaseModal as unknown as {
	deleteVersionSlot(version: number): void;
	renderAll(): void;
	submit(): Promise<void>;
};
registeredReleaseHarness.renderAll = () => undefined;
registeredReleaseHarness.deleteVersionSlot(3);
await registeredReleaseHarness.submit();
equal(
	registeredReleaseDestinationVault.getFileByPath('Released.md'),
	null,
	'the registry-only release destination remains physically absent',
);
equal(
	registeredReleaseRenames,
	0,
	'a registry-only release destination rejects the move before any rename',
);
equal(
	registeredReleasePersists,
	0,
	'a registry-only release collision is rejected before relationship persistence',
);
equal(
	registeredReleaseDestinationVault.getFileByPath(
		'Registered release/Released.md',
	),
	registeredReleaseSource,
	'the released source remains readable after the registry-only collision',
);
equal(
	registeredReleaseRegistry.getRecordById('registered-release-s')?.slots.length,
	3,
	'the rejected release submission leaves S unchanged',
);

for (const race of ['source-renamed', 'destination-occupied'] as const) {
	const folder = race === 'source-renamed'
		? 'Persist source race'
		: 'Persist destination race';
	const sourcePath = `${folder}/Released.md`;
	const destinationPath = 'Released.md';
	const raceVault = new Vault([
		`${folder}/Topic.md`,
		`${folder}/V2.md`,
		sourcePath,
	]) as unknown as Vault;
	const raceReleased = raceVault.getFileByPath(sourcePath);
	check(raceReleased, `${race} fixture resolves its released source`);
	const raceRecord = {
		id: `management-${race}`,
		slots: [
			{ member: memberAt(raceVault, `${folder}/Topic.md`), version: 1 },
			{ member: memberAt(raceVault, `${folder}/V2.md`), version: 2 },
			{ member: memberRecordFromFile(raceReleased), version: 3 },
		],
	};
	let signalPersistStarted!: () => void;
	const persistStarted = new Promise<void>((resolve) => {
		signalPersistStarted = resolve;
	});
	let releasePersist!: () => void;
	const persistGate = new Promise<void>((resolve) => {
		releasePersist = resolve;
	});
	const raceRegistry = new VersionRegistry(
		raceVault,
		[raceRecord],
		async () => {
			signalPersistStarted();
			await persistGate;
		},
	);
	let raceRenameCalls = 0;
	let raceSavedCalls = 0;
	const raceModal = new VersionManagementModal(
		{
			fileManager: {
				renameFile: async (file: TFile, to: string) => {
					raceRenameCalls += 1;
					(raceVault as unknown as InstanceType<typeof Vault>)
						.rename(file.path, to);
				},
			},
			vault: raceVault,
		} as never,
		raceRegistry,
		raceVault.getFileByPath(`${folder}/Topic.md`),
		'{{name}} (V{{version}})',
		'vault-root',
		new VersionI18n('en'),
		() => {
			raceSavedCalls += 1;
		},
	);
	const raceHarness = raceModal as unknown as {
		deleteVersionSlot(version: number): void;
		renderAll(): void;
		submit(): Promise<void>;
	};
	raceHarness.renderAll = () => undefined;
	raceHarness.deleteVersionSlot(3);
	const raceSubmission = raceHarness.submit();
	await persistStarted;
	let occupiedDestination: TFile | null = null;
	if (race === 'source-renamed') {
		(raceVault as unknown as InstanceType<typeof Vault>).rename(
			sourcePath,
			`${folder}/Externally renamed.md`,
		);
	} else {
		occupiedDestination = (raceVault as unknown as InstanceType<typeof Vault>)
			.add(destinationPath, 'external occupant');
	}
	releasePersist();
	await raceSubmission;
	equal(
		raceRenameCalls,
		0,
		`${race} during persistence prevents the stale released-file move`,
	);
	equal(raceSavedCalls, 1, `${race} still leaves the completed registry save visible`);
	if (race === 'source-renamed') {
		equal(
			raceVault.getFileByPath(`${folder}/Externally renamed.md`),
			raceReleased,
			'a source renamed during persistence remains at its external destination',
		);
		equal(
			raceVault.getFileByPath(destinationPath),
			null,
			'a stale plan does not create its old destination after the source moved',
		);
	} else {
		equal(
			raceVault.getFileByPath(sourcePath),
			raceReleased,
			'a source stays put when its destination becomes occupied during persistence',
		);
		equal(
			raceVault.getFileByPath(destinationPath),
			occupiedDestination,
			'the external destination occupant is never overwritten',
		);
	}
}

for (const rollbackCase of [
	'exact',
	'source-occupied',
	'destination-replaced',
] as const) {
	const rollbackVault = new Vault([
		'Rollback source/A.md',
		'Rollback source/B.md',
	]) as unknown as Vault;
	const rollbackA = rollbackVault.getFileByPath('Rollback source/A.md');
	const rollbackB = rollbackVault.getFileByPath('Rollback source/B.md');
	check(rollbackA, `${rollbackCase} rollback fixture resolves A`);
	check(rollbackB, `${rollbackCase} rollback fixture resolves B`);
	const rollbackRegistry = new VersionRegistry(
		rollbackVault,
		[],
		async () => undefined,
	);
	let rollbackRenameCalls = 0;
	let sourceReplacement: TFile | null = null;
	let destinationReplacement: TFile | null = null;
	const rollbackModal = new VersionManagementModal(
		{
			fileManager: {
				renameFile: async (file: TFile, to: string) => {
					rollbackRenameCalls += 1;
					if (file === rollbackB) {
						if (rollbackCase === 'source-occupied') {
							sourceReplacement = (
								rollbackVault as unknown as InstanceType<typeof Vault>
							).add('Rollback source/A.md', 'replacement');
						} else if (rollbackCase === 'destination-replaced') {
							(rollbackVault as unknown as InstanceType<typeof Vault>).rename(
								'Rollback destination/A.md',
								'External location/A.md',
							);
							destinationReplacement = (
								rollbackVault as unknown as InstanceType<typeof Vault>
							).add('Rollback destination/A.md', 'replacement');
						}
						throw new Error('second move failed');
					}
					(rollbackVault as unknown as InstanceType<typeof Vault>)
						.rename(file.path, to);
				},
			},
			vault: rollbackVault,
		} as never,
		rollbackRegistry,
		null,
		'{{name}} (V{{version}})',
		'vault-root',
		new VersionI18n('en'),
		() => undefined,
	);
	const rollbackHarness = rollbackModal as unknown as {
		moveReleasedNotes(plans: Array<{
			capture: ReturnType<typeof captureFile>;
			file: TFile;
			from: string;
			to: string;
		}>): Promise<number>;
	};
	const rollbackFailures = await rollbackHarness.moveReleasedNotes([
		{
			capture: captureFile(rollbackA),
			file: rollbackA,
			from: 'Rollback source/A.md',
			to: 'Rollback destination/A.md',
		},
		{
			capture: captureFile(rollbackB),
			file: rollbackB,
			from: 'Rollback source/B.md',
			to: 'Rollback destination/B.md',
		},
	]);
	equal(rollbackFailures, 2, `${rollbackCase} reports both interrupted move plans`);
	if (rollbackCase === 'exact') {
		equal(rollbackRenameCalls, 3, 'an exact destination is rolled back once');
		equal(
			rollbackVault.getFileByPath('Rollback source/A.md'),
			rollbackA,
			'exact rollback restores the captured TFile to its empty source',
		);
		equal(
			rollbackVault.getFileByPath('Rollback destination/A.md'),
			null,
			'exact rollback clears the completed destination',
		);
	} else {
		equal(
			rollbackRenameCalls,
			2,
			`${rollbackCase} prevents rollback from moving the wrong file`,
		);
		if (rollbackCase === 'source-occupied') {
			equal(
				rollbackVault.getFileByPath('Rollback source/A.md'),
				sourceReplacement,
				'rollback never overwrites a newly occupied source',
			);
			equal(
				rollbackVault.getFileByPath('Rollback destination/A.md'),
				rollbackA,
				'the captured file remains at its exact destination when source is occupied',
			);
		} else {
			equal(
				rollbackVault.getFileByPath('Rollback destination/A.md'),
				destinationReplacement,
				'rollback never follows or overwrites a replacement at the destination',
			);
			equal(
				rollbackVault.getFileByPath('External location/A.md'),
				rollbackA,
				'the externally moved captured file remains at its new exact location',
			);
		}
	}
}

const rollbackReloadVault = new Vault([
	'Rollback reload source/A.md',
	'Rollback reload source/B.md',
	'Rollback reload/T2.md',
]) as unknown as Vault;
const rollbackReloadA = rollbackReloadVault.getFileByPath(
	'Rollback reload source/A.md',
);
const rollbackReloadB = rollbackReloadVault.getFileByPath(
	'Rollback reload source/B.md',
);
check(rollbackReloadA, 'reload rollback fixture resolves A');
check(rollbackReloadB, 'reload rollback fixture resolves B');
const rollbackReloadRegistry = new VersionRegistry(
	rollbackReloadVault,
	[],
	async () => undefined,
);
let rollbackReloadRenameCalls = 0;
const rollbackReloadModal = new VersionManagementModal(
	{
		fileManager: {
			renameFile: async (file: TFile, to: string) => {
				rollbackReloadRenameCalls += 1;
				if (file === rollbackReloadB) {
					await rollbackReloadRegistry.reload(async () => [{
						id: 'rollback-reload-t',
						slots: [
							{
								member: memberRecordFromFile(rollbackReloadA),
								version: 1,
							},
							{
								member: memberAt(
									rollbackReloadVault,
									'Rollback reload/T2.md',
								),
								version: 2,
							},
						],
					}]);
					throw new Error('second move failed after synchronized ownership');
				}
				(rollbackReloadVault as unknown as InstanceType<typeof Vault>)
					.rename(file.path, to);
			},
		},
		vault: rollbackReloadVault,
	} as never,
	rollbackReloadRegistry,
	null,
	'{{name}} (V{{version}})',
	'vault-root',
	new VersionI18n('en'),
	() => undefined,
);
const rollbackReloadHarness = rollbackReloadModal as unknown as {
	moveReleasedNotes(plans: Array<{
		capture: ReturnType<typeof captureFile>;
		file: TFile;
		from: string;
		to: string;
	}>): Promise<number>;
};
const rollbackReloadFailures = await rollbackReloadHarness.moveReleasedNotes([
	{
		capture: captureFile(rollbackReloadA),
		file: rollbackReloadA,
		from: 'Rollback reload source/A.md',
		to: 'Rollback reload destination/A.md',
	},
	{
		capture: captureFile(rollbackReloadB),
		file: rollbackReloadB,
		from: 'Rollback reload source/B.md',
		to: 'Rollback reload destination/B.md',
	},
]);
equal(
	rollbackReloadFailures,
	2,
	'a synchronized relationship arriving during the second move aborts the batch',
);
equal(
	rollbackReloadRenameCalls,
	2,
	'a revision change prevents rollback from issuing a third physical rename',
);
equal(
	rollbackReloadVault.getFileByPath('Rollback reload destination/A.md'),
	rollbackReloadA,
	'the first moved file stays at the destination newly owned by synchronized T',
);
equal(
	rollbackReloadVault.getFileByPath('Rollback reload source/A.md'),
	null,
	'rollback does not recreate the old source after synchronized ownership changes',
);
equal(
	rollbackReloadRegistry.index.getGroupById('rollback-reload-t')?.status,
	'healthy',
	'the synchronized T relationship remains healthy after the aborted rollback',
);
equal(
	rollbackReloadRegistry.index.getGroupForFile(rollbackReloadA)?.id,
	'rollback-reload-t',
	'the first moved file remains resolvable through synchronized T ownership',
);

const standaloneVault = new Vault(['Fresh/Board.canvas']) as unknown as Vault;
const standaloneV1 = standaloneVault.getFileByPath('Fresh/Board.canvas');
check(standaloneV1, 'standalone creation fixture has an unmanaged Canvas note');
let standaloneFilesChanged = 0;
let standaloneManageCalls = 0;
let standaloneOpenedPath: string | null = null;
let standaloneClick: (() => void) | null = null;
const standaloneRegistry = new VersionRegistry(
	standaloneVault,
	[],
	async () => undefined,
);
const standaloneDecorator = new VersionViewDecorator(
	makeCreationApp(standaloneVault),
	standaloneRegistry.index,
	standaloneRegistry,
	() => '{{name}} (V{{version}})',
	() => {
		standaloneFilesChanged += 1;
	},
	() => {
		standaloneManageCalls += 1;
	},
	() => undefined,
	() => undefined,
	() => undefined,
	new VersionI18n('en'),
);
const standaloneHarness = standaloneDecorator as unknown as {
	createInitialVersion(
		view: FileView,
		v1: TFile,
		filename: string,
		format: 'markdown' | 'canvas' | 'excalidraw',
	): Promise<boolean>;
	ensureStandaloneAction(view: FileView, repair: boolean): void;
	refresh(): void;
};
standaloneHarness.refresh = () => undefined;
const standaloneAction = {
	addClass: () => undefined,
	dataset: {} as Record<string, string>,
	isConnected: true,
	remove: () => undefined,
};
const standaloneView = {
	addAction: (
		_icon: string,
		_label: string,
		callback: () => void,
	) => {
		standaloneClick = callback;
		return standaloneAction;
	},
	containerEl: { contains: () => true },
	file: standaloneV1,
	leaf: {
		openFile: async (file: TFile) => {
			standaloneOpenedPath = file.path;
		},
	},
} as unknown as FileView;
const modalTestHarness = Modal as unknown as {
	lastOpened: Modal | null;
};
modalTestHarness.lastOpened = null;
standaloneHarness.ensureStandaloneAction(standaloneView, false);
check(standaloneClick, 'an unmanaged note receives a working standalone plus action');
(standaloneClick as unknown as () => void)();
equal(
	standaloneManageCalls,
	0,
	'the unmanaged-note plus does not enter Version management',
);
const standaloneCreateModal = modalTestHarness.lastOpened as unknown as {
	filename: string;
	format: 'markdown' | 'canvas' | 'excalidraw';
	onCreate(
		filename: string,
		format: 'markdown' | 'canvas' | 'excalidraw',
	): Promise<boolean>;
	version: number;
};
check(standaloneCreateModal, 'the unmanaged-note plus opens the quick-create modal');
equal(standaloneCreateModal.version, 2, 'standalone quick-create starts at V2');
equal(
	standaloneCreateModal.filename,
	'Board (V2)',
	'standalone quick-create derives the V2 filename from the real V1 file',
);
equal(
	standaloneCreateModal.format,
	'canvas',
	'standalone quick-create defaults to the open note format',
);
equal(
	standaloneVault.getFileByPath('Fresh/Board (V2).canvas'),
	null,
	'opening or cancelling quick-create does not create a staged file',
);
equal(
	standaloneRegistry.getRecords().length,
	0,
	'opening or cancelling quick-create does not register an empty relationship',
);
equal(
	await standaloneCreateModal.onCreate('Board (V2)', 'canvas'),
	true,
	'standalone quick-create completes through the shared creation transaction',
);
const standaloneV2 = standaloneVault.getFileByPath('Fresh/Board (V2).canvas');
check(standaloneV2, 'standalone quick-create writes the selected Canvas V2');
assert.deepEqual(
	JSON.parse(await standaloneVault.read(standaloneV2)),
	{ edges: [], nodes: [] },
	'standalone quick-create uses the shared valid blank Canvas payload',
);
assertions += 1;
assert.deepEqual(
	standaloneRegistry.getRecords()[0]?.slots.map((slot) => [
		slot.version,
		slot.member?.path,
	]),
	[
		[1, 'Fresh/Board.canvas'],
		[2, 'Fresh/Board (V2).canvas'],
	],
	'standalone quick-create atomically registers the existing note as V1 and the new file as V2',
);
assertions += 1;
equal(
	standaloneOpenedPath,
	'Fresh/Board (V2).canvas',
	'the newly committed V2 opens after registration',
);
equal(standaloneFilesChanged, 1, 'successful standalone creation refreshes file UI once');

standaloneClick = null;
modalTestHarness.lastOpened = null;
standaloneHarness.ensureStandaloneAction(standaloneView, true);
check(standaloneClick, 'an incomplete relationship receives a repair action');
(standaloneClick as unknown as () => void)();
equal(
	standaloneManageCalls,
	1,
	'only the explicit repair action routes into Version management',
);
equal(
	modalTestHarness.lastOpened,
	null,
	'the repair action does not masquerade as quick-create',
);

const fileMenuQuickVault = new Vault([
	'Menu quick/Topic.md',
]) as unknown as Vault;
const fileMenuQuickV1 = fileMenuQuickVault.getFileByPath('Menu quick/Topic.md');
check(fileMenuQuickV1, 'file-menu quick-create fixture has an unmanaged note');
let fileMenuQuickPersists = 0;
let fileMenuQuickRefreshes = 0;
let fileMenuQuickOpenedPath: string | null = null;
const fileMenuQuickRegistry = new VersionRegistry(
	fileMenuQuickVault,
	[],
	async () => {
		fileMenuQuickPersists += 1;
	},
);
const fileMenuQuickView = new FileView();
fileMenuQuickView.file = fileMenuQuickV1;
const fileMenuQuickRoot = {};
const fileMenuQuickLeaf = {
	getRoot: () => fileMenuQuickRoot,
	openFile: async (file: TFile) => {
		fileMenuQuickOpenedPath = file.path;
		fileMenuQuickView.file = file;
	},
	view: fileMenuQuickView,
};
Object.assign(fileMenuQuickView, {
	containerEl: { contains: () => true },
	getViewType: () => 'markdown',
	leaf: fileMenuQuickLeaf,
});
const fileMenuQuickApp = makeCreationApp(fileMenuQuickVault) as unknown as {
	workspace: {
		getLeaf(newLeaf: boolean): typeof fileMenuQuickLeaf;
		iterateAllLeaves(callback: (leaf: typeof fileMenuQuickLeaf) => void): void;
		leftSplit: unknown;
		rightSplit: unknown;
	};
};
fileMenuQuickApp.workspace = {
	getLeaf: () => fileMenuQuickLeaf,
	iterateAllLeaves: (callback) => callback(fileMenuQuickLeaf),
	leftSplit: {},
	rightSplit: {},
};
const fileMenuQuickDecorator = new VersionViewDecorator(
	fileMenuQuickApp as never,
	fileMenuQuickRegistry.index,
	fileMenuQuickRegistry,
	() => '{{name}} (V{{version}})',
	() => {
		fileMenuQuickRefreshes += 1;
	},
	() => {
		throw new Error('Unmanaged file-menu creation must not open management.');
	},
	() => undefined,
	() => undefined,
	() => undefined,
	new VersionI18n('en'),
);
const fileMenuQuickHarness = fileMenuQuickDecorator as unknown as {
	refresh(): void;
};
fileMenuQuickHarness.refresh = () => undefined;
modalTestHarness.lastOpened = null;
fileMenuQuickDecorator.openInitialVersionModalForFile(fileMenuQuickV1);
const fileMenuQuickModal = modalTestHarness.lastOpened as unknown as {
	filename: string;
	format: 'markdown' | 'canvas' | 'excalidraw';
	onCreate(
		filename: string,
		format: 'markdown' | 'canvas' | 'excalidraw',
	): Promise<boolean>;
	version: number;
};
check(
	fileMenuQuickModal,
	'an unmanaged note file-menu opens the shared quick-create modal',
);
equal(fileMenuQuickModal.version, 2, 'file-menu quick-create starts at V2');
equal(
	fileMenuQuickModal.filename,
	'Topic (V2)',
	'file-menu quick-create derives the same V2 filename as the toolbar action',
);
equal(
	fileMenuQuickModal.format,
	'markdown',
	'file-menu quick-create follows the real source file format',
);
equal(
	fileMenuQuickVault.getFileByPath('Menu quick/Topic (V2).md'),
	null,
	'opening or cancelling file-menu quick-create performs no file write',
);
equal(
	fileMenuQuickRegistry.getRecords().length,
	0,
	'opening or cancelling file-menu quick-create performs no registry write',
);
equal(
	await fileMenuQuickModal.onCreate('Topic (V2)', 'markdown'),
	true,
	'file-menu quick-create confirms through the shared creation transaction',
);
check(
	fileMenuQuickVault.getFileByPath('Menu quick/Topic (V2).md'),
	'confirmed file-menu quick-create writes exactly one V2 file',
);
equal(fileMenuQuickPersists, 1, 'confirmed file-menu quick-create persists once');
equal(
	fileMenuQuickRegistry.getRecords().length,
	1,
	'confirmed file-menu quick-create registers one relationship',
);
equal(
	fileMenuQuickOpenedPath,
	'Menu quick/Topic (V2).md',
	'file-menu quick-create opens V2 only after registration',
);
equal(fileMenuQuickRefreshes, 1, 'successful file-menu creation refreshes once');

const staleMenuVault = new Vault([
	'Stale menu/Topic.md',
	'Stale menu/Externally registered.md',
]) as unknown as Vault;
const staleMenuV1 = staleMenuVault.getFileByPath('Stale menu/Topic.md');
const staleMenuExternalV2 = staleMenuVault.getFileByPath(
	'Stale menu/Externally registered.md',
);
check(staleMenuV1, 'stale menu fixture resolves its source note');
check(staleMenuExternalV2, 'stale menu fixture resolves its external V2');
const staleMenuRegistry = new VersionRegistry(
	staleMenuVault,
	[],
	async () => undefined,
);
const staleMenuView = new FileView();
staleMenuView.file = staleMenuV1;
const staleMenuRoot = {};
const staleMenuLeaf = {
	getRoot: () => staleMenuRoot,
	openFile: async (file: TFile) => {
		staleMenuView.file = file;
	},
	view: staleMenuView,
};
Object.assign(staleMenuView, {
	containerEl: { contains: () => true },
	getViewType: () => 'markdown',
	leaf: staleMenuLeaf,
});
const staleMenuApp = makeCreationApp(staleMenuVault) as unknown as {
	workspace: {
		getLeaf(newLeaf: boolean): typeof staleMenuLeaf;
		iterateAllLeaves(callback: (leaf: typeof staleMenuLeaf) => void): void;
		leftSplit: unknown;
		rightSplit: unknown;
	};
};
staleMenuApp.workspace = {
	getLeaf: () => staleMenuLeaf,
	iterateAllLeaves: (callback) => callback(staleMenuLeaf),
	leftSplit: {},
	rightSplit: {},
};
const staleMenuDecorator = new VersionViewDecorator(
	staleMenuApp as never,
	staleMenuRegistry.index,
	staleMenuRegistry,
	() => '{{name}} (V{{version}})',
	() => undefined,
	() => undefined,
	() => undefined,
	() => undefined,
	() => undefined,
	new VersionI18n('en'),
);
const staleMenuHarness = staleMenuDecorator as unknown as { refresh(): void };
staleMenuHarness.refresh = () => undefined;
modalTestHarness.lastOpened = null;
staleMenuDecorator.openInitialVersionModalForFile(staleMenuV1);
const staleMenuModal = modalTestHarness.lastOpened as unknown as {
	onCreate(
		filename: string,
		format: 'markdown' | 'canvas' | 'excalidraw',
	): Promise<boolean>;
};
check(staleMenuModal, 'stale file-menu fixture first opens quick-create');
await staleMenuRegistry.createSeries(staleMenuV1, staleMenuExternalV2);
equal(
	await staleMenuModal.onCreate('Topic (V2)', 'markdown'),
	false,
	'a file-menu modal safely stops when its source becomes registered',
);
equal(
	staleMenuVault.getFileByPath('Stale menu/Topic (V2).md'),
	null,
	'a stale file-menu confirmation leaves no newly created file',
);
assert.deepEqual(
	staleMenuRegistry.getRecords()[0]?.slots.map((slot) => slot.member?.path),
	['Stale menu/Topic.md', 'Stale menu/Externally registered.md'],
	'a stale file-menu confirmation preserves the externally registered relationship',
);
assertions += 1;

const initialRollbackVault = new Vault([
	'Rollback/Existing.md',
]) as unknown as Vault;
const initialRollbackV1 = initialRollbackVault.getFileByPath(
	'Rollback/Existing.md',
);
check(initialRollbackV1, 'initial rollback fixture has its original note');
const initialRollbackRegistry = new VersionRegistry(
	initialRollbackVault,
	[],
	async () => {
		throw new Error('registry save failed');
	},
);
const initialRollbackDecorator = new VersionViewDecorator(
	makeCreationApp(initialRollbackVault),
	initialRollbackRegistry.index,
	initialRollbackRegistry,
	() => '{{name}} (V{{version}})',
	() => undefined,
	() => undefined,
	() => undefined,
	() => undefined,
	() => undefined,
	new VersionI18n('en'),
);
const initialRollbackHarness = initialRollbackDecorator as unknown as {
	createInitialVersion(
		view: FileView,
		v1: TFile,
		filename: string,
		format: 'markdown' | 'canvas' | 'excalidraw',
	): Promise<boolean>;
	refresh(): void;
};
initialRollbackHarness.refresh = () => undefined;
equal(
	await initialRollbackHarness.createInitialVersion(
		{
			file: initialRollbackV1,
			leaf: { openFile: async () => undefined },
		} as unknown as FileView,
		initialRollbackV1,
		'Existing (V2)',
		'markdown',
	),
	false,
	'initial quick-create reports a failed registry commit',
);
equal(
	initialRollbackVault.getFileByPath('Rollback/Existing (V2).md'),
	null,
	'a failed initial registry commit rolls back only its unchanged new file',
);
equal(
	initialRollbackVault.getFileByPath('Rollback/Existing.md'),
	initialRollbackV1,
	'a failed initial registry commit preserves the user\'s original note',
);
equal(
	initialRollbackRegistry.getRecords().length,
	0,
	'a failed initial registry commit leaves no partial V1/V2 relationship',
);

const partialMovePlans = buildMovePlans(visualGroup, '白板所在');
equal(
	partialMovePlans.length,
	visualGroup.versions.length,
	'a series move plan covers every registered member',
);
equal(
	partialMovePlans.filter((plan) => plan.from !== plan.to).length,
	visualGroup.versions.length,
	'all visual fixture members require a move into a new destination',
);
const partialMoveVault = new Vault([
	'Target/Already there.md',
	'Elsewhere/Needs moving.md',
]) as unknown as Vault;
const partialMoveIndex = new VersionIndex(partialMoveVault);
partialMoveIndex.rebuild([{
	id: 'partial-move',
	slots: [
		{ member: memberAt(partialMoveVault, 'Target/Already there.md'), version: 1 },
		{ member: memberAt(partialMoveVault, 'Elsewhere/Needs moving.md'), version: 2 },
	],
}]);
const partialMoveGroup = partialMoveIndex.getGroupById('partial-move');
check(partialMoveGroup, 'partially colocated series resolves');
const colocatedPlans = buildMovePlans(partialMoveGroup, 'Target');
equal(colocatedPlans.length, 2, 'move planning keeps the no-op member in the transaction');
equal(
	colocatedPlans.filter((plan) => plan.from !== plan.to).length,
	1,
	'only the member outside the destination needs a physical move',
);

const collisionMoveVault = new Vault([
	'Old/Move A.md',
	'Old/Move B.md',
	'New/Move B.md',
]) as unknown as Vault;
const collisionMoveRecord = {
	id: 'collision-move',
	slots: [
		{ member: memberAt(collisionMoveVault, 'Old/Move A.md'), version: 1 },
		{ member: memberAt(collisionMoveVault, 'Old/Move B.md'), version: 2 },
	],
};
const collisionMoveA = (collisionMoveVault as unknown as InstanceType<typeof Vault>)
	.rename('Old/Move A.md', 'New/Move A.md') as unknown as TFile;
const collisionMoveB = collisionMoveVault.getFileByPath('Old/Move B.md') as TFile;
const collisionPlans: SeriesMovePlan[] = [
	{
		alreadyMoved: true,
		file: collisionMoveA,
		from: 'Old/Move A.md',
		to: 'New/Move A.md',
	},
	{ file: collisionMoveB, from: 'Old/Move B.md', to: 'New/Move B.md' },
];
let collisionPersistCalls = 0;
await assert.rejects(
	() => executeSeriesMove(collisionMoveRecord, collisionPlans, {
		getAbstractFileByPath: (path) => collisionMoveVault.getAbstractFileByPath(path),
		renameFile: async (file, from, to) => {
			check(file.path === from, 'collision rollback receives the expected source');
			(collisionMoveVault as unknown as InstanceType<typeof Vault>).rename(from, to);
		},
		saveSlots: async () => {
			collisionPersistCalls += 1;
		},
	}),
	(error: unknown) =>
		error instanceof SeriesMoveError &&
		error.kind === 'collision' &&
		error.collisionCount === 1 &&
		error.rollbackFailures === 0,
);
assertions += 1;
equal(collisionPersistCalls, 0, 'a collided series move never persists');
equal(collisionMoveA.path, 'Old/Move A.md', 'a collided native V1 move rolls back');

const registeredMoveVault = new Vault([
	'Registered move source/A.md',
	'Registered move source/B.md',
]) as unknown as Vault;
const registeredMoveRecord = {
	id: 'registered-whole-move',
	slots: [
		{ member: memberAt(registeredMoveVault, 'Registered move source/A.md'), version: 1 },
		{ member: memberAt(registeredMoveVault, 'Registered move source/B.md'), version: 2 },
	],
};
const registeredMoveA = registeredMoveVault.getFileByPath(
	'Registered move source/A.md',
);
const registeredMoveB = registeredMoveVault.getFileByPath(
	'Registered move source/B.md',
);
check(registeredMoveA, 'registry-only whole-move fixture resolves A');
check(registeredMoveB, 'registry-only whole-move fixture resolves B');
let registeredMoveRenames = 0;
let registeredMoveSaves = 0;
await assert.rejects(
	() => executeSeriesMove(
		registeredMoveRecord,
		[
			{
				file: registeredMoveA,
				from: 'Registered move source/A.md',
				to: 'Registered move destination/A.md',
			},
			{
				file: registeredMoveB,
				from: 'Registered move source/B.md',
				to: 'Registered move destination/B.md',
			},
		],
		{
			getAbstractFileByPath: (path) =>
				registeredMoveVault.getAbstractFileByPath(path),
			isPathRegistered: (path) => path === 'Registered move destination/A.md',
			renameFile: async (file, from, to) => {
				registeredMoveRenames += 1;
				(registeredMoveVault as unknown as InstanceType<typeof Vault>)
					.rename(from, to);
				check(file.path === to, 'registry-only whole-move rename reaches its target');
			},
			saveSlots: async () => {
				registeredMoveSaves += 1;
			},
		},
	),
	(error: unknown) =>
		error instanceof SeriesMoveError &&
		error.kind === 'collision' &&
		error.collisionCount === 1,
);
assertions += 1;
equal(
	registeredMoveRenames,
	0,
	'a registry-only whole-series destination rejects the batch before any rename',
);
equal(
	registeredMoveSaves,
	0,
	'a registry-only whole-series destination rejects the batch before persistence',
);
equal(
	registeredMoveVault.getFileByPath('Registered move source/A.md'),
	registeredMoveA,
	'the registry-only whole-series collision leaves A at its source',
);
equal(
	registeredMoveVault.getFileByPath('Registered move source/B.md'),
	registeredMoveB,
	'the registry-only whole-series collision leaves B at its source',
);

const synchronizedMoveVault = new Vault([
	'Whole move source/A.md',
	'Whole move source/B.md',
	'Whole move/T2.md',
]) as unknown as Vault;
const synchronizedMoveInitial = {
	id: 'whole-move-s',
	slots: [
		{ member: memberAt(synchronizedMoveVault, 'Whole move source/A.md'), version: 1 },
		{ member: memberAt(synchronizedMoveVault, 'Whole move source/B.md'), version: 2 },
	],
};
const synchronizedMoveRegistry = new VersionRegistry(
	synchronizedMoveVault,
	[synchronizedMoveInitial],
	async () => undefined,
);
const synchronizedMoveExpected = synchronizedMoveRegistry.getRecordById(
	'whole-move-s',
);
check(synchronizedMoveExpected, 'whole-series reload fixture captures S');
const synchronizedMoveRevision = synchronizedMoveRegistry.getRevision();
const synchronizedMoveA = synchronizedMoveVault.getFileByPath(
	'Whole move source/A.md',
);
const synchronizedMoveB = synchronizedMoveVault.getFileByPath(
	'Whole move source/B.md',
);
check(synchronizedMoveA, 'whole-series reload fixture resolves A');
check(synchronizedMoveB, 'whole-series reload fixture resolves B');
const synchronizedMovePlans: SeriesMovePlan[] = [
	{
		file: synchronizedMoveA,
		from: 'Whole move source/A.md',
		to: 'Whole move destination/A.md',
	},
	{
		file: synchronizedMoveB,
		from: 'Whole move source/B.md',
		to: 'Whole move destination/B.md',
	},
];
let synchronizedMoveForwardRenames = 0;
let synchronizedMoveRollbackRenames = 0;
await assert.rejects(
	() => executeSeriesMove(
		synchronizedMoveExpected,
		synchronizedMovePlans,
		{
			canRollback: (plan) =>
				synchronizedMoveRegistry.getRevision() === synchronizedMoveRevision &&
				!synchronizedMoveRegistry.getRecords().some((record) =>
					record.slots.some((slot) => slot.member?.path === plan.to)),
			getAbstractFileByPath: (path) =>
				synchronizedMoveVault.getAbstractFileByPath(path),
			renameFile: async (file, from, to, rollback) => {
				if (rollback) {
					synchronizedMoveRollbackRenames += 1;
				} else {
					synchronizedMoveForwardRenames += 1;
				}
				(synchronizedMoveVault as unknown as InstanceType<typeof Vault>)
					.rename(from, to);
				check(file.path === to, 'whole-series move reaches its exact requested path');
			},
			saveSlots: async (slots) => {
				await synchronizedMoveRegistry.reload(async () => [
					synchronizedMoveExpected,
					{
						id: 'whole-move-t',
						slots: [
							{
								member: memberRecordFromFile(synchronizedMoveA),
								version: 1,
							},
							{
								member: memberAt(
									synchronizedMoveVault,
									'Whole move/T2.md',
								),
								version: 2,
							},
						],
					},
				]);
				await synchronizedMoveRegistry.saveSeriesSlots(
					'whole-move-s',
					slots,
					synchronizedMoveExpected,
					synchronizedMoveRevision,
				);
			},
		},
	),
	(error: unknown) =>
		error instanceof SeriesMoveError &&
		error.kind === 'manual-repair' &&
		error.rollbackFailures === 2,
);
assertions += 1;
equal(
	synchronizedMoveForwardRenames,
	2,
	'the whole-series transaction completes both forward moves before persistence',
);
equal(
	synchronizedMoveRollbackRenames,
	0,
	'a changed revision and destination ownership prevent every stale rollback rename',
);
equal(
	synchronizedMoveVault.getFileByPath('Whole move destination/A.md'),
	synchronizedMoveA,
	'the file claimed by synchronized T remains at its registered destination',
);
equal(
	synchronizedMoveRegistry.index.getGroupById('whole-move-t')?.status,
	'healthy',
	'synchronized T remains healthy after the whole-series transaction aborts',
);
equal(
	synchronizedMoveRegistry.index.getGroupForFile(synchronizedMoveA)?.id,
	'whole-move-t',
	'the claimed destination remains resolvable through synchronized T',
);

// Obsidian 1.13 may return from FileManager.renameFile before Vault updates the
// TFile and emits `rename`. The first native V1 drag must wait for that exact
// event instead of failing its final barrier and succeeding only on retry.
const delayedMoveVault = new Vault([
	'Old/Delayed V1.md',
	'Old/Delayed V2.md',
	'Old/Delayed V3.canvas',
]) as unknown as Vault;
const delayedMoveRecord = {
	id: 'delayed-first-native-move',
	slots: [
		{ member: memberAt(delayedMoveVault, 'Old/Delayed V1.md'), version: 1 },
		{ member: memberAt(delayedMoveVault, 'Old/Delayed V2.md'), version: 2 },
		{ member: memberAt(delayedMoveVault, 'Old/Delayed V3.canvas'), version: 3 },
	],
};
const delayedV1 = (delayedMoveVault as unknown as InstanceType<typeof Vault>)
	.rename('Old/Delayed V1.md', 'New/Delayed V1.md') as unknown as TFile;
const delayedV2 = delayedMoveVault.getFileByPath('Old/Delayed V2.md') as TFile;
const delayedV3 = delayedMoveVault.getFileByPath('Old/Delayed V3.canvas') as TFile;
const delayedRenameListeners = new Set<(file: TFile, oldPath: string) => void>();
let delayedPersistCalls = 0;
await executeSeriesMove(delayedMoveRecord, [
	{
		alreadyMoved: true,
		file: delayedV1,
		from: 'Old/Delayed V1.md',
		to: 'New/Delayed V1.md',
	},
	{
		file: delayedV2,
		from: 'Old/Delayed V2.md',
		to: 'New/Delayed V2.md',
	},
	{
		file: delayedV3,
		from: 'Old/Delayed V3.canvas',
		to: 'New/Delayed V3.canvas',
	},
], {
	getAbstractFileByPath: (path) => delayedMoveVault.getAbstractFileByPath(path),
	renameFile: async (file, from, to) => {
		await renameAndWaitForExactDestination(file, from, to, {
			cancelTimeout: (handle) =>
				clearTimeout(handle as ReturnType<typeof setTimeout>),
			getFileByPath: (path) => delayedMoveVault.getFileByPath(path),
			onRename: (listener) => {
				delayedRenameListeners.add(listener);
				return () => delayedRenameListeners.delete(listener);
			},
			rename: () => {
				setTimeout(() => {
					(delayedMoveVault as unknown as InstanceType<typeof Vault>)
						.rename(from, to);
					for (const listener of delayedRenameListeners) {
						listener(file, from);
					}
				}, 5);
			},
			scheduleTimeout: (callback, delay) => setTimeout(callback, delay),
		}, 250);
	},
	saveSlots: async () => {
		delayedPersistCalls += 1;
	},
});
equal(delayedPersistCalls, 1, 'the first delayed native V1 drag persists once');
equal(delayedV1.path, 'New/Delayed V1.md', 'the already-moved V1 stays at its destination');
equal(delayedV2.path, 'New/Delayed V2.md', 'the delayed V2 move completes before commit');
equal(delayedV3.path, 'New/Delayed V3.canvas', 'the delayed V3 move completes before commit');
equal(delayedRenameListeners.size, 0, 'exact rename listeners are removed after the transaction');

const preflightExisting = collisionMoveVault.getFileByPath('Old/Move A.md');
check(preflightExisting, 'planned-destination fixture resolves its existing member');
equal(
	countPlannedSeriesDestinationCollisions(
		[{ file: preflightExisting, to: preflightExisting.path }],
		(path) => collisionMoveVault.getAbstractFileByPath(path),
	),
	0,
	'preflight permits an existing member to keep its own exact path',
);
equal(
	countPlannedSeriesDestinationCollisions(
		[{ to: 'New/Move B.md' }],
		(path) => collisionMoveVault.getAbstractFileByPath(path),
	),
	1,
	'preflight rejects a pending blank file whose destination is occupied',
);
equal(
	countPlannedSeriesDestinationCollisions(
		[{ to: 'New/Duplicate.md' }, { to: 'New/Duplicate.md' }],
		(path) => collisionMoveVault.getAbstractFileByPath(path),
	),
	2,
	'preflight rejects every duplicate projected destination before mutation',
);

const blockedRollbackVault = new Vault([
	'Old/Block A.md',
	'Old/Block B.md',
	'New/Block B.md',
]) as unknown as Vault;
const blockedRollbackRecord = {
	id: 'blocked-rollback',
	slots: [
		{ member: memberAt(blockedRollbackVault, 'Old/Block A.md'), version: 1 },
		{ member: memberAt(blockedRollbackVault, 'Old/Block B.md'), version: 2 },
	],
};
const blockedRollbackA = (blockedRollbackVault as unknown as InstanceType<typeof Vault>)
	.rename('Old/Block A.md', 'New/Block A.md') as unknown as TFile;
(blockedRollbackVault as unknown as InstanceType<typeof Vault>)
	.add('Old/Block A.md', 'external replacement');
const blockedRollbackB = blockedRollbackVault.getFileByPath('Old/Block B.md') as TFile;
await assert.rejects(
	() => executeSeriesMove(blockedRollbackRecord, [
		{
			alreadyMoved: true,
			file: blockedRollbackA,
			from: 'Old/Block A.md',
			to: 'New/Block A.md',
		},
		{ file: blockedRollbackB, from: 'Old/Block B.md', to: 'New/Block B.md' },
	], {
		getAbstractFileByPath: (path) => blockedRollbackVault.getAbstractFileByPath(path),
		renameFile: async (file, from, to) => {
			check(file.path === from, 'blocked rollback receives the expected source');
			(blockedRollbackVault as unknown as InstanceType<typeof Vault>).rename(from, to);
		},
		saveSlots: async () => {},
	}),
	(error: unknown) =>
		error instanceof SeriesMoveError &&
		error.kind === 'manual-repair' &&
		error.collisionCount === 1 &&
		error.rollbackFailures === 1,
);
assertions += 1;
equal(
	blockedRollbackA.path,
	'New/Block A.md',
	'a blocked V1 rollback remains visible at its actual path',
);

const barrierVault = new Vault([
	'Old/Barrier A.md',
	'Old/Barrier B.md',
]) as unknown as Vault;
const barrierRecord = {
	id: 'commit-barrier',
	slots: [
		{ member: memberAt(barrierVault, 'Old/Barrier A.md'), version: 1 },
		{ member: memberAt(barrierVault, 'Old/Barrier B.md'), version: 2 },
	],
};
const barrierA = barrierVault.getFileByPath('Old/Barrier A.md') as TFile;
const barrierB = barrierVault.getFileByPath('Old/Barrier B.md') as TFile;
let barrierPersistCalls = 0;
await assert.rejects(
	() => executeSeriesMove(barrierRecord, [
		{ file: barrierA, from: 'Old/Barrier A.md', to: 'New/Barrier A.md' },
		{ file: barrierB, from: 'Old/Barrier B.md', to: 'New/Barrier B.md' },
	], {
		getAbstractFileByPath: (path) => barrierVault.getAbstractFileByPath(path),
		renameFile: async (_file, from, to, rollback) => {
			(barrierVault as unknown as InstanceType<typeof Vault>).rename(from, to);
			if (!rollback && to === 'New/Barrier B.md') {
				(barrierVault as unknown as InstanceType<typeof Vault>)
					.rename('New/Barrier A.md', 'External/Barrier A.md');
			}
		},
		saveSlots: async () => {
			barrierPersistCalls += 1;
		},
	}),
	(error: unknown) =>
		error instanceof SeriesMoveError &&
		error.kind === 'manual-repair' &&
		error.rollbackFailures === 1,
);
assertions += 1;
equal(barrierPersistCalls, 0, 'the final move barrier rejects an external third path');
equal(barrierA.path, 'External/Barrier A.md', 'the externally moved file is not chased');
equal(barrierB.path, 'Old/Barrier B.md', 'other completed moves still roll back');

const persistMoveVault = new Vault([
	'Old/Persist A.md',
	'Old/Persist B.md',
]) as unknown as Vault;
const persistMoveRecord = {
	id: 'persist-failure',
	slots: [
		{ member: memberAt(persistMoveVault, 'Old/Persist A.md'), version: 1 },
		{ member: memberAt(persistMoveVault, 'Old/Persist B.md'), version: 2 },
	],
};
const persistMoveA = persistMoveVault.getFileByPath('Old/Persist A.md') as TFile;
const persistMoveB = persistMoveVault.getFileByPath('Old/Persist B.md') as TFile;
await assert.rejects(
	() => executeSeriesMove(persistMoveRecord, [
		{ file: persistMoveA, from: 'Old/Persist A.md', to: 'New/Persist A.md' },
		{ file: persistMoveB, from: 'Old/Persist B.md', to: 'New/Persist B.md' },
	], {
		getAbstractFileByPath: (path) => persistMoveVault.getAbstractFileByPath(path),
		renameFile: async (_file, from, to) => {
			(persistMoveVault as unknown as InstanceType<typeof Vault>).rename(from, to);
		},
		saveSlots: async () => {
			throw new Error('persistence unavailable');
		},
	}),
	/persistence unavailable/u,
);
assertions += 1;
equal(persistMoveA.path, 'Old/Persist A.md', 'persistence failure restores V1');
equal(persistMoveB.path, 'Old/Persist B.md', 'persistence failure restores V2');
visualIndex.rebuild([{
	id: 'unsupported-asset',
	slots: [
		{ member: memberAt(visualVault, '主题.md'), version: 1 },
		{ member: memberAt(visualVault, '图片.png'), version: 2 },
	],
}]);
equal(
	visualIndex.getGroupById('unsupported-asset')?.status,
	'incomplete',
	'ordinary binary assets are not silently treated as note versions',
);

const crossDeviceIdentity = (ctime: number): VersionMemberRecord => ({
	identity: { ctime },
	lastKnownName: 'Cross-device member',
	path: 'Cross-device member.md',
});
check(
	memberResolvesToFile(
		crossDeviceIdentity(1_786_034_715_000),
		{ stat: { ctime: 1_786_034_715_261 } },
	),
	'a whole-second identity resolves the observed same-second millisecond value',
);
check(
	memberResolvesToFile(
		crossDeviceIdentity(1_786_034_715_974),
		{ stat: { ctime: 1_786_034_715_000 } },
	),
	'a millisecond identity resolves the observed same-second whole-second value',
);
equal(
	memberResolvesToFile(
		crossDeviceIdentity(1_786_034_715_261),
		{ stat: { ctime: 1_786_034_715_262 } },
	),
	false,
	'two millisecond-precision identities still require exact equality',
);
equal(
	memberResolvesToFile(
		crossDeviceIdentity(1_786_034_715_999),
		{ stat: { ctime: 1_786_034_716_000 } },
	),
	false,
	'a whole-second identity never matches across a creation-second boundary',
);
equal(
	memberResolvesToFile(
		crossDeviceIdentity(1_786_034_715_000),
		{ stat: { ctime: 1_786_034_716_000 } },
	),
	false,
	'whole-second identities one second apart remain different files',
);
equal(
	memberResolvesToFile(
		{ lastKnownName: 'No identity', path: 'No identity.md' },
		{ stat: { ctime: 1_786_034_715_000 } },
	),
	false,
	'a missing stored identity never matches by path alone',
);
equal(
	memberResolvesToFile(
		crossDeviceIdentity(1_786_034_715_000),
		{ stat: { ctime: Number.NaN } },
	),
	false,
	'an invalid live creation time never activates a relationship',
);
equal(
	memberMatchesFile(
		crossDeviceIdentity(0),
		{ stat: { ctime: 261 } },
	),
	false,
	'a zero identity sentinel is never treated as a coarse creation timestamp',
);
equal(
	memberMatchesFile(
		crossDeviceIdentity(1_786_034_715_000),
		{ stat: { ctime: 1_786_034_715_261 } },
	),
	false,
	'destructive identity checks never use cross-device coarse-time compatibility',
);

const crossDeviceVault = new Vault([
	'Cross-device topic.md',
	'Cross-device board.canvas',
	'Cross-device sketch.excalidraw',
]) as unknown as Vault;
const crossDeviceCtimes = [
	1_786_034_715_261,
	1_786_044_691_029,
	1_786_044_691_029,
];
const crossDevicePaths = [
	'Cross-device topic.md',
	'Cross-device board.canvas',
	'Cross-device sketch.excalidraw',
];
for (const [index, path] of crossDevicePaths.entries()) {
	const file = crossDeviceVault.getFileByPath(path);
	check(file, `cross-device fixture resolves ${path}`);
	file.stat.ctime = crossDeviceCtimes[index];
}
const crossDeviceIndex = new VersionIndex(crossDeviceVault);
crossDeviceIndex.rebuild([{
	id: 'cross-device-mixed-format',
	slots: crossDevicePaths.map((path, index) => ({
		member: {
			identity: {
				ctime: Math.floor(crossDeviceCtimes[index] / 1_000) * 1_000,
			},
			lastKnownName: path.replace(/\.[^.]+$/u, ''),
			path,
		},
		version: index + 1,
	})),
}]);
equal(
	crossDeviceIndex.getGroupById('cross-device-mixed-format')?.status,
	'healthy',
	'a mixed-format series survives an observed whole-second precision mismatch',
);
const compatibleCrossDeviceGroup = crossDeviceIndex.getGroupById(
	'cross-device-mixed-format',
);
check(compatibleCrossDeviceGroup, 'compatible cross-device group remains addressable');
equal(
	compatibleCrossDeviceGroup.identityStatus,
	'compatible',
	'the index exposes that the group was resolved only through precision compatibility',
);
equal(
	isVersionGroupExactlyResolved(compatibleCrossDeviceGroup),
	false,
	'a precision-compatible group is not authorized as an exact mutable group',
);
const compatibleVisibilityPlan = buildFileExplorerVisibilityPlan(
	compatibleCrossDeviceGroup,
);
check(
	compatibleVisibilityPlan,
	'a precision-compatible healthy relationship has a registry-backed visibility plan',
);
equal(
	compatibleVisibilityPlan.representativePath,
	'Cross-device topic.md',
	'a compatible group still uses its real registered V1 as the sole representative',
);
assert.deepEqual(
	compatibleVisibilityPlan.hiddenPaths,
	[
		'Cross-device board.canvas',
		'Cross-device sketch.excalidraw',
	],
	'compatible cross-device members are hidden by registry path without authorizing mutation',
);
assertions += 1;

let compatibleMutationPersists = 0;
const compatibleRegistry = new VersionRegistry(
	crossDeviceVault,
	[{
		id: 'cross-device-mixed-format',
		slots: crossDevicePaths.map((path, index) => ({
			member: {
				identity: {
					ctime: Math.floor(crossDeviceCtimes[index] / 1_000) * 1_000,
				},
				lastKnownName: path.replace(/\.[^.]+$/u, ''),
				path,
			},
			version: index + 1,
		})),
	}],
	async () => {
		compatibleMutationPersists += 1;
	},
);
await assert.rejects(
	() => compatibleRegistry.dissolveSeries('cross-device-mixed-format'),
	/changed or disappeared/u,
);
assertions += 1;
const compatibleNewMember = (crossDeviceVault as unknown as InstanceType<typeof Vault>)
	.add('Cross-device new member.md') as unknown as TFile;
await assert.rejects(
	() => compatibleRegistry.addMember(
		'cross-device-mixed-format',
		4,
		compatibleNewMember,
	),
	/changed or disappeared/u,
);
assertions += 1;
equal(
	compatibleMutationPersists,
	0,
	'precision compatibility never authorizes the general registry mutation path',
);

function makeCompatibleAppendFixture(
	prefix: string,
	direction: 'live-coarse' | 'stored-coarse',
): {
	initialRecord: VersionSeriesRecord;
	persisted: VersionSeriesRecord[][];
	registry: VersionRegistry;
	vault: Vault;
} {
	const paths = [
		`${prefix}/Topic.md`,
		`${prefix}/Board.canvas`,
		`${prefix}/Sketch.excalidraw`,
	];
	const preciseCtimes = [
		1_786_100_001_261,
		1_786_100_002_529,
		1_786_100_003_974,
	];
	const fixtureVault = new Vault(paths) as unknown as Vault;
	const slots = paths.map((path, index) => {
		const file = fixtureVault.getFileByPath(path);
		check(file, `compatible append fixture resolves ${path}`);
		const coarse = Math.floor(preciseCtimes[index] / 1_000) * 1_000;
		file.stat.ctime = direction === 'live-coarse'
			? coarse
			: preciseCtimes[index];
		return {
			member: {
				identity: {
					ctime: direction === 'stored-coarse'
						? coarse
						: preciseCtimes[index],
				},
				lastKnownName: file.basename,
				path,
			},
			version: index + 1,
		};
	});
	const initialRecord: VersionSeriesRecord = {
		id: `${prefix}-series`,
		slots,
	};
	const persisted: VersionSeriesRecord[][] = [];
	const registry = new VersionRegistry(
		fixtureVault,
		[initialRecord],
		async (records) => {
			persisted.push(cloneSeriesRecords(records));
		},
	);
	return { initialRecord, persisted, registry, vault: fixtureVault };
}

for (const direction of ['stored-coarse', 'live-coarse'] as const) {
	const fixture = makeCompatibleAppendFixture(`Append ${direction}`, direction);
	const before = cloneSeriesRecords([fixture.initialRecord])[0];
	equal(
		fixture.registry.index.getGroupById(before.id)?.identityStatus,
		'compatible',
		`${direction} fixture starts as a healthy precision-compatible group`,
	);
	const expectation = fixture.registry.captureAppendExpectation(before.id);
	check(expectation, `${direction} compatible group receives append-only authorization`);
	const v4 = (fixture.vault as unknown as InstanceType<typeof Vault>)
		.add(`Append ${direction}/New V4.md`, '');
	v4.stat.ctime = 1_786_100_004_777;
	await fixture.registry.appendMemberToResolvedSeries(expectation, 4, v4);
	equal(
		fixture.persisted.length,
		1,
		`${direction} compatible append persists exactly once`,
	);
	const after = fixture.registry.getRecordById(before.id);
	check(after, `${direction} compatible append preserves the relationship`);
	assert.deepEqual(
		after.slots.slice(0, before.slots.length),
		before.slots,
		`${direction} compatible append preserves every old slot, order, path, name, and ctime byte-for-byte`,
	);
	assertions += 1;
	assert.deepEqual(
		after.slots.at(-1),
		{ member: memberRecordFromFile(v4), version: 4 },
		`${direction} compatible append adds only the exact new V4 member`,
	);
	assertions += 1;
	equal(
		fixture.registry.index.getGroupById(before.id)?.identityStatus,
		'compatible',
		`${direction} append never rebases the old cross-device identities`,
	);
	const reloaded = new VersionRegistry(
		fixture.vault,
		fixture.persisted[0],
		async () => undefined,
	);
	assert.deepEqual(
		reloaded.getRecordById(before.id),
		after,
		`${direction} append mapping survives a registry reload exactly`,
	);
	assertions += 1;
	const replayCandidate = (fixture.vault as unknown as InstanceType<typeof Vault>)
		.add(`Append ${direction}/Replay V5.md`, '');
	await assert.rejects(
		() => fixture.registry.appendMemberToResolvedSeries(
			expectation,
			5,
			replayCandidate,
		),
		/authorization is no longer valid/u,
	);
	assertions += 1;
	equal(
		fixture.persisted.length,
		1,
		`${direction} append authorization is one-shot and cannot persist twice`,
	);
}

class VersionToolbarElementFixture {
	readonly attributes = new Map<string, string>();
	readonly children: VersionToolbarElementFixture[] = [];
	readonly classNames = new Set<string>();
	readonly dataset: Record<string, string> = {};
	readonly listeners = new Map<string, Array<(event: unknown) => void>>();
	ariaLabel = '';
	clientHeight = 0;
	isConnected = true;
	ownerDocument = { defaultView: null };
	parent: VersionToolbarElementFixture | null = null;
	scrollHeight = 0;
	scrollTop = 0;
	textContent = '';
	type = '';

	readonly classList = {
		add: (...classNames: string[]) => {
			for (const className of classNames) {
				this.classNames.add(className);
			}
		},
		contains: (className: string) => this.classNames.has(className),
		remove: (...classNames: string[]) => {
			for (const className of classNames) {
				this.classNames.delete(className);
			}
		},
		toggle: (className: string, force?: boolean) => {
			const shouldHave = force ?? !this.classNames.has(className);
			if (shouldHave) {
				this.classNames.add(className);
			} else {
				this.classNames.delete(className);
			}
			return shouldHave;
		},
	};

	addClass(...classNames: string[]): void {
		this.classList.add(...classNames);
	}

	removeClass(...classNames: string[]): void {
		this.classList.remove(...classNames);
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	click(): void {
		for (const listener of this.listeners.get('click') ?? []) {
			listener({
				detail: 1,
				preventDefault: () => undefined,
				stopPropagation: () => undefined,
			});
		}
	}

	contains(element: unknown): boolean {
		return element === this || this.children.some((child) => child.contains(element));
	}

	createDiv(options: {
		attr?: Record<string, string>;
		cls?: string | string[];
		text?: string;
	} = {}): VersionToolbarElementFixture {
		return this.createChild(options);
	}

	createEl(
		_tag: string,
		options: {
			attr?: Record<string, string>;
			cls?: string | string[];
			text?: string;
		} = {},
	): VersionToolbarElementFixture {
		return this.createChild(options);
	}

	createSpan(options: {
		attr?: Record<string, string>;
		cls?: string | string[];
		text?: string;
	} = {}): VersionToolbarElementFixture {
		return this.createChild(options);
	}

	empty(): void {
		for (const child of this.children) {
			child.isConnected = false;
		}
		this.children.length = 0;
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	querySelectorAll<T>(_selector: string): T[] {
		const matches: VersionToolbarElementFixture[] = [];
		const visit = (element: VersionToolbarElementFixture): void => {
			if (element.classNames.has('version-tab')) {
				matches.push(element);
			}
			for (const child of element.children) {
				visit(child);
			}
		};
		for (const child of this.children) {
			visit(child);
		}
		return matches as T[];
	}

	remove(): void {
		this.isConnected = false;
		if (this.parent) {
			const index = this.parent.children.indexOf(this);
			if (index >= 0) {
				this.parent.children.splice(index, 1);
			}
		}
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	private createChild(options: {
		attr?: Record<string, string>;
		cls?: string | string[];
		text?: string;
	}): VersionToolbarElementFixture {
		const child = new VersionToolbarElementFixture();
		child.parent = this;
		const classNames = typeof options.cls === 'string'
			? options.cls.split(/\s+/u).filter(Boolean)
			: options.cls ?? [];
		child.addClass(...classNames);
		for (const [name, value] of Object.entries(options.attr ?? {})) {
			child.setAttribute(name, value);
		}
		child.textContent = options.text ?? '';
		this.children.push(child);
		return child;
	}
}

const compatibleToolbarFixture = makeCompatibleAppendFixture(
	'Compatible toolbar refresh',
	'stored-coarse',
);
const compatibleMenuGroup = compatibleToolbarFixture.registry.index.getGroupById(
	compatibleToolbarFixture.initialRecord.id,
);
check(compatibleMenuGroup, 'compatible file-menu fixture resolves its healthy group');
equal(
	getVersionFileMenuState(
		compatibleMenuGroup,
		'Compatible toolbar refresh/Topic.md',
		1,
	).action,
	'manage',
	'a healthy compatible V1 is managed rather than presented as repair',
);
equal(
	getVersionFileMenuState(
		compatibleMenuGroup,
		'Compatible toolbar refresh/Board.canvas',
		1,
	).action,
	'locate',
	'a healthy compatible non-V1 member receives the Version locator',
);
const exactMenuVault = new Vault([
	'Exact menu/Topic.md',
	'Exact menu/Member.md',
]) as unknown as Vault;
const exactMenuIndex = new VersionIndex(exactMenuVault);
exactMenuIndex.rebuild([{
	id: 'exact-menu-series',
	slots: [
		{ member: memberAt(exactMenuVault, 'Exact menu/Topic.md'), version: 1 },
		{ member: memberAt(exactMenuVault, 'Exact menu/Member.md'), version: 2 },
	],
}]);
const exactMenuGroup = exactMenuIndex.getGroupById('exact-menu-series');
check(exactMenuGroup, 'exact file-menu fixture resolves its healthy group');
equal(
	getVersionFileMenuState(exactMenuGroup, 'Exact menu/Topic.md', 1).action,
	'manage',
	'a healthy exact V1 keeps the Version management action',
);
equal(
	getVersionFileMenuState(exactMenuGroup, 'Exact menu/Member.md', 1).action,
	'locate',
	'a healthy exact non-V1 member keeps the Version locator',
);
const incompleteMenuVault = new Vault(['Incomplete menu/Topic.md']) as unknown as Vault;
const incompleteMenuIndex = new VersionIndex(incompleteMenuVault);
incompleteMenuIndex.rebuild([{
	id: 'incomplete-menu-series',
	slots: [
		{ member: memberAt(incompleteMenuVault, 'Incomplete menu/Topic.md'), version: 1 },
		{
			member: {
				identity: { ctime: 999_999 },
				lastKnownName: 'Missing',
				path: 'Incomplete menu/Missing.md',
			},
			version: 2,
		},
	],
}]);
const incompleteMenuV1 = incompleteMenuVault.getFileByPath('Incomplete menu/Topic.md');
check(incompleteMenuV1, 'incomplete file-menu fixture resolves its V1 file');
const incompleteMenuGroup = incompleteMenuIndex.getGroupForFile(incompleteMenuV1);
check(incompleteMenuGroup, 'incomplete file-menu fixture retains its damaged group');
equal(
	getVersionFileMenuState(incompleteMenuGroup, incompleteMenuV1.path, 1).action,
	'repair',
	'an incomplete relationship still exposes repair',
);
equal(
	getVersionFileMenuState(null, 'Registered but unresolved.md', 1).action,
	'repair',
	'a registered path with no uniquely resolved group still exposes repair',
);
equal(
	getVersionFileMenuState(null, 'Unmanaged.md', 0).action,
	'create',
	'an entirely unmanaged note keeps quick-create',
);
const compatibleToolbarV1 = compatibleToolbarFixture.vault.getFileByPath(
	'Compatible toolbar refresh/Topic.md',
);
check(compatibleToolbarV1, 'compatible toolbar fixture resolves its V1');
let compatibleToolbarPlus: VersionToolbarElementFixture | null = null;
let compatibleToolbarStartedDisabled = false;
const compatibleToolbarContainer = new VersionToolbarElementFixture();
const compatibleToolbarContent = new VersionToolbarElementFixture();
compatibleToolbarContainer.children.push(compatibleToolbarContent);
compatibleToolbarContent.parent = compatibleToolbarContainer;
const compatibleToolbarView = new FileView();
compatibleToolbarView.file = compatibleToolbarV1;
const compatibleToolbarRoot = {};
const compatibleToolbarLeaf = {
	getRoot: () => compatibleToolbarRoot,
	openFile: async () => undefined,
	view: compatibleToolbarView,
};
Object.assign(compatibleToolbarView, {
	addAction: (
		icon: string,
		_label: string,
		callback: (event: MouseEvent) => void,
	) => {
		const action = new VersionToolbarElementFixture();
		compatibleToolbarContainer.children.push(action);
		action.parent = compatibleToolbarContainer;
		action.addEventListener('click', callback as (event: unknown) => void);
		if (icon === 'plus') {
			action.addClass('is-disabled');
			action.setAttribute('aria-disabled', 'true');
			compatibleToolbarStartedDisabled =
				action.classList.contains('is-disabled') &&
				action.hasAttribute('aria-disabled');
			compatibleToolbarPlus = action;
		}
		return action;
	},
	containerEl: compatibleToolbarContainer,
	contentEl: compatibleToolbarContent,
	getViewType: () => 'markdown',
	leaf: compatibleToolbarLeaf,
});
const compatibleToolbarApp = makeCreationApp(
	compatibleToolbarFixture.vault,
) as unknown as {
	workspace: {
		iterateAllLeaves(callback: (leaf: typeof compatibleToolbarLeaf) => void): void;
		leftSplit: unknown;
		rightSplit: unknown;
	};
};
compatibleToolbarApp.workspace = {
	iterateAllLeaves: (callback) => callback(compatibleToolbarLeaf),
	leftSplit: {},
	rightSplit: {},
};
const compatibleToolbarDecorator = new VersionViewDecorator(
	compatibleToolbarApp as never,
	compatibleToolbarFixture.registry.index,
	compatibleToolbarFixture.registry,
	() => '{{name}} (V{{version}})',
	() => undefined,
	() => undefined,
	() => undefined,
	() => undefined,
	() => undefined,
	new VersionI18n('en'),
);
const resizeObserverOwner = globalThis as typeof globalThis & {
	ResizeObserver?: typeof ResizeObserver;
};
const previousResizeObserver = resizeObserverOwner.ResizeObserver;
resizeObserverOwner.ResizeObserver = class {
	disconnect(): void {}
	observe(): void {}
	unobserve(): void {}
} as unknown as typeof ResizeObserver;
modalTestHarness.lastOpened = null;
try {
	compatibleToolbarDecorator.refresh();
} finally {
	if (previousResizeObserver) {
		resizeObserverOwner.ResizeObserver = previousResizeObserver;
	} else {
		delete resizeObserverOwner.ResizeObserver;
	}
}
equal(
	compatibleToolbarStartedDisabled,
	true,
	'the fake native toolbar plus starts with the stale iPad disabled markers',
);
check(compatibleToolbarPlus, 'refresh creates the compatible toolbar plus through FileView.addAction');
equal(
	compatibleToolbarPlus.classList.contains('is-disabled'),
	false,
	'healthy compatible refresh removes the native is-disabled class',
);
equal(
	compatibleToolbarPlus.hasAttribute('aria-disabled'),
	false,
	'healthy compatible refresh removes aria-disabled=true',
);
compatibleToolbarPlus.click();
const compatibleToolbarModal = modalTestHarness.lastOpened as unknown as {
	version: number;
};
check(
	compatibleToolbarModal,
	'the refreshed fake toolbar plus retains a live click handler that opens quick-create',
);
equal(
	compatibleToolbarModal.version,
	4,
	'the refreshed compatible toolbar plus opens the next-version quick-create modal',
);

type CompatibleManagementSlot = {
	assignment: null | {
		file?: TFile;
		format?: string;
		kind: string;
		member?: VersionMemberRecord;
		name?: string;
		registeredMember?: VersionMemberRecord | null;
	};
	version: number;
};
type CompatibleManagementDragSource =
	| { file: TFile; kind: 'file' }
	| { kind: 'slot'; version: number };
type CompatibleManagementHarness = {
	addPendingVersion(): void;
	clearSlot(version: number): void;
	deleteVersionSlot(version: number): void;
	dropOnSlot(version: number, source: CompatibleManagementDragSource): void;
	initialMemberPath: string | null;
	managementExpectation: unknown;
	slots: CompatibleManagementSlot[];
	submit(): Promise<void>;
	submitSingleRemainingVersion(v1: TFile): Promise<void>;
};

function makeCompatibleManagementApp(
	vault: Vault,
	counters: { creates: number; moves: number; trash: number },
): never {
	const mutableVault = vault as unknown as InstanceType<typeof Vault> & {
		create(path: string, content: string): Promise<TFile>;
	};
	const originalCreate = mutableVault.create.bind(mutableVault);
	mutableVault.create = async (path: string, content: string) => {
		counters.creates += 1;
		return originalCreate(path, content);
	};
	return {
		fileManager: {
			renameFile: async (file: TFile, path: string) => {
				counters.moves += 1;
				mutableVault.rename(file.path, path);
			},
			trashFile: async (file: TFile) => {
				counters.trash += 1;
				mutableVault.delete(file);
			},
		},
		vault: mutableVault,
	} as never;
}

function disableCompatibleManagementRendering(modal: VersionManagementModal): void {
	Object.assign(modal, {
		renderAll: () => undefined,
		renderAllWithMotion: () => undefined,
	});
}

const compatibleManagementFixture = makeCompatibleAppendFixture(
	'Compatible full management',
	'stored-coarse',
);
const compatibleManagementV1 = compatibleManagementFixture.vault.getFileByPath(
	'Compatible full management/Topic.md',
);
const compatibleManagementV2 = compatibleManagementFixture.vault.getFileByPath(
	'Compatible full management/Board.canvas',
);
const compatibleManagementV3 = compatibleManagementFixture.vault.getFileByPath(
	'Compatible full management/Sketch.excalidraw',
);
check(compatibleManagementV1, 'compatible manager resolves its V1');
check(compatibleManagementV2, 'compatible manager resolves its current V2');
check(compatibleManagementV3, 'compatible manager resolves its V3');
const compatibleManagementCounters = { creates: 0, moves: 0, trash: 0 };
let compatibleManagementSaved = 0;
const compatibleManagementModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		compatibleManagementFixture.vault,
		compatibleManagementCounters,
	),
	compatibleManagementFixture.registry,
	compatibleManagementV2,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => {
		compatibleManagementSaved += 1;
	},
	compatibleManagementFixture.initialRecord.id,
);
disableCompatibleManagementRendering(compatibleManagementModal);
const compatibleManagementHarness = compatibleManagementModal as unknown as
	CompatibleManagementHarness;
check(
	compatibleManagementHarness.managementExpectation,
	'a healthy precision-compatible relationship receives full management authorization',
);
assert.deepEqual(
	compatibleManagementHarness.slots.map((slot) => [
		slot.version,
		slot.assignment?.kind,
		slot.assignment?.file?.path,
	]),
	[
		[1, 'existing', 'Compatible full management/Topic.md'],
		[2, 'existing', 'Compatible full management/Board.canvas'],
		[3, 'existing', 'Compatible full management/Sketch.excalidraw'],
	],
	'compatible management resolves every real member as an editable existing assignment',
);
assertions += 1;
equal(
	compatibleManagementHarness.initialMemberPath,
	compatibleManagementV2.path,
	'compatible management records the actual current member for V2 location',
);
const compatibleManagementFiles = [
	compatibleManagementV1,
	compatibleManagementV2,
	compatibleManagementV3,
];
const compatibleManagementFilesBefore = await Promise.all(
	compatibleManagementFiles.map(async (file) => ({
		content: await compatibleManagementFixture.vault.read(file),
		ctime: file.stat.ctime,
		file,
		mtime: file.stat.mtime,
		path: file.path,
		size: file.stat.size,
	})),
);
const compatibleMembersByPath = new Map(
	compatibleManagementFixture.initialRecord.slots.map((slot) => [
		slot.member?.path,
		slot.member,
	]),
);
compatibleManagementHarness.dropOnSlot(3, { kind: 'slot', version: 2 });
await compatibleManagementHarness.submit();
const compatibleManagementAfter = compatibleManagementFixture.registry.getRecordById(
	compatibleManagementFixture.initialRecord.id,
);
check(compatibleManagementAfter, 'compatible management preserves the relationship after swap');
assert.deepEqual(
	compatibleManagementAfter.slots,
	[
		{
			member: compatibleMembersByPath.get(compatibleManagementV1.path),
			version: 1,
		},
		{
			member: compatibleMembersByPath.get(compatibleManagementV3.path),
			version: 2,
		},
		{
			member: compatibleMembersByPath.get(compatibleManagementV2.path),
			version: 3,
		},
	],
	'a compatible V2/V3 swap changes only slot-to-member mapping and preserves every old member record byte-for-byte',
);
assertions += 1;
assert.deepEqual(
	await Promise.all(compatibleManagementFiles.map(async (file) => ({
		content: await compatibleManagementFixture.vault.read(file),
		ctime: file.stat.ctime,
		file,
		mtime: file.stat.mtime,
		path: file.path,
		size: file.stat.size,
	}))),
	compatibleManagementFilesBefore,
	'compatible mapping-only management leaves every real file object, path, stat, and content unchanged',
);
assertions += 1;
equal(compatibleManagementFixture.persisted.length, 1, 'compatible swap persists once');
equal(compatibleManagementCounters.creates, 0, 'compatible swap creates no file');
equal(compatibleManagementCounters.moves, 0, 'compatible swap moves no file');
equal(compatibleManagementCounters.trash, 0, 'compatible swap trashes no file');
equal(compatibleManagementSaved, 1, 'compatible swap reports one completed save');
const compatibleManagementReloaded = new VersionRegistry(
	compatibleManagementFixture.vault,
	compatibleManagementFixture.persisted[0],
	async () => undefined,
);
assert.deepEqual(
	compatibleManagementReloaded.getRecordById(compatibleManagementAfter.id),
	compatibleManagementAfter,
	'compatible management mapping survives a registry reload exactly',
);
assertions += 1;

const compatibleV1SwapFixture = makeCompatibleAppendFixture(
	'Compatible representative swap',
	'live-coarse',
);
const compatibleV1SwapV1 = compatibleV1SwapFixture.vault.getFileByPath(
	'Compatible representative swap/Topic.md',
);
const compatibleV1SwapV2 = compatibleV1SwapFixture.vault.getFileByPath(
	'Compatible representative swap/Board.canvas',
);
check(compatibleV1SwapV1, 'compatible representative swap resolves old V1');
check(compatibleV1SwapV2, 'compatible representative swap resolves old V2');
const compatibleV1SwapCounters = { creates: 0, moves: 0, trash: 0 };
const compatibleV1SwapModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		compatibleV1SwapFixture.vault,
		compatibleV1SwapCounters,
	),
	compatibleV1SwapFixture.registry,
	compatibleV1SwapV1,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => undefined,
	compatibleV1SwapFixture.initialRecord.id,
);
disableCompatibleManagementRendering(compatibleV1SwapModal);
const compatibleV1SwapHarness = compatibleV1SwapModal as unknown as
	CompatibleManagementHarness;
compatibleV1SwapHarness.dropOnSlot(1, { kind: 'slot', version: 2 });
await compatibleV1SwapHarness.submit();
equal(
	compatibleV1SwapFixture.registry.index.getGroupById(
		compatibleV1SwapFixture.initialRecord.id,
	)?.versions.find((member) => member.version === 1)?.file,
	compatibleV1SwapV2,
	'a compatible V1/V2 swap promotes the real old V2 file to the representative entry',
);
assert.deepEqual(
	compatibleV1SwapFixture.registry.getRecordById(
		compatibleV1SwapFixture.initialRecord.id,
	)?.slots.slice(0, 2),
	[
		{ member: compatibleV1SwapFixture.initialRecord.slots[1].member, version: 1 },
		{ member: compatibleV1SwapFixture.initialRecord.slots[0].member, version: 2 },
	],
	'compatible V1/V2 swap preserves both original member records byte-for-byte',
);
assertions += 1;
equal(compatibleV1SwapCounters.creates, 0, 'compatible representative swap creates no file');
equal(compatibleV1SwapCounters.moves, 0, 'compatible representative swap moves no file');
equal(compatibleV1SwapCounters.trash, 0, 'compatible representative swap trashes no file');

const compatibleReassignFixture = makeCompatibleAppendFixture(
	'Compatible original reassignment',
	'stored-coarse',
);
const compatibleReassignV1 = compatibleReassignFixture.vault.getFileByPath(
	'Compatible original reassignment/Topic.md',
);
const compatibleReassignV2 = compatibleReassignFixture.vault.getFileByPath(
	'Compatible original reassignment/Board.canvas',
);
check(compatibleReassignV1, 'compatible reassignment resolves V1');
check(compatibleReassignV2, 'compatible reassignment resolves V2');
const compatibleReassignModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		compatibleReassignFixture.vault,
		{ creates: 0, moves: 0, trash: 0 },
	),
	compatibleReassignFixture.registry,
	compatibleReassignV1,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => undefined,
	compatibleReassignFixture.initialRecord.id,
);
disableCompatibleManagementRendering(compatibleReassignModal);
const compatibleReassignHarness = compatibleReassignModal as unknown as
	CompatibleManagementHarness;
compatibleReassignHarness.clearSlot(2);
compatibleReassignHarness.dropOnSlot(2, {
	file: compatibleReassignV2,
	kind: 'file',
});
await compatibleReassignHarness.submit();
assert.deepEqual(
	compatibleReassignFixture.registry.getRecordById(
		compatibleReassignFixture.initialRecord.id,
	),
	compatibleReassignFixture.initialRecord,
	'removing and reassigning the same compatible member reuses its stored identity instead of rebasing ctime',
);
assertions += 1;

const compatibleRemovalFixture = makeCompatibleAppendFixture(
	'Compatible management removal',
	'live-coarse',
);
const compatibleRemovalV1 = compatibleRemovalFixture.vault.getFileByPath(
	'Compatible management removal/Topic.md',
);
check(compatibleRemovalV1, 'compatible removal resolves V1');
const compatibleRemovalCounters = { creates: 0, moves: 0, trash: 0 };
let compatibleRemovalSaved = 0;
const compatibleRemovalModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		compatibleRemovalFixture.vault,
		compatibleRemovalCounters,
	),
	compatibleRemovalFixture.registry,
	compatibleRemovalV1,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => {
		compatibleRemovalSaved += 1;
	},
	compatibleRemovalFixture.initialRecord.id,
);
disableCompatibleManagementRendering(compatibleRemovalModal);
const compatibleRemovalHarness = compatibleRemovalModal as unknown as
	CompatibleManagementHarness;
compatibleRemovalHarness.deleteVersionSlot(2);
await compatibleRemovalHarness.submit();
const compatibleRemovalAfter = compatibleRemovalFixture.registry.getRecordById(
	compatibleRemovalFixture.initialRecord.id,
);
check(compatibleRemovalAfter, 'compatible removal keeps the two-member relationship');
assert.deepEqual(
	compatibleRemovalAfter.slots,
	compatibleRemovalFixture.initialRecord.slots.filter((slot) => slot.version !== 2),
	'compatible removal drops only the selected mapping and preserves remaining member records byte-for-byte',
);
assertions += 1;
equal(compatibleRemovalFixture.persisted.length, 1, 'compatible removal persists once');
equal(compatibleRemovalCounters.creates, 0, 'compatible removal creates no file');
equal(compatibleRemovalCounters.moves, 0, 'same-folder compatible removal moves no file');
equal(compatibleRemovalCounters.trash, 0, 'compatible removal never trashes the released file');
equal(compatibleRemovalSaved, 1, 'compatible removal reports one completed save');
check(
	compatibleRemovalFixture.vault.getFileByPath(
		'Compatible management removal/Board.canvas',
	),
	'compatible removal leaves the released file readable at its original path',
);

const compatibleReleaseMoveFixture = makeCompatibleAppendFixture(
	'Compatible release move',
	'live-coarse',
);
const compatibleReleaseMoveV1 = compatibleReleaseMoveFixture.vault.getFileByPath(
	'Compatible release move/Topic.md',
);
const compatibleReleaseMoveV2 = compatibleReleaseMoveFixture.vault.getFileByPath(
	'Compatible release move/Board.canvas',
);
check(compatibleReleaseMoveV1, 'compatible release move resolves V1');
check(compatibleReleaseMoveV2, 'compatible release move resolves V2');
const compatibleReleaseMoveCounters = { creates: 0, moves: 0, trash: 0 };
const compatibleReleaseMoveModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		compatibleReleaseMoveFixture.vault,
		compatibleReleaseMoveCounters,
	),
	compatibleReleaseMoveFixture.registry,
	compatibleReleaseMoveV1,
	'{{name}} (V{{version}})',
	'vault-root',
	new VersionI18n('en'),
	() => undefined,
	compatibleReleaseMoveFixture.initialRecord.id,
);
disableCompatibleManagementRendering(compatibleReleaseMoveModal);
const compatibleReleaseMoveHarness = compatibleReleaseMoveModal as unknown as
	CompatibleManagementHarness;
compatibleReleaseMoveHarness.deleteVersionSlot(2);
await compatibleReleaseMoveHarness.submit();
equal(
	compatibleReleaseMoveCounters.moves,
	1,
	'a compatible removed member may move only through the guarded release path',
);
equal(
	compatibleReleaseMoveFixture.vault.getFileByPath('Board.canvas'),
	compatibleReleaseMoveV2,
	'the captured compatible released file reaches the configured vault root',
);
equal(
	compatibleReleaseMoveFixture.vault.getFileByPath(
		'Compatible release move/Board.canvas',
	),
	null,
	'a successful guarded release move clears only its original path',
);
assert.deepEqual(
	compatibleReleaseMoveFixture.registry.getRecordById(
		compatibleReleaseMoveFixture.initialRecord.id,
	)?.slots,
	compatibleReleaseMoveFixture.initialRecord.slots.filter(
		(slot) => slot.version !== 2,
	),
	'compatible release movement does not rewrite surviving identities',
);
assertions += 1;

const compatibleChangedReleaseFixture = makeCompatibleAppendFixture(
	'Compatible changed release',
	'stored-coarse',
);
const compatibleChangedReleaseV1 = compatibleChangedReleaseFixture.vault.getFileByPath(
	'Compatible changed release/Topic.md',
);
const compatibleChangedReleaseV2 = compatibleChangedReleaseFixture.vault.getFileByPath(
	'Compatible changed release/Board.canvas',
);
check(compatibleChangedReleaseV1, 'changed compatible release resolves V1');
check(compatibleChangedReleaseV2, 'changed compatible release resolves V2');
const compatibleChangedReleaseCounters = { creates: 0, moves: 0, trash: 0 };
const compatibleChangedReleaseModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		compatibleChangedReleaseFixture.vault,
		compatibleChangedReleaseCounters,
	),
	compatibleChangedReleaseFixture.registry,
	compatibleChangedReleaseV1,
	'{{name}} (V{{version}})',
	'vault-root',
	new VersionI18n('en'),
	() => undefined,
	compatibleChangedReleaseFixture.initialRecord.id,
);
disableCompatibleManagementRendering(compatibleChangedReleaseModal);
const compatibleChangedReleaseHarness = compatibleChangedReleaseModal as unknown as
	CompatibleManagementHarness;
compatibleChangedReleaseHarness.deleteVersionSlot(2);
(compatibleChangedReleaseFixture.vault as unknown as InstanceType<typeof Vault>)
	.modify(compatibleChangedReleaseV2, 'user edit after staging removal');
await compatibleChangedReleaseHarness.submit();
equal(
	compatibleChangedReleaseCounters.moves,
	0,
	'a released file changed after staging is never moved from a stale capture',
);
equal(
	compatibleChangedReleaseFixture.vault.getFileByPath(
		'Compatible changed release/Board.canvas',
	),
	compatibleChangedReleaseV2,
	'the changed released file remains readable at the user-visible source path',
);
equal(
	await compatibleChangedReleaseFixture.vault.read(compatibleChangedReleaseV2),
	'user edit after staging removal',
	'skipping the stale release move preserves the user edit',
);
equal(
	compatibleChangedReleaseFixture.persisted.length,
	1,
	'a changed released file may still be safely removed from the registry mapping',
);

const compatibleDissolveFixture = makeCompatibleAppendFixture(
	'Compatible management dissolve',
	'live-coarse',
);
const compatibleDissolveV1 = compatibleDissolveFixture.vault.getFileByPath(
	'Compatible management dissolve/Topic.md',
);
check(compatibleDissolveV1, 'compatible dissolve resolves V1');
const compatibleDissolveFiles = compatibleDissolveFixture.initialRecord.slots.map(
	(slot) => {
		check(slot.member, `compatible dissolve resolves V${slot.version} member`);
		const file = compatibleDissolveFixture.vault.getFileByPath(slot.member.path);
		check(file, `compatible dissolve resolves V${slot.version} file`);
		return file;
	},
);
const compatibleDissolveCounters = { creates: 0, moves: 0, trash: 0 };
const compatibleDissolveModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		compatibleDissolveFixture.vault,
		compatibleDissolveCounters,
	),
	compatibleDissolveFixture.registry,
	compatibleDissolveV1,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => undefined,
	compatibleDissolveFixture.initialRecord.id,
);
disableCompatibleManagementRendering(compatibleDissolveModal);
const compatibleDissolveHarness = compatibleDissolveModal as unknown as
	CompatibleManagementHarness;
compatibleDissolveHarness.deleteVersionSlot(3);
compatibleDissolveHarness.deleteVersionSlot(2);
await compatibleDissolveHarness.submitSingleRemainingVersion(compatibleDissolveV1);
equal(
	compatibleDissolveFixture.registry.getRecordById(
		compatibleDissolveFixture.initialRecord.id,
	),
	null,
	'compatible management may explicitly stop managing its final V1 mapping',
);
equal(compatibleDissolveFixture.persisted.length, 1, 'compatible dissolve persists once');
equal(compatibleDissolveCounters.creates, 0, 'compatible dissolve creates no file');
equal(compatibleDissolveCounters.moves, 0, 'same-folder compatible dissolve moves no file');
equal(compatibleDissolveCounters.trash, 0, 'compatible dissolve never trashes a file');
for (const file of compatibleDissolveFiles) {
	equal(
		compatibleDissolveFixture.vault.getFileByPath(file.path),
		file,
		`compatible dissolve leaves ${file.path} as the same readable file`,
	);
}

const compatibleStaleDissolveFixture = makeCompatibleAppendFixture(
	'Compatible stale dissolve blocked',
	'stored-coarse',
);
const compatibleStaleDissolveExpectation =
	compatibleStaleDissolveFixture.registry.captureManagementExpectation(
		compatibleStaleDissolveFixture.initialRecord.id,
	);
check(
	compatibleStaleDissolveExpectation,
	'compatible stale dissolve receives management authorization',
);
const compatibleStaleDissolveV2 = compatibleStaleDissolveFixture.vault.getFileByPath(
	'Compatible stale dissolve blocked/Board.canvas',
);
check(compatibleStaleDissolveV2, 'compatible stale dissolve resolves V2');
compatibleStaleDissolveV2.stat.ctime += 12_345;
await assert.rejects(
	() => compatibleStaleDissolveFixture.registry.dissolveResolvedSeriesManagement(
		compatibleStaleDissolveExpectation,
	),
	/changed or disappeared/u,
	'a compatible dissolve revalidates every captured member before forgetting the mapping',
);
assertions += 1;
equal(
	compatibleStaleDissolveFixture.persisted.length,
	0,
	'a stale compatible dissolve performs no persistence',
);
assert.deepEqual(
	compatibleStaleDissolveFixture.registry.getRecordById(
		compatibleStaleDissolveFixture.initialRecord.id,
	),
	compatibleStaleDissolveFixture.initialRecord,
	'a stale compatible dissolve preserves the registry exactly',
);
assertions += 1;

const compatibleCreationFixture = makeCompatibleAppendFixture(
	'Compatible management creation',
	'stored-coarse',
);
const compatibleCreationV2 = compatibleCreationFixture.vault.getFileByPath(
	'Compatible management creation/Board.canvas',
);
check(compatibleCreationV2, 'compatible creation resolves current Canvas V2');
const compatibleCreationCounters = { creates: 0, moves: 0, trash: 0 };
const compatibleCreationModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		compatibleCreationFixture.vault,
		compatibleCreationCounters,
	),
	compatibleCreationFixture.registry,
	compatibleCreationV2,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => undefined,
	compatibleCreationFixture.initialRecord.id,
);
disableCompatibleManagementRendering(compatibleCreationModal);
const compatibleCreationHarness = compatibleCreationModal as unknown as
	CompatibleManagementHarness;
compatibleCreationHarness.addPendingVersion();
equal(
	compatibleCreationHarness.slots.find((slot) => slot.version === 4)?.assignment?.kind,
	'new',
	'compatible management keeps the normal staged-new-version entrypoint enabled',
);
await compatibleCreationHarness.submit();
const compatibleCreationAfter = compatibleCreationFixture.registry.getRecordById(
	compatibleCreationFixture.initialRecord.id,
);
check(compatibleCreationAfter, 'compatible creation preserves the relationship');
assert.deepEqual(
	compatibleCreationAfter.slots.slice(0, 3),
	compatibleCreationFixture.initialRecord.slots,
	'compatible creation preserves all old members byte-for-byte',
);
assertions += 1;
equal(compatibleCreationAfter.slots[3]?.version, 4, 'compatible management registers V4');
equal(
	compatibleCreationAfter.slots[3]?.member?.path,
	'Compatible management creation/Topic (V4).canvas',
	'compatible management follows the current Canvas format for staged V4',
);
equal(compatibleCreationCounters.creates, 1, 'compatible management creates exactly one staged file');
equal(compatibleCreationCounters.moves, 0, 'compatible creation moves no existing file');
equal(compatibleCreationCounters.trash, 0, 'successful compatible creation trashes no file');

const compatibleIdentityRewriteFixture = makeCompatibleAppendFixture(
	'Compatible identity rewrite blocked',
	'stored-coarse',
);
const compatibleIdentityExpectation =
	compatibleIdentityRewriteFixture.registry.captureManagementExpectation(
		compatibleIdentityRewriteFixture.initialRecord.id,
	);
check(compatibleIdentityExpectation, 'compatible identity test receives management authorization');
const rewrittenCompatibleAssignments = compatibleIdentityRewriteFixture.initialRecord.slots.map(
	(slot) => {
		check(slot.member, `compatible identity test resolves V${slot.version} member`);
		const file = compatibleIdentityRewriteFixture.vault.getFileByPath(slot.member.path);
		check(file, `compatible identity test resolves V${slot.version} file`);
		return {
			file,
			member: memberRecordFromFile(file),
			version: slot.version,
		};
	},
);
await assert.rejects(
	() => compatibleIdentityRewriteFixture.registry.saveResolvedSeriesManagement(
		compatibleIdentityExpectation,
		rewrittenCompatibleAssignments,
	),
	/original Version identity/u,
	'a compatible save cannot silently replace stored ctimes with this device ctimes',
);
assertions += 1;
equal(
	compatibleIdentityRewriteFixture.persisted.length,
	0,
	'blocked compatible identity rewriting performs no persistence',
);
assert.deepEqual(
	compatibleIdentityRewriteFixture.registry.getRecordById(
		compatibleIdentityRewriteFixture.initialRecord.id,
	),
	compatibleIdentityRewriteFixture.initialRecord,
	'blocked compatible identity rewriting preserves the registry exactly',
);
assertions += 1;

const compatibleReplacementFixture = makeCompatibleAppendFixture(
	'Compatible replacement blocked',
	'stored-coarse',
);
const compatibleReplacementExpectation =
	compatibleReplacementFixture.registry.captureManagementExpectation(
		compatibleReplacementFixture.initialRecord.id,
	);
check(compatibleReplacementExpectation, 'replacement test receives management authorization');
const compatibleReplacementPath = 'Compatible replacement blocked/Board.canvas';
const compatibleReplacedFile = compatibleReplacementFixture.vault.getFileByPath(
	compatibleReplacementPath,
);
check(compatibleReplacedFile, 'replacement test resolves the original V2');
const compatibleReplacementVault = compatibleReplacementFixture.vault as unknown as
	InstanceType<typeof Vault>;
const compatibleReplacementCtime = compatibleReplacedFile.stat.ctime;
compatibleReplacementVault.delete(compatibleReplacedFile);
const compatibleReplacement = compatibleReplacementVault.add(compatibleReplacementPath);
compatibleReplacement.stat.ctime = compatibleReplacementCtime;
const compatibleReplacementAssignments = compatibleReplacementFixture.initialRecord.slots.map(
	(slot) => {
		check(slot.member, `replacement test resolves V${slot.version} member`);
		const file = compatibleReplacementFixture.vault.getFileByPath(slot.member.path);
		check(file, `replacement test resolves live V${slot.version}`);
		return { file, member: { ...slot.member }, version: slot.version };
	},
);
await assert.rejects(
	() => compatibleReplacementFixture.registry.saveResolvedSeriesManagement(
		compatibleReplacementExpectation,
		compatibleReplacementAssignments,
	),
	/not the originally registered Version file/u,
	'a same-path replacement with the same exposed ctime cannot inherit management authorization',
);
assertions += 1;
equal(
	compatibleReplacementFixture.persisted.length,
	0,
	'blocked same-path replacement performs no persistence',
);

const staleCompatiblePaths = [
	'Stale compatible modal/Topic.md',
	'Stale compatible modal/Board.canvas',
	'Stale compatible modal/Sketch.excalidraw',
];
const staleCompatibleVault = new Vault(staleCompatiblePaths) as unknown as Vault;
for (const [index, path] of staleCompatiblePaths.entries()) {
	const file = staleCompatibleVault.getFileByPath(path);
	check(file, `stale compatible fixture resolves ${path}`);
	file.stat.ctime = 1_786_200_001_261 + index * 1_000;
}
const staleCompatibleRecord: VersionSeriesRecord = {
	id: 'stale-compatible-modal-series',
	slots: staleCompatiblePaths.map((path, index) => ({
		member: memberAt(staleCompatibleVault, path),
		version: index + 1,
	})),
};
const staleCompatibleRegistry = new VersionRegistry(
	staleCompatibleVault,
	[staleCompatibleRecord],
	async () => undefined,
);
equal(
	staleCompatibleRegistry.index.getGroupById(staleCompatibleRecord.id)?.identityStatus,
	'exact',
	'stale-cache regression begins with an exact cached index',
);
check(
	staleCompatibleRegistry.resolveExactlyMatchedGroup(staleCompatibleRecord.id),
	'a fresh mutation authorization accepts the initial exact relationship',
);
for (const path of staleCompatiblePaths) {
	const file = staleCompatibleVault.getFileByPath(path);
	check(file, `stale compatible fixture re-resolves ${path}`);
	file.stat.ctime = Math.floor(file.stat.ctime / 1_000) * 1_000;
}
equal(
	staleCompatibleRegistry.index.getGroupById(staleCompatibleRecord.id)?.identityStatus,
	'exact',
	'TFile ctime precision can change before the cached index receives a Vault event',
);
equal(
	staleCompatibleRegistry.resolveExactlyMatchedGroup(staleCompatibleRecord.id),
	null,
	'a mutation authorization rebuilds and rejects in-place compatible ctime drift without a Vault event',
);
const staleCompatibleCurrent = staleCompatibleVault.getFileByPath(staleCompatiblePaths[1]);
check(staleCompatibleCurrent, 'stale-cache regression resolves current V2');
const staleCompatibleModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		staleCompatibleVault,
		{ creates: 0, moves: 0, trash: 0 },
	),
	staleCompatibleRegistry,
	staleCompatibleCurrent,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => undefined,
	staleCompatibleRecord.id,
);
const staleCompatibleHarness = staleCompatibleModal as unknown as
	CompatibleManagementHarness;
check(
	staleCompatibleHarness.managementExpectation,
	'management rebuilds the stale index and captures a compatible authorization',
);
assert.deepEqual(
	staleCompatibleHarness.slots.map((slot) => slot.assignment?.kind),
	['existing', 'existing', 'existing'],
	'a stale exact cache followed by compatible live ctimes never renders every path as missing',
);
assertions += 1;

const identityConflictPaths = [
	'Identity conflict modal/Topic.md',
	'Identity conflict modal/Board.canvas',
	'Identity conflict modal/Sketch.excalidraw',
];
const identityConflictVault = new Vault(identityConflictPaths) as unknown as Vault;
for (const [index, path] of identityConflictPaths.entries()) {
	const file = identityConflictVault.getFileByPath(path);
	check(file, `identity-conflict fixture resolves ${path}`);
	file.stat.ctime = 1_786_300_001_261 + index * 1_000;
}
const identityConflictRecord: VersionSeriesRecord = {
	id: 'identity-conflict-modal-series',
	slots: identityConflictPaths.map((path, index) => ({
		member: memberAt(identityConflictVault, path),
		version: index + 1,
	})),
};
let identityConflictPersists = 0;
const identityConflictRegistry = new VersionRegistry(
	identityConflictVault,
	[identityConflictRecord],
	async () => {
		identityConflictPersists += 1;
	},
);
const identityConflictV2 = identityConflictVault.getFileByPath(identityConflictPaths[1]);
const identityConflictV3 = identityConflictVault.getFileByPath(identityConflictPaths[2]);
check(identityConflictV2, 'identity-conflict fixture resolves V2');
check(identityConflictV3, 'identity-conflict fixture resolves V3');
identityConflictV2.stat.ctime += 1_000;
identityConflictV3.stat.ctime = Math.floor(identityConflictV3.stat.ctime / 1_000) * 1_000;
equal(
	identityConflictRegistry.resolveExactlyMatchedGroup(identityConflictRecord.id),
	null,
	'a mutation authorization rebuilds and rejects an in-place identity conflict without a Vault event',
);
const identityConflictV1 = identityConflictVault.getFileByPath(identityConflictPaths[0]);
check(identityConflictV1, 'identity-conflict fixture resolves V1');
let identityConflictSaved = 0;
const identityConflictModal = new VersionManagementModal(
	makeCompatibleManagementApp(
		identityConflictVault,
		{ creates: 0, moves: 0, trash: 0 },
	),
	identityConflictRegistry,
	identityConflictV1,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => {
		identityConflictSaved += 1;
	},
	identityConflictRecord.id,
);
disableCompatibleManagementRendering(identityConflictModal);
const identityConflictHarness = identityConflictModal as unknown as
	CompatibleManagementHarness;
equal(
	identityConflictHarness.managementExpectation,
	null,
	'a genuine different-second identity conflict receives no compatible authorization',
);
assert.deepEqual(
	identityConflictHarness.slots.map((slot) => [
		slot.assignment?.kind,
		slot.assignment?.file?.path,
	]),
	[
		['existing', identityConflictPaths[0]],
		['identity-conflict', identityConflictPaths[1]],
		['existing', identityConflictPaths[2]],
	],
	'a path that exists with a conflicting identity is labeled conflict, while other compatible members remain existing',
);
assertions += 1;
await identityConflictHarness.submit();
equal(identityConflictPersists, 0, 'unchanged identity conflict cannot persist silently');
equal(identityConflictSaved, 0, 'unchanged identity conflict cannot report a successful save');
assert.deepEqual(
	identityConflictRegistry.getRecordById(identityConflictRecord.id),
	identityConflictRecord,
	'failed identity-conflict submit preserves the registry exactly',
);
assertions += 1;

const compatiblePlusFixture = makeCompatibleAppendFixture(
	'Compatible plus flow',
	'stored-coarse',
);
let compatiblePlusOpenedPath: string | null = null;
let compatiblePlusRefreshes = 0;
const compatiblePlusDecorator = new VersionViewDecorator(
	makeCreationApp(compatiblePlusFixture.vault),
	compatiblePlusFixture.registry.index,
	compatiblePlusFixture.registry,
	() => '{{name}} (V{{version}})',
	() => {
		compatiblePlusRefreshes += 1;
	},
	() => {
		throw new Error('The compatible plus action must not open Version management.');
	},
	() => undefined,
	() => undefined,
	() => undefined,
	new VersionI18n('en'),
);
const compatiblePlusHarness = compatiblePlusDecorator as unknown as {
	handleAddVersion(view: FileView, event: MouseEvent): void;
	refresh(): void;
};
compatiblePlusHarness.refresh = () => undefined;
const compatiblePlusV1 = compatiblePlusFixture.vault.getFileByPath(
	'Compatible plus flow/Topic.md',
);
check(compatiblePlusV1, 'compatible plus fixture resolves its current V1');
const compatiblePlusView = {
	file: compatiblePlusV1,
	leaf: {
		openFile: async (file: TFile) => {
			compatiblePlusOpenedPath = file.path;
		},
	},
} as unknown as FileView;
modalTestHarness.lastOpened = null;
compatiblePlusHarness.handleAddVersion(
	compatiblePlusView,
	{} as MouseEvent,
);
const compatiblePlusModal = modalTestHarness.lastOpened as unknown as {
	filename: string;
	format: 'markdown' | 'canvas' | 'excalidraw';
	onCreate(
		filename: string,
		format: 'markdown' | 'canvas' | 'excalidraw',
	): Promise<boolean>;
	version: number;
};
check(
	compatiblePlusModal,
	'a healthy precision-compatible note opens quick-create instead of rejecting the plus action',
);
equal(compatiblePlusModal.version, 4, 'compatible plus offers the next maximum version');
equal(
	compatiblePlusModal.format,
	'markdown',
	'compatible plus follows the current real member format',
);
equal(
	await compatiblePlusModal.onCreate('New V4', 'markdown'),
	true,
	'compatible plus completes through the append-only transaction',
);
equal(
	compatiblePlusFixture.persisted.length,
	1,
	'compatible plus persists one relationship update',
);
equal(
	compatiblePlusOpenedPath,
	'Compatible plus flow/New V4.md',
	'compatible plus opens the new version only after registration',
);
equal(
	compatiblePlusRefreshes,
	1,
	'compatible plus refreshes file UI after the committed append',
);

const compatiblePlusRollbackSeed = makeCompatibleAppendFixture(
	'Compatible plus rollback',
	'live-coarse',
);
const compatiblePlusRollbackRegistry = new VersionRegistry(
	compatiblePlusRollbackSeed.vault,
	[compatiblePlusRollbackSeed.initialRecord],
	async () => {
		throw new Error('compatible append persistence failed');
	},
);
const compatiblePlusRollbackDecorator = new VersionViewDecorator(
	makeCreationApp(compatiblePlusRollbackSeed.vault),
	compatiblePlusRollbackRegistry.index,
	compatiblePlusRollbackRegistry,
	() => '{{name}} (V{{version}})',
	() => undefined,
	() => undefined,
	() => undefined,
	() => undefined,
	() => undefined,
	new VersionI18n('en'),
);
const compatiblePlusRollbackHarness = compatiblePlusRollbackDecorator as unknown as {
	handleAddVersion(view: FileView, event: MouseEvent): void;
	refresh(): void;
};
compatiblePlusRollbackHarness.refresh = () => undefined;
const compatiblePlusRollbackV1 = compatiblePlusRollbackSeed.vault.getFileByPath(
	'Compatible plus rollback/Topic.md',
);
check(compatiblePlusRollbackV1, 'compatible rollback fixture resolves V1');
modalTestHarness.lastOpened = null;
compatiblePlusRollbackHarness.handleAddVersion(
	{
		file: compatiblePlusRollbackV1,
		leaf: { openFile: async () => undefined },
	} as unknown as FileView,
	{} as MouseEvent,
);
const compatiblePlusRollbackModal = modalTestHarness.lastOpened as unknown as {
	onCreate(filename: string, format: 'markdown'): Promise<boolean>;
};
check(compatiblePlusRollbackModal, 'compatible rollback fixture opens quick-create');
equal(
	await compatiblePlusRollbackModal.onCreate('Failed V4', 'markdown'),
	false,
	'compatible plus reports a failed registry commit',
);
equal(
	compatiblePlusRollbackSeed.vault.getFileByPath(
		'Compatible plus rollback/Failed V4.md',
	),
	null,
	'a failed compatible append rolls back only its unchanged new file',
);
assert.deepEqual(
	compatiblePlusRollbackRegistry.getRecordById(
		compatiblePlusRollbackSeed.initialRecord.id,
	),
	compatiblePlusRollbackSeed.initialRecord,
	'a failed compatible append preserves every pre-existing relationship field',
);
assertions += 1;

const appendRevisionFixture = makeCompatibleAppendFixture(
	'Append revision race',
	'stored-coarse',
);
const appendRevisionExpectation = appendRevisionFixture.registry
	.captureAppendExpectation(appendRevisionFixture.initialRecord.id);
check(appendRevisionExpectation, 'append revision race captures authorization');
const revisionOtherV1 = (appendRevisionFixture.vault as unknown as InstanceType<typeof Vault>)
	.add('Append revision race/Other V1.md');
const revisionOtherV2 = (appendRevisionFixture.vault as unknown as InstanceType<typeof Vault>)
	.add('Append revision race/Other V2.md');
await appendRevisionFixture.registry.reload(async () => [
	...appendRevisionFixture.registry.getRecords(),
	{
		id: 'append-revision-other-series',
		slots: [
			{ member: memberRecordFromFile(revisionOtherV1), version: 1 },
			{ member: memberRecordFromFile(revisionOtherV2), version: 2 },
		],
	},
]);
const appendRevisionCandidate = (appendRevisionFixture.vault as unknown as InstanceType<typeof Vault>)
	.add('Append revision race/New V4.md');
await assert.rejects(
	() => appendRevisionFixture.registry.appendMemberToResolvedSeries(
		appendRevisionExpectation,
		4,
		appendRevisionCandidate,
	),
	/registry changed/u,
);
assertions += 1;
equal(
	appendRevisionFixture.persisted.length,
	0,
	'a registry revision change rejects append without writing either relationship',
);

const appendRenameFixture = makeCompatibleAppendFixture(
	'Append candidate rename',
	'stored-coarse',
);
const appendRenameExpectation = appendRenameFixture.registry
	.captureAppendExpectation(appendRenameFixture.initialRecord.id);
check(appendRenameExpectation, 'candidate rename fixture captures authorization');
const appendRenameCandidate = (appendRenameFixture.vault as unknown as InstanceType<typeof Vault>)
	.add('Append candidate rename/New V4.md');
const appendAfterRename = appendRenameFixture.registry.appendMemberToResolvedSeries(
	appendRenameExpectation,
	4,
	appendRenameCandidate,
);
(appendRenameFixture.vault as unknown as InstanceType<typeof Vault>).rename(
	'Append candidate rename/New V4.md',
	'Append candidate rename/Renamed before commit.md',
);
await assert.rejects(() => appendAfterRename, /no longer the same supported file/u);
assertions += 1;
equal(
	appendRenameFixture.persisted.length,
	0,
	'a queued candidate rename is rejected before registry persistence',
);
assert.deepEqual(
	appendRenameFixture.registry.getRecordById(appendRenameFixture.initialRecord.id),
	appendRenameFixture.initialRecord,
	'a queued candidate rename leaves every old slot untouched',
);
assertions += 1;

const appendCandidateReplacementFixture = makeCompatibleAppendFixture(
	'Append candidate replacement',
	'live-coarse',
);
const appendCandidateReplacementExpectation = appendCandidateReplacementFixture.registry
	.captureAppendExpectation(appendCandidateReplacementFixture.initialRecord.id);
check(
	appendCandidateReplacementExpectation,
	'candidate replacement fixture captures authorization',
);
const appendCandidatePath = 'Append candidate replacement/New V4.md';
const replacedAppendCandidate = (
	appendCandidateReplacementFixture.vault as unknown as InstanceType<typeof Vault>
).add(appendCandidatePath);
const replacedAppendCandidateStats = { ...replacedAppendCandidate.stat };
const appendAfterCandidateReplacement = appendCandidateReplacementFixture.registry
	.appendMemberToResolvedSeries(
		appendCandidateReplacementExpectation,
		4,
		replacedAppendCandidate,
	);
(
	appendCandidateReplacementFixture.vault as unknown as InstanceType<typeof Vault>
).delete(replacedAppendCandidate);
const substituteAppendCandidate = (
	appendCandidateReplacementFixture.vault as unknown as InstanceType<typeof Vault>
).add(appendCandidatePath);
Object.assign(substituteAppendCandidate.stat, replacedAppendCandidateStats);
await assert.rejects(
	() => appendAfterCandidateReplacement,
	/no longer the same supported file/u,
);
assertions += 1;
equal(
	appendCandidateReplacementFixture.persisted.length,
	0,
	'a same-path same-stat candidate replacement is rejected by TFile identity',
);

const appendOldReplacementFixture = makeCompatibleAppendFixture(
	'Append old replacement',
	'stored-coarse',
);
const appendOldReplacementExpectation = appendOldReplacementFixture.registry
	.captureAppendExpectation(appendOldReplacementFixture.initialRecord.id);
check(appendOldReplacementExpectation, 'old member replacement fixture captures authorization');
const oldMemberPath = 'Append old replacement/Board.canvas';
const replacedOldMember = appendOldReplacementFixture.vault.getFileByPath(oldMemberPath);
check(replacedOldMember, 'old member replacement fixture resolves V2');
const replacedOldMemberStats = { ...replacedOldMember.stat };
(appendOldReplacementFixture.vault as unknown as InstanceType<typeof Vault>)
	.delete(replacedOldMember);
const substituteOldMember = (appendOldReplacementFixture.vault as unknown as InstanceType<typeof Vault>)
	.add(oldMemberPath);
Object.assign(substituteOldMember.stat, replacedOldMemberStats);
const appendOldReplacementCandidate = (
	appendOldReplacementFixture.vault as unknown as InstanceType<typeof Vault>
).add('Append old replacement/New V4.md');
await assert.rejects(
	() => appendOldReplacementFixture.registry.appendMemberToResolvedSeries(
		appendOldReplacementExpectation,
		4,
		appendOldReplacementCandidate,
	),
	/changed or disappeared/u,
);
assertions += 1;
equal(
	appendOldReplacementFixture.persisted.length,
	0,
	'a captured old member replaced by a same-path same-ctime TFile is never adopted',
);

const repairDissolveFixtures = [
	{
		id: 'management-dissolve-incomplete',
		paths: ['Repair dissolve incomplete V1.md'],
		record: (repairVault: Vault) => ({
			id: 'management-dissolve-incomplete',
			slots: [
				{
					member: memberAt(repairVault, 'Repair dissolve incomplete V1.md'),
					version: 1,
				},
				{
					member: {
						identity: { ctime: 1_000 },
						lastKnownName: 'Missing V2',
						path: 'Repair dissolve missing V2.md',
					},
					version: 2,
				},
			],
		}),
		status: 'incomplete',
	},
	{
		id: 'management-dissolve-invalid',
		paths: [
			'Repair dissolve invalid V1.md',
			'Repair dissolve invalid duplicate.md',
		],
		record: (repairVault: Vault) => ({
			id: 'management-dissolve-invalid',
			slots: [
				{
					member: memberAt(repairVault, 'Repair dissolve invalid V1.md'),
					version: 1,
				},
				{
					member: memberAt(
						repairVault,
						'Repair dissolve invalid duplicate.md',
					),
					version: 1,
				},
			],
		}),
		status: 'invalid',
	},
] as const;
for (const fixture of repairDissolveFixtures) {
	const repairVault = new Vault([...fixture.paths]) as unknown as Vault;
	const repairRecord = fixture.record(repairVault);
	let repairPersists = 0;
	const repairRegistry = new VersionRegistry(
		repairVault,
		[repairRecord],
		async () => {
			repairPersists += 1;
		},
	);
	equal(
		repairRegistry.captureAppendExpectation(fixture.id),
		null,
		`${fixture.status} relationship never receives append-only authorization`,
	);
	equal(
		repairRegistry.index.getGroupById(fixture.id)?.status,
		fixture.status,
		`${fixture.status} repair fixture starts fail-open`,
	);
	const capturedRepairRecord = repairRegistry.getRecordById(fixture.id);
	check(capturedRepairRecord, `${fixture.status} repair captures its exact record`);
	const capturedRepairRevision = repairRegistry.getRevision();
	const physicalFiles = fixture.paths.map((path) => repairVault.getFileByPath(path));
	await repairRegistry.dissolveSeries(
		fixture.id,
		capturedRepairRecord,
		capturedRepairRevision,
	);
	equal(
		repairRegistry.getRecordById(fixture.id),
		null,
		`${fixture.status} management repair may explicitly dissolve the relationship`,
	);
	equal(
		repairPersists,
		1,
		`${fixture.status} management dissolve persists only the registry change`,
	);
	for (const [index, path] of fixture.paths.entries()) {
		equal(
			repairVault.getFileByPath(path),
			physicalFiles[index],
			`${fixture.status} management dissolve leaves ${path} untouched`,
		);
	}
}

(vault as unknown as InstanceType<typeof Vault>).delete('别处/完全不同的名字.md');
index.rebuild([{
	id: 'missing-v2',
	slots: [
		{ member: memberAt(vault, '实验 (V1).md'), version: 1 },
		{ member: memberAt(vault, '别处/完全不同的名字.md', '完全不同的名字'), version: 2 },
	],
}]);
equal(index.getGroupById('missing-v2')?.status, 'incomplete', 'missing member fails open');
equal(index.getGroups().length, 0, 'incomplete series is never aggregated');

index.rebuild([{
	id: 'missing-v1',
	slots: [
		{ member: memberAt(vault, '失踪 V1.md', '失踪 V1'), version: 1 },
		{ member: memberAt(vault, '实验 (V2).md'), version: 2 },
	],
}]);
equal(index.getGroupById('missing-v1')?.status, 'incomplete', 'missing V1 fails open');
const missingV1Group = index.getGroupById('missing-v1');
check(missingV1Group, 'missing V1 remains available for explicit repair');
equal(
	buildFileExplorerVisibilityPlan(missingV1Group),
	null,
	'a real missing-V1 relationship never hides its surviving mounted members',
);

index.rebuild([
	{
		id: 'owner-a',
		slots: [
			{ member: memberAt(vault, '实验 (V1).md'), version: 1 },
			{ member: memberAt(vault, '实验 (V2).md'), version: 2 },
		],
	},
	{
		id: 'owner-b',
		slots: [
			{ member: memberAt(vault, '实验 (V1).md'), version: 1 },
			{ member: memberAt(vault, '另一篇.md', '另一篇'), version: 2 },
		],
	},
]);
equal(index.getGroupById('owner-a')?.status, 'invalid', 'duplicate path invalidates first owner');
equal(index.getGroupById('owner-b')?.status, 'invalid', 'duplicate path invalidates second owner');

const registryVault = new Vault(['主题.md', '角度.md', '其他.md']) as unknown as Vault;
let persisted: unknown = null;
const registry = new VersionRegistry(registryVault, [], async (records) => {
	persisted = records;
});
const topic = (registryVault as unknown as InstanceType<typeof Vault>).getFileByPath('主题.md') as unknown as TFile;
const angle = (registryVault as unknown as InstanceType<typeof Vault>).getFileByPath('角度.md') as unknown as TFile;
const other = (registryVault as unknown as InstanceType<typeof Vault>).getFileByPath('其他.md') as unknown as TFile;
await assert.rejects(
	() => registry.createSeries(topic, topic),
	/Duplicate Version file/u,
);
assertions += 1;
const seriesId = await registry.saveSeriesMembers(null, [
	{ file: topic, version: 1 },
	{ file: angle, version: 2 },
]);
check(typeof seriesId === 'string' && seriesId.length > 0, 'registry creates stable series id');
check(Array.isArray(persisted), 'registry persists before activating relationship');
equal(registry.index.getGroupById(seriesId)?.status, 'healthy', 'persisted series becomes active');

await assert.rejects(
	() => registry.saveSeriesMembers(null, [
		{ file: topic, version: 1 },
		{ file: other, version: 2 },
	]),
	/already belongs/u,
);
assertions += 1;
await assert.rejects(
	() => registry.addMember(seriesId, 100, other),
	/Invalid version number/u,
);
assertions += 1;

const changedBeforeSaveVault = new Vault([
	'Race V1.md',
	'Race V2.md',
]) as unknown as Vault;
const changedBeforeSaveRegistry = new VersionRegistry(
	changedBeforeSaveVault,
	[],
	async () => {},
);
const raceV1 = (changedBeforeSaveVault as unknown as InstanceType<typeof Vault>)
	.getFileByPath('Race V1.md') as unknown as TFile;
const raceV2 = (changedBeforeSaveVault as unknown as InstanceType<typeof Vault>)
	.getFileByPath('Race V2.md') as unknown as TFile;
const stagedRaceSlots = [
	{ member: memberRecordFromFile(raceV1), version: 1 },
	{ member: memberRecordFromFile(raceV2), version: 2 },
];
(changedBeforeSaveVault as unknown as InstanceType<typeof Vault>).delete(raceV2);
(changedBeforeSaveVault as unknown as InstanceType<typeof Vault>).add('Race V2.md');
await assert.rejects(
	() => changedBeforeSaveRegistry.saveSeriesSlots(null, stagedRaceSlots),
	/changed or disappeared/u,
);
assertions += 1;
equal(
	changedBeforeSaveRegistry.getRecords().length,
	0,
	'a deleted or same-path-replaced member cannot be committed by a stale dialog',
);

const renamed = (registryVault as unknown as InstanceType<typeof Vault>).rename('角度.md', '子目录/新角度.md') as unknown as TFile;
await registry.updateMemberPath('角度.md', renamed);
equal(
	registry.getRecordById(seriesId)?.slots.find((slot) => slot.version === 2)?.member?.path,
	'子目录/新角度.md',
	'rename updates the explicit member path',
);

(registryVault as unknown as InstanceType<typeof Vault>).delete('主题.md');
registry.rebuild();
equal(registry.index.getGroupById(seriesId)?.status, 'incomplete', 'V1 deletion makes relation visible/incomplete');
const restoredAtSamePath = (registryVault as unknown as InstanceType<typeof Vault>)
	.add('主题.md');
registry.rebuild();
equal(
	registry.index.getGroupById(seriesId)?.status,
	'incomplete',
	'a different file at the same path is not silently adopted',
);
const repairedSlots = registry.getRecordById(seriesId)?.slots.map((slot) =>
	slot.version === 1
		? { member: memberRecordFromFile(restoredAtSamePath), version: 1 }
		: slot,
);
check(repairedSlots, 'damaged series remains available for explicit repair');
await registry.saveSeriesSlots(seriesId, repairedSlots);
equal(
	registry.index.getGroupById(seriesId)?.status,
	'healthy',
	'explicit management save can re-accept the replacement identity',
);

const substitutedVault = new Vault([
	'Substitution topic.md',
	'Substitution member.md',
]) as unknown as Vault;
const substitutedRegistry = new VersionRegistry(
	substitutedVault,
	[{
		id: 'rename-substitution',
		slots: [
			{ member: memberAt(substitutedVault, 'Substitution topic.md'), version: 1 },
			{ member: memberAt(substitutedVault, 'Substitution member.md'), version: 2 },
		],
	}],
	async () => {},
);
(substitutedVault as unknown as InstanceType<typeof Vault>)
	.delete('Substitution member.md');
const unrelatedAtOldPath = (substitutedVault as unknown as InstanceType<typeof Vault>)
	.add('Substitution member.md', 'unrelated replacement');
const renamedUnrelated = (substitutedVault as unknown as InstanceType<typeof Vault>)
	.rename('Substitution member.md', 'Renamed unrelated.md');
equal(
	unrelatedAtOldPath,
	renamedUnrelated,
	'the adversarial rename uses the same replacement object',
);
equal(
	await substitutedRegistry.updateMemberPath(
		'Substitution member.md',
		renamedUnrelated as unknown as TFile,
	),
	false,
	'an unrelated same-path replacement rename is not adopted',
);
equal(
	substitutedRegistry.getRecordById('rename-substitution')?.slots[1].member?.path,
	'Substitution member.md',
	'rejected replacement rename preserves the last known registered path',
);
equal(
	substitutedRegistry.index.getGroupById('rename-substitution')?.status,
	'incomplete',
	'rejected replacement rename keeps the damaged series fail-open',
);
equal(
	substitutedRegistry.index.getGroupForFile(renamedUnrelated as unknown as TFile),
	null,
	'unrelated replacement remains unmanaged after its rename',
);

await registry.dissolveSeries(seriesId);
equal(registry.getRecords().length, 0, 'dissolve removes only relationship data');
check(
	(registryVault as unknown as InstanceType<typeof Vault>).getFileByPath('主题.md'),
	'dissolve keeps Markdown files',
);

const failingVault = new Vault(['原名.md', '另一版.md']) as unknown as Vault;
const failingInitial = [{
	id: 'persist-failure',
	slots: [
		{ member: memberAt(failingVault, '原名.md'), version: 1 },
		{ member: memberAt(failingVault, '另一版.md'), version: 2 },
	],
}];
const failingRegistry = new VersionRegistry(
	failingVault,
	failingInitial,
	async () => {
		throw new Error('disk unavailable');
	},
);
const movedAfterFailure = (failingVault as unknown as InstanceType<typeof Vault>)
	.rename('另一版.md', '移动后.md') as unknown as TFile;
await assert.rejects(
	() => failingRegistry.updateMemberPath('另一版.md', movedAfterFailure),
	/disk unavailable/u,
);
assertions += 1;
equal(
	failingRegistry.getRecordById('persist-failure')?.slots[1].member?.path,
	'另一版.md',
	'failed persistence does not activate an unpersisted relationship',
);
equal(
	failingRegistry.index.getGroupById('persist-failure')?.status,
	'incomplete',
	'failed path persistence leaves the affected series visible',
);

const folderRenameVault = new Vault([
	'Old/Topic.md',
	'Old/Nested/Angle.canvas',
	'Outside.md',
	'Old/Other.md',
	'Old/Nested/Sketch.excalidraw.md',
	'Old copy/Keep.md',
	'Boundary outside.md',
]) as unknown as Vault;
const folderRenameInitial = [
	{
		id: 'folder-series-a',
		slots: [
			{ member: memberAt(folderRenameVault, 'Old/Topic.md'), version: 1 },
			{ member: memberAt(folderRenameVault, 'Old/Nested/Angle.canvas'), version: 2 },
			{ member: memberAt(folderRenameVault, 'Outside.md'), version: 3 },
		],
	},
	{
		id: 'folder-series-b',
		slots: [
			{ member: memberAt(folderRenameVault, 'Old/Other.md'), version: 1 },
			{ member: memberAt(folderRenameVault, 'Old/Nested/Sketch.excalidraw.md'), version: 2 },
		],
	},
	{
		id: 'folder-prefix-boundary',
		slots: [
			{ member: memberAt(folderRenameVault, 'Old copy/Keep.md'), version: 1 },
			{ member: memberAt(folderRenameVault, 'Boundary outside.md'), version: 2 },
		],
	},
];
let folderRenamePersistCount = 0;
const folderRenameRegistry = new VersionRegistry(
	folderRenameVault,
	folderRenameInitial,
	async () => {
		folderRenamePersistCount += 1;
	},
);
const folderRenameMock = folderRenameVault as unknown as InstanceType<typeof Vault>;
folderRenameMock.rename('Old/Topic.md', 'New/Topic.md');
folderRenameMock.rename('Old/Nested/Angle.canvas', 'New/Nested/Angle.canvas');
folderRenameMock.rename('Old/Other.md', 'New/Other.md');
folderRenameMock.rename(
	'Old/Nested/Sketch.excalidraw.md',
	'New/Nested/Sketch.excalidraw.md',
);
equal(
	await folderRenameRegistry.reconcileFolderRename('Old', 'New'),
	4,
	'folder reconciliation updates every exact registered descendant',
);
equal(
	folderRenamePersistCount,
	1,
	'multiple series and nested descendants are saved in one folder transaction',
);
equal(
	folderRenameRegistry.getRecordById('folder-series-a')?.slots[0].member?.path,
	'New/Topic.md',
	'folder reconciliation preserves the V1 relative suffix',
);
equal(
	folderRenameRegistry.getRecordById('folder-series-a')?.slots[1].member?.path,
	'New/Nested/Angle.canvas',
	'folder reconciliation preserves nested supported-file suffixes',
);
equal(
	folderRenameRegistry.getRecordById('folder-series-a')?.slots[2].member?.path,
	'Outside.md',
	'a series member outside the renamed folder is not physically or logically moved',
);
equal(
	folderRenameRegistry.getRecordById('folder-prefix-boundary')?.slots[0].member?.path,
	'Old copy/Keep.md',
	'folder prefix matching does not capture a similarly named sibling',
);
equal(
	folderRenameRegistry.index.getGroupById('folder-series-a')?.status,
	'healthy',
	'a completely verified folder rename remains healthy',
);

const failedFolderVault = new Vault([
	'Before/V1.md',
	'Before/V2.md',
]) as unknown as Vault;
const failedFolderInitial = [{
	id: 'failed-folder-series',
	slots: [
		{ member: memberAt(failedFolderVault, 'Before/V1.md'), version: 1 },
		{ member: memberAt(failedFolderVault, 'Before/V2.md'), version: 2 },
	],
}];
let failedFolderPersistCount = 0;
const failedFolderRegistry = new VersionRegistry(
	failedFolderVault,
	failedFolderInitial,
	async () => {
		failedFolderPersistCount += 1;
	},
);
const failedFolderMock = failedFolderVault as unknown as InstanceType<typeof Vault>;
failedFolderMock.rename('Before/V1.md', 'After/V1.md');
failedFolderMock.delete('Before/V2.md');
failedFolderMock.add('After/V2.md', 'replacement');
await assert.rejects(
	() => failedFolderRegistry.reconcileFolderRename('Before', 'After'),
	/could not be verified/u,
);
assertions += 1;
equal(
	failedFolderPersistCount,
	0,
	'a missing or replaced descendant aborts before persistence',
);
equal(
	failedFolderRegistry.getRecordById('failed-folder-series')?.slots[0].member?.path,
	'Before/V1.md',
	'a failed folder transaction activates none of its otherwise valid path changes',
);
equal(
	failedFolderRegistry.index.getGroupById('failed-folder-series')?.status,
	'incomplete',
	'a failed folder transaction remains fail-open and visible',
);

const legacyIdentityVault = new Vault([
	'Legacy topic.md',
	'Legacy parallel.md',
]) as unknown as Vault;
let migratedIdentityRecords: unknown = null;
const legacyIdentityRegistry = new VersionRegistry(
	legacyIdentityVault,
	[{
		id: 'legacy-identities',
		slots: [
			{ member: { lastKnownName: 'Legacy topic', path: 'Legacy topic.md' }, version: 1 },
			{ member: { lastKnownName: 'Legacy parallel', path: 'Legacy parallel.md' }, version: 2 },
		],
	}],
	async (records) => {
		migratedIdentityRecords = records;
	},
);
equal(
	legacyIdentityRegistry.index.getGroupById('legacy-identities')?.status,
	'incomplete',
	'legacy path-only series stays visible before identity migration persists',
);
equal(
	await legacyIdentityRegistry.migrateLegacyMemberIdentities(),
	1,
	'a complete legacy series migrates atomically',
);
equal(
	legacyIdentityRegistry.index.getGroupById('legacy-identities')?.status,
	'healthy',
	'successfully persisted member identities activate the series',
);
check(Array.isArray(migratedIdentityRecords), 'identity migration persists relationship data');
check(
	legacyIdentityRegistry.getRecordById('legacy-identities')?.slots.every(
		(slot) => Number.isFinite(slot.member?.identity?.ctime),
	),
	'identity migration records every member before activation',
);

const failedLegacyMigration = new VersionRegistry(
	legacyIdentityVault,
	[{
		id: 'failed-legacy-identities',
		slots: [
			{ member: { lastKnownName: 'Legacy topic', path: 'Legacy topic.md' }, version: 1 },
			{ member: { lastKnownName: 'Legacy parallel', path: 'Legacy parallel.md' }, version: 2 },
		],
	}],
	async () => {
		throw new Error('identity migration write failed');
	},
);
await assert.rejects(
	() => failedLegacyMigration.migrateLegacyMemberIdentities(),
	/identity migration write failed/u,
);
assertions += 1;
equal(
	failedLegacyMigration.index.getGroupById('failed-legacy-identities')?.status,
	'incomplete',
	'failed legacy migration never activates or hides a path-only series',
);

const numberedVault = new Vault(['V1.md', 'V2.md', 'V4.md']) as unknown as Vault;
const numberedIndex = new VersionIndex(numberedVault);
numberedIndex.rebuild([{
	id: 'numbered',
	slots: [1, 2, 4].map((version) => ({
		member: memberAt(numberedVault, `V${version}.md`),
		version,
	})),
}]);
const numbered = numberedIndex.getGroupById('numbered');
check(numbered, 'numbered group resolves');
assert.deepEqual(getMissingVersions(numbered), [3]);
assertions += 1;
equal(getNextVersion(numbered), 5, 'next maximum is independent from gaps');

const arbitraryNamesVault = new Vault([
	'实验.md',
	'另一种表达.md',
	'随手写的欢迎.md',
	'没有版本后缀.md',
]) as unknown as Vault;
const arbitraryNamesIndex = new VersionIndex(arbitraryNamesVault);
arbitraryNamesIndex.rebuild([{
	id: 'arbitrary-member-names',
	slots: [
		{ member: memberAt(arbitraryNamesVault, '实验.md'), version: 1 },
		{ member: memberAt(arbitraryNamesVault, '另一种表达.md'), version: 2 },
		{ member: memberAt(arbitraryNamesVault, '随手写的欢迎.md'), version: 4 },
		{ member: memberAt(arbitraryNamesVault, '没有版本后缀.md'), version: 5 },
	],
}]);
const arbitraryNames = arbitraryNamesIndex.getGroupById('arbitrary-member-names');
check(arbitraryNames, 'a series with arbitrary member filenames resolves');
assert.deepEqual(
	getMissingVersions(arbitraryNames),
	[3],
	'registered version numbers, never filename syntax, determine numeric gaps',
);
assertions += 1;
equal(
	getNextVersion(arbitraryNames),
	6,
	'an arbitrary V4 filename remains occupied when calculating the next version',
);

const vacantVault = new Vault(['Stable V1.md', 'Stable V2.md', 'Stable V4.md', 'Replacement.md']) as unknown as Vault;
let vacantPersisted: unknown = null;
const vacantRegistry = new VersionRegistry(vacantVault, [{
	id: 'stable-gap',
	slots: [
		{ member: memberAt(vacantVault, 'Stable V1.md'), version: 1 },
		{ member: memberAt(vacantVault, 'Stable V2.md'), version: 2 },
		{ member: memberAt(vacantVault, 'Stable V4.md'), version: 4 },
	],
}], async (records) => {
	vacantPersisted = records;
});
const stableGap = vacantRegistry.index.getGroupById('stable-gap');
check(stableGap, 'a numeric gap resolves');
equal(stableGap.status, 'healthy', 'an absent version number is a safe numeric gap');
assert.deepEqual(getMissingVersions(stableGap), [3]);
assertions += 1;
equal(getNextVersion(stableGap), 5, 'a vacant V3 keeps V4 stable and the next version is V5');
const replacement = (vacantVault as unknown as InstanceType<typeof Vault>)
	.getFileByPath('Replacement.md') as unknown as TFile;
await vacantRegistry.addMember('stable-gap', 3, replacement);
const filledSlots = vacantRegistry.getRecordById('stable-gap')?.slots ?? [];
equal(filledSlots.filter((slot) => slot.version === 3).length, 1, 'filling a vacant slot does not create a duplicate version number');
equal(filledSlots.find((slot) => slot.version === 3)?.member?.path, 'Replacement.md', 'the selected file fills the exact vacant version');
check(Array.isArray(vacantPersisted), 'filling a vacant slot persists the repaired relationship');

const invalidEmptyIndex = new VersionIndex(vacantVault);
invalidEmptyIndex.rebuild([{
	id: 'unsavable-empty',
	slots: [
		{ member: memberAt(vacantVault, 'Stable V1.md'), version: 1 },
		{ member: null, version: 2 },
	],
}]);
equal(
	invalidEmptyIndex.getGroupById('unsavable-empty')?.status,
	'incomplete',
	'an explicit Version without a note fails open instead of hiding files',
);
assert.deepEqual(
	getMissingVersions(invalidEmptyIndex.getGroupById('unsavable-empty')!),
	[],
	'an unresolved registered member is repaired in management, never offered as a fillable gap',
);
assertions += 1;
assert.throws(
	() => vacantRegistry.preflightSeriesSlots('stable-gap', [
		{ member: { lastKnownName: 'Stable V1', path: 'Stable V1.md' }, version: 1 },
		{ member: null, version: 2 },
	]),
	/does not have a note/u,
);
assertions += 1;

const gapPaths = [1, 5, 20, 50, 99].map((version) => `Limit V${version}.md`);
const limitVault = new Vault(gapPaths) as unknown as Vault;
const limitIndex = new VersionIndex(limitVault);
limitIndex.rebuild([{
	id: 'limit',
	slots: [1, 5, 20, 50, 99].map((version) => ({
		member: memberAt(limitVault, `Limit V${version}.md`),
		version,
	})),
}]);
const limit = limitIndex.getGroupById('limit');
check(limit, 'V99 series resolves');
equal(getNextVersion(limit), 100, 'maximum creation stops after V99');
const manyGaps = getMissingVersions(limit);
equal(manyGaps.length, 94, 'all multiple gaps through V99 are enumerated');
equal(manyGaps[0], 2, 'gap list starts at the first missing version');
equal(manyGaps.at(-1), 98, 'gap list remains bounded below V99');

const normalized = normalizePluginData({
	language: 'zh-CN',
	schemaVersion: 1,
	series: [{
		id: 'kept',
		slots: [
			{ version: 1, member: { path: '主题.md', lastKnownName: '主题' } },
			{ version: 2, member: null },
			{ version: 3, member: { path: '主题另一版.md', lastKnownName: '主题另一版' } },
		],
	}],
});
equal(normalized.language, 'zh-CN', 'language survives normalization');
equal(normalizePluginData({ language: 'da' }).language, 'da', 'Danish survives normalization');
equal(normalizePluginData({ language: 'ja' }).language, 'ja', 'Japanese survives normalization');
equal(normalizePluginData({ language: 'xx' }).language, 'en', 'unknown locale safely falls back to English');
assert.deepEqual(SUPPORTED_LANGUAGES, ['en', 'zh-CN', 'da', 'ja']);
assertions += 1;
equal(new VersionI18n('da').t('manage.done'), 'Færdig', 'Danish catalog is reachable');
equal(new VersionI18n('ja').t('manage.done'), '完了', 'Japanese catalog is reachable');
equal(
	new VersionI18n('ja').t('view.fileActionsForVersion', { version: 8 }),
	'V8 のファイル操作…',
	'Japanese placeholders interpolate',
);
equal(
	buildCopyFilename(new TFile('Sketch.excalidraw.md'), 1),
	'Sketch copy.excalidraw.md',
	'copy preserves the Excalidraw Markdown compound extension',
);
equal(
	buildCopyFilename(new TFile('Board.canvas'), 2),
	'Board copy 2.canvas',
	'copy preserves ordinary note-like extensions',
);
equal(normalized.series.length, 1, 'valid explicit series survives normalization');
assert.deepEqual(
	normalized.series[0].slots.map((slot) => slot.version),
	[1, 3],
	'schema-1 null slots migrate to absent numeric gaps',
);
assertions += 1;

const schema3DamageVault = new Vault([
	'Damaged/Representative.md',
	'Damaged/Survivor.md',
]) as unknown as Vault;
const normalizedSchema3Damage = normalizePluginData({
	schemaVersion: 3,
	series: [{
		id: 'schema3-damaged-member',
		slots: [
			{
				member: memberAt(schema3DamageVault, 'Damaged/Representative.md'),
				version: 1,
			},
			{
				member: { lastKnownName: 'Broken V2', path: 42 },
				version: 2,
			},
			{
				member: memberAt(schema3DamageVault, 'Damaged/Survivor.md'),
				version: 3,
			},
		],
	}],
});
equal(
	normalizedSchema3Damage.series.length,
	1,
	'schema 3 registry damage preserves the known relationship for repair',
);
assert.deepEqual(
	normalizedSchema3Damage.series[0]?.slots.map((slot) => [
		slot.version,
		slot.member?.path ?? null,
	]),
	[
		[1, 'Damaged/Representative.md'],
		[2, null],
		[3, 'Damaged/Survivor.md'],
	],
	'a malformed schema 3 member remains an unresolved slot instead of becoming a numeric gap',
);
assertions += 1;
const schema3DamageIndex = new VersionIndex(schema3DamageVault);
schema3DamageIndex.rebuild(normalizedSchema3Damage.series);
const schema3DamageGroup = schema3DamageIndex.getGroupById(
	'schema3-damaged-member',
);
check(schema3DamageGroup, 'schema 3 damaged relationship remains addressable');
equal(
	schema3DamageGroup.status,
	'incomplete',
	'a malformed schema 3 member makes the whole relationship fail open',
);
equal(
	buildFileExplorerVisibilityPlan(schema3DamageGroup),
	null,
	'schema 3 registry damage never hides the surviving real files',
);

const schema3SingleVault = new Vault(['Damaged/Only survivor.md']) as unknown as Vault;
const normalizedSchema3Single = normalizePluginData({
	schemaVersion: 3,
	series: [{
		id: 'schema3-single-member',
		slots: [{
			member: memberAt(schema3SingleVault, 'Damaged/Only survivor.md'),
			version: 1,
		}],
	}],
});
equal(
	normalizedSchema3Single.series.length,
	1,
	'a current-schema single-member damaged record is retained for repair',
);
const schema3SingleIndex = new VersionIndex(schema3SingleVault);
schema3SingleIndex.rebuild(normalizedSchema3Single.series);
const schema3SingleGroup = schema3SingleIndex.getGroupById(
	'schema3-single-member',
);
check(schema3SingleGroup, 'a current-schema single-member record stays addressable');
equal(schema3SingleGroup.status, 'invalid', 'a one-member relationship fails open');
equal(
	buildFileExplorerVisibilityPlan(schema3SingleGroup),
	null,
	'a one-member damaged relationship never hides its surviving file',
);
equal(
	normalized.releasedVersionDestination,
	'series-folder',
	'legacy data defaults released notes to the current theme folder',
);
equal(
	normalizePluginData({ releasedVersionDestination: 'vault-root' })
		.releasedVersionDestination,
	'vault-root',
	'the vault-root release preference survives normalization',
);
check(isValidFilenameTemplate('{{name}} (V{{version}})'), 'valid filename template accepted');
equal(isValidFilenameTemplate('{{name}}'), false, 'template must include a version placeholder');
equal(isValidFilenameTemplate('../{{version}}'), false, 'template cannot contain path separators');

const invalidTemplate = normalizePluginData({
	filenameTemplate: '../{{version}}',
});
equal(
	invalidTemplate.filenameTemplate,
	'{{name}} (V{{version}})',
	'invalid persisted template safely falls back to the default',
);

const recoveryVault = new Vault([
	'实验 (V11).md',
	'实验 (V11)2.md',
]) as unknown as Vault;
equal(
	findRecoveryPath({ vault: recoveryVault } as never, '实验 (V11)'),
	'实验 (V11)3.md',
	'recovery import preserves both existing files and increments a plain suffix',
);

await assert.rejects(
	() => registry.saveSeriesMembers(null, [
		{ file: other, version: 1 },
		{ file: angle, version: 100 },
	]),
	/Invalid or duplicate version/u,
);
assertions += 1;

assert.throws(
	() => registry.preflightSeriesSlots('missing-series', [
		{ member: { lastKnownName: '其他', path: '其他.md' }, version: 1 },
		{ member: { lastKnownName: '新角度', path: '子目录/新角度.md' }, version: 2 },
	]),
	/no longer exists/u,
);
assertions += 1;

const duplicateIds = normalizePluginData({
	series: [
		{ id: 'same', slots: [
			{ version: 1, member: { path: 'a.md', lastKnownName: 'a' } },
			{ version: 2, member: { path: 'a2.md', lastKnownName: 'a2' } },
		] },
		{ id: 'same', slots: [
			{ version: 1, member: { path: 'b.md', lastKnownName: 'b' } },
			{ version: 2, member: { path: 'b2.md', lastKnownName: 'b2' } },
		] },
	],
});
equal(new Set(duplicateIds.series.map((record) => record.id)).size, 2, 'duplicate technical IDs are repaired without guessing file membership');

const damagedDuplicateIdVault = new Vault([
	'Duplicate/A1.md',
	'Duplicate/A2.md',
	'Duplicate/B1.md',
	'Duplicate/B2.md',
]) as unknown as Vault;
const damagedDuplicateIds = normalizePluginData({
	schemaVersion: 3,
	series: [
		{ id: 'same-current-id', slots: [
			{ member: memberAt(damagedDuplicateIdVault, 'Duplicate/A1.md'), version: 1 },
			{ member: memberAt(damagedDuplicateIdVault, 'Duplicate/A2.md'), version: 2 },
		] },
		{ id: 'same-current-id', slots: [
			{ member: memberAt(damagedDuplicateIdVault, 'Duplicate/B1.md'), version: 1 },
			{ member: memberAt(damagedDuplicateIdVault, 'Duplicate/B2.md'), version: 2 },
		] },
	],
});
equal(
	new Set(damagedDuplicateIds.series.map((record) => record.id)).size,
	1,
	'current-schema duplicate IDs remain visible as registry damage',
);
const damagedDuplicateIdIndex = new VersionIndex(damagedDuplicateIdVault);
damagedDuplicateIdIndex.rebuild(damagedDuplicateIds.series);
equal(
	damagedDuplicateIdIndex.getGroups().length,
	0,
	'current-schema duplicate IDs make every affected relationship fail open',
);
assert.deepEqual(
	damagedDuplicateIdIndex.getAllGroups().map((group) => group.status),
	['invalid', 'invalid'],
	'duplicate current-schema relationships are not silently assigned new identities',
);
assertions += 1;
const repairChoices = filterAllowedSeries(
	[
		{ id: 'conflict-a' },
		{ id: 'unrelated' },
		{ id: 'conflict-b' },
	],
	new Set(['conflict-a', 'conflict-b']),
);
assert.deepEqual(
	repairChoices.map((choice) => choice.id),
	['conflict-a', 'conflict-b'],
	'ambiguous repair lists only relationships that registered the conflicting path',
);
assertions += 1;
equal(
	filterAllowedSeries([{ id: 'all-a' }, { id: 'all-b' }], null).length,
	2,
	'ordinary series browsing remains unfiltered',
);

let releaseFirstPersist: (() => void) | null = null;
const firstPersistGate = new Promise<void>((resolve) => {
	releaseFirstPersist = resolve;
});
const persistedSnapshots: Array<{ language: string; series: string[] }> = [];
let persistenceCalls = 0;
let committedSnapshot = { language: 'en', series: ['old-path'] };
const serializedStore = new SerializedDataStore(
	committedSnapshot,
	async (next) => {
		persistenceCalls += 1;
		if (persistenceCalls === 1) {
			await firstPersistGate;
		}
		persistedSnapshots.push({
			language: next.language,
			series: [...next.series],
		});
	},
	(next) => {
		committedSnapshot = next;
	},
);
const languageUpdate = serializedStore.update((current) => ({
	...current,
	language: 'da',
}));
const seriesUpdate = serializedStore.update((current) => ({
	...current,
	series: ['new-path'],
}));
await Promise.resolve();
equal(persistenceCalls, 1, 'plugin-data persistence is serialized');
releaseFirstPersist?.();
await Promise.all([languageUpdate, seriesUpdate]);
equal(persistedSnapshots.length, 2, 'both serialized updates persist');
equal(committedSnapshot.language, 'da', 'overlapping series save keeps language');
assert.deepEqual(committedSnapshot.series, ['new-path']);
assertions += 1;

let externalReloadPersists = 0;
let externallyCommitted = { language: 'en', series: ['before-sync'] };
const externalReloadBase = externallyCommitted;
const externalReloadIncoming = { language: 'zh-CN', series: ['from-icloud'] };
const externalReloadStore = new SerializedDataStore(
	externallyCommitted,
	async () => {
		externalReloadPersists += 1;
	},
	(next) => {
		externallyCommitted = next;
	},
);
const externalSnapshot = await externalReloadStore.reconcile(
	externalReloadBase,
	externalReloadIncoming,
	(_base, _current, incoming) => incoming,
	(left, right) => JSON.stringify(left) === JSON.stringify(right),
);
equal(externalReloadPersists, 0, 'an uncontended external snapshot is never written back');
assert.deepEqual(externalSnapshot, externallyCommitted);
assertions += 1;
await externalReloadStore.update((current) => ({ ...current, language: 'ja' }));
equal(externalReloadPersists, 1, 'the next local change persists normally after a reload');
assert.deepEqual(
	externallyCommitted,
	{ language: 'ja', series: ['from-icloud'] },
	'a local settings change derives from the externally reloaded series snapshot',
);
assertions += 1;

const localWinnerBase = { language: 'en', series: ['stable'] };
const localWinnerIncoming = { language: 'zh-CN', series: ['stable'] };
let localWinnerDisk = localWinnerBase;
let localWinnerPersists = 0;
const localWinnerStore = new SerializedDataStore(
	localWinnerBase,
	async (next) => {
		localWinnerPersists += 1;
		localWinnerDisk = next;
	},
	() => undefined,
);
await localWinnerStore.update((current) => ({
	...current,
	language: 'ja',
}));
localWinnerDisk = localWinnerIncoming;
await localWinnerStore.reconcile(
	localWinnerBase,
	localWinnerIncoming,
	(_base, current) => current,
	(left, right) => JSON.stringify(left) === JSON.stringify(right),
);
equal(
	localWinnerPersists,
	2,
	'a local winner that differs from the captured disk snapshot is persisted',
);
assert.deepEqual(
	localWinnerDisk,
	{ language: 'ja', series: ['stable'] },
	'reconciliation never leaves memory and data.json on different winners',
);
assertions += 1;
equal(
	isVersionPluginDataSnapshot(null),
	false,
	'a transiently missing external data file is not adopted as an empty registry',
);
equal(
	isVersionPluginDataSnapshot({ series: null }),
	false,
	'a truncated external series field is rejected before normalization',
);
check(
	isVersionPluginDataSnapshot({ series: [] }),
	'an explicit empty external series array remains a valid synchronized snapshot',
);
equal(
	normalizeExternalPluginData({
		schemaVersion: 3,
		series: [{ id: 'damaged-no-slots' }],
	}),
	null,
	'a damaged current-schema record cannot normalize away during external reload',
);
equal(
	normalizeExternalPluginData({
		schemaVersion: 99,
		series: [{ id: 'future-no-slots' }],
	}),
	null,
	'an unrecognized future snapshot cannot silently shrink the registry',
);
equal(
	normalizeExternalPluginData({
		schemaVersion: 99,
		series: [{
			id: 'future-valid-shape',
			slots: [
				{
					member: {
						identity: { ctime: 1_000 },
						lastKnownName: 'Future A',
						path: 'Future A.md',
					},
					version: 1,
				},
				{
					member: {
						identity: { ctime: 2_000 },
						lastKnownName: 'Future B',
						path: 'Future B.md',
					},
					version: 2,
				},
			],
		}],
	}),
	null,
	'a structurally familiar future schema is never downgraded and overwritten',
);
equal(
	normalizeExternalPluginData({ schemaVersion: '3', series: [] }),
	null,
	'a malformed explicit schema version is rejected during external reload',
);
for (const malformedSchemaVersion of [0, -1, 1.5, null]) {
	equal(
		normalizeExternalPluginData({
			schemaVersion: malformedSchemaVersion,
			series: [],
		}),
		null,
		`explicit malformed schema ${String(malformedSchemaVersion)} is rejected`,
	);
}

let failedReloadCommitted = { language: 'en', series: ['stable'] };
const failedReloadStore = new SerializedDataStore(
	failedReloadCommitted,
	async () => undefined,
	(next) => {
		failedReloadCommitted = next;
	},
);
await assert.rejects(
	() => failedReloadStore.reconcile(
		failedReloadCommitted,
		{ language: 'zh-CN', series: ['incoming'] },
		() => {
		throw new Error('external read failed');
		},
		(left, right) => JSON.stringify(left) === JSON.stringify(right),
	),
	/external read failed/u,
);
assertions += 1;
assert.deepEqual(
	failedReloadCommitted,
	{ language: 'en', series: ['stable'] },
	'a failed external loader leaves the committed store snapshot unchanged',
);
assertions += 1;
await failedReloadStore.update((current) => ({ ...current, language: 'da' }));
equal(
	failedReloadCommitted.language,
	'da',
	'the serialized store queue continues after an external loader failure',
);

const revisionReloadVault = new Vault([
	'Revision reload V1.md',
	'Revision reload V2.md',
	'Revision reload V3.md',
]) as unknown as Vault;
const revisionReloadInitial = [{
	id: 'revision-reload-series',
	slots: [
		{ member: memberAt(revisionReloadVault, 'Revision reload V1.md'), version: 1 },
		{ member: memberAt(revisionReloadVault, 'Revision reload V2.md'), version: 2 },
	],
}];
const revisionReloadRegistry = new VersionRegistry(
	revisionReloadVault,
	revisionReloadInitial,
	async () => undefined,
);
const revisionBeforeReload = revisionReloadRegistry.getRevision();
await revisionReloadRegistry.reload(async () => revisionReloadRegistry.getRecords());
equal(
	revisionReloadRegistry.getRevision(),
	revisionBeforeReload,
	'a byte-equivalent external series reload does not invalidate an open workflow',
);
const revisionReloadChanged = [{
	id: 'revision-reload-series',
	slots: [
		...revisionReloadInitial[0].slots,
		{ member: memberAt(revisionReloadVault, 'Revision reload V3.md'), version: 3 },
	],
}];
await revisionReloadRegistry.reload(async () => revisionReloadChanged);
equal(
	revisionReloadRegistry.getRevision(),
	revisionBeforeReload + 1,
	'a changed external series snapshot increments the registry revision exactly once',
);
await revisionReloadRegistry.reload(async () => revisionReloadRegistry.getRecords());
equal(
	revisionReloadRegistry.getRevision(),
	revisionBeforeReload + 1,
	'replaying the accepted changed series snapshot remains revision-idempotent',
);

const synchronizedVault = new Vault([
	'Synchronized topic.md',
	'Synchronized board.canvas',
]) as unknown as Vault;
const synchronizedRecords = [{
	id: 'synchronized-series',
	slots: [
		{ member: memberAt(synchronizedVault, 'Synchronized topic.md'), version: 1 },
		{ member: memberAt(synchronizedVault, 'Synchronized board.canvas'), version: 2 },
	],
}];
const synchronizedBase = normalizePluginData({
	filenameTemplate: '{{name}} (V{{version}})',
	language: 'en',
	releasedVersionDestination: 'series-folder',
	schemaVersion: 3,
	series: [],
});
const synchronizedIncoming = {
	...synchronizedBase,
	series: synchronizedRecords,
};

const disjointLocalRecord = {
	id: 'local-only-series',
	slots: synchronizedRecords[0].slots.map((slot) => ({
		member: slot.member ? { ...slot.member } : null,
		version: slot.version,
	})),
};
const disjointIncomingRecord = {
	id: 'incoming-only-series',
	slots: synchronizedRecords[0].slots.map((slot) => ({
		member: slot.member ? { ...slot.member } : null,
		version: slot.version,
	})),
};
const disjointBase = {
	...synchronizedBase,
	series: synchronizedRecords,
};
const disjointMerged = mergeExternalPluginData(
	disjointBase,
	{ ...disjointBase, series: [...synchronizedRecords, disjointLocalRecord] },
	{ ...disjointBase, series: [...synchronizedRecords, disjointIncomingRecord] },
);
assert.deepEqual(
	disjointMerged.series.map((record) => record.id),
	['incoming-only-series', 'local-only-series', 'synchronized-series'],
	'disjoint concurrent series additions from both devices are retained',
);
assertions += 1;

const splitBaseR0 = normalizePluginData({
	...synchronizedBase,
	language: 'en',
	series: [],
});
const splitBaseLocalX = normalizePluginData({
	...splitBaseR0,
	series: [{
		id: 'split-base-local-x',
		slots: synchronizedRecords[0].slots,
	}],
});
let splitBaseDisk = splitBaseR0;
let splitBaseAccepted = splitBaseR0;
let splitBasePersists = 0;
const splitBaseStore = new SerializedDataStore(
	splitBaseR0,
	async (next) => {
		splitBasePersists += 1;
		splitBaseDisk = next;
	},
	(next) => {
		splitBaseAccepted = next;
	},
);
await splitBaseStore.update(() => splitBaseLocalX);
splitBaseDisk = splitBaseR0;
const splitBaseAfterR0 = await splitBaseStore.reconcile(
	splitBaseR0,
	splitBaseR0,
	mergeExternalPluginData,
	versionPluginDataEqual,
);
assert.deepEqual(
	splitBaseAfterR0.series.map((record) => record.id),
	['split-base-local-x'],
	'old remote R0 cannot erase local X during the first write-back',
);
assertions += 1;
const splitBaseR1 = normalizePluginData({
	...splitBaseR0,
	language: 'da',
	series: [],
});
splitBaseDisk = splitBaseR1;
const splitRegistryAndScalarBase = normalizePluginData({
	...splitBaseAfterR0,
	series: splitBaseR0.series,
});
const splitBaseAfterR1 = await splitBaseStore.reconcile(
	splitRegistryAndScalarBase,
	splitBaseR1,
	mergeExternalPluginData,
	versionPluginDataEqual,
);
equal(
	splitBaseAfterR1.language,
	'da',
	'a scalar-only R1 update from the old device is accepted',
);
assert.deepEqual(
	splitBaseAfterR1.series.map((record) => record.id),
	['split-base-local-x'],
	'the captured remote registry base preserves local X when R1 still has series=[]',
);
assertions += 1;
assert.deepEqual(
	splitBaseDisk,
	splitBaseAfterR1,
	'the safe X plus da reconciliation is written back to synchronized storage',
);
assertions += 1;
assert.deepEqual(
	splitBaseAccepted,
	splitBaseAfterR1,
	'the in-memory settings accept exactly the split-base reconciliation',
);
assertions += 1;
equal(
	splitBasePersists,
	3,
	'local X and both old-device reconciliations each reach durable storage once',
);
equal(
	mergeExternalPluginData(
		splitBaseAfterR0,
		splitBaseAfterR0,
		splitBaseR1,
	).series.length,
	0,
	'using the reconciled X snapshot as the registry base would reproduce the data-loss regression',
);
assert.deepEqual(
	mergeExternalPluginData(
		splitBaseR0,
		splitBaseLocalX,
		splitBaseR0,
	).series.map((record) => record.id),
	['split-base-local-x'],
	'a restart-safe empty ancestor preserves local X when the first external snapshot is old R0',
);
assertions += 1;

const conflictVault = new Vault([
	'Conflict topic.md',
	'Conflict second.md',
	'Conflict third.md',
]) as unknown as Vault;
const conflictBaseRecord = {
	id: 'same-series-conflict',
	slots: [
		{ member: memberAt(conflictVault, 'Conflict topic.md'), version: 1 },
		{ member: memberAt(conflictVault, 'Conflict second.md'), version: 2 },
	],
};
const conflictCurrentRecord = {
	id: conflictBaseRecord.id,
	slots: [
		{ member: conflictBaseRecord.slots[1].member, version: 1 },
		{ member: conflictBaseRecord.slots[0].member, version: 2 },
	],
};
const conflictIncomingRecord = {
	id: conflictBaseRecord.id,
	slots: [
		...conflictBaseRecord.slots,
		{ member: memberAt(conflictVault, 'Conflict third.md'), version: 3 },
	],
};
const restartConflictMerged = mergeExternalPluginData(
	{ ...synchronizedBase, series: [] },
	{ ...synchronizedBase, series: [conflictCurrentRecord] },
	{ ...synchronizedBase, series: [conflictIncomingRecord] },
);
equal(
	restartConflictMerged.series.length,
	2,
	'a restart-safe empty ancestor preserves both live mappings for a first same-ID conflict',
);
const restartConflictIndex = new VersionIndex(conflictVault);
restartConflictIndex.rebuild(restartConflictMerged.series);
assert.deepEqual(
	restartConflictIndex.getAllGroups().map((group) => group.status),
	['invalid', 'invalid'],
	'a first same-ID conflict after restart fails open for explicit repair',
);
assertions += 1;
const conflictBaseData = {
	...synchronizedBase,
	series: [conflictBaseRecord],
};
const conflictMerged = mergeExternalPluginData(
	conflictBaseData,
	{ ...conflictBaseData, series: [conflictCurrentRecord] },
	{ ...conflictBaseData, series: [conflictIncomingRecord] },
);
const conflictMergedWithSidesReversed = mergeExternalPluginData(
	conflictBaseData,
	{ ...conflictBaseData, series: [conflictIncomingRecord] },
	{ ...conflictBaseData, series: [conflictCurrentRecord] },
);
assert.deepEqual(
	conflictMergedWithSidesReversed,
	conflictMerged,
	'same-series conflict recovery is canonical when device sides are reversed',
);
assertions += 1;
equal(
	conflictMerged.series.length,
	2,
	'divergent edits to one series retain both relationship snapshots',
);
equal(
	conflictMerged.series[0].id,
	'same-series-conflict',
	'the canonical conflict snapshot keeps the stable original ID',
);
check(
	conflictMerged.series[1].id.startsWith('same-series-conflict--sync-conflict-'),
	'the incoming conflict snapshot receives a deterministic recovery ID',
);
assert.deepEqual(
	conflictMerged.series.map((record) => record.slots.map((slot) => [
		slot.version,
		slot.member?.path,
	])),
	[
		[
			[1, 'Conflict topic.md'],
			[2, 'Conflict second.md'],
			[3, 'Conflict third.md'],
		],
		[
			[1, 'Conflict second.md'],
			[2, 'Conflict topic.md'],
		],
	],
	'conflict recovery changes neither side slot mapping',
);
assertions += 1;
const conflictIndex = new VersionIndex(conflictVault);
conflictIndex.rebuild(conflictMerged.series);
assert.deepEqual(
	conflictIndex.getAllGroups().map((group) => group.status),
	['invalid', 'invalid'],
	'overlapping conflict snapshots fail open instead of hiding either side',
);
assertions += 1;
const replayedOldConflictSnapshot = mergeExternalPluginData(
	conflictMerged,
	conflictMerged,
	{ ...conflictBaseData, series: [conflictIncomingRecord] },
);
assert.deepEqual(
	replayedOldConflictSnapshot,
	conflictMerged,
	'an unresolved recovery family survives replay of an older device snapshot',
);
assertions += 1;

let conflictReconcileDisk = conflictBaseData;
let conflictReconcilePersists = 0;
const conflictReconcileStore = new SerializedDataStore(
	conflictBaseData,
	async (next) => {
		conflictReconcilePersists += 1;
		conflictReconcileDisk = next;
	},
	() => undefined,
);
await conflictReconcileStore.update(() => ({
	...conflictBaseData,
	series: [conflictCurrentRecord],
}));
conflictReconcileDisk = {
	...conflictBaseData,
	series: [conflictIncomingRecord],
};
await conflictReconcileStore.reconcile(
	conflictBaseData,
	conflictReconcileDisk,
	mergeExternalPluginData,
	versionPluginDataEqual,
);
equal(
	conflictReconcilePersists,
	2,
	'a same-series conflict is persisted once after the preceding local save',
);
equal(
	conflictReconcileDisk.series.length,
	2,
	'the persisted conflict snapshot retains both device mappings',
);

const localDeleteRemoteEdit = mergeExternalPluginData(
	conflictBaseData,
	{ ...conflictBaseData, series: [] },
	{ ...conflictBaseData, series: [conflictIncomingRecord] },
);
assert.deepEqual(
	localDeleteRemoteEdit.series,
	[conflictIncomingRecord],
	'a remote edit survives a concurrent local relationship deletion',
);
assertions += 1;
const localEditRemoteDelete = mergeExternalPluginData(
	conflictBaseData,
	{ ...conflictBaseData, series: [conflictCurrentRecord] },
	{ ...conflictBaseData, series: [] },
);
assert.deepEqual(
	localEditRemoteDelete.series,
	[conflictCurrentRecord],
	'a local edit survives a concurrent remote relationship deletion',
);
assertions += 1;

const orderedConflictVariant = (name: string) => ({
	id: 'ordered-sync-conflict',
	slots: [
		{
			member: {
				identity: { ctime: 1_000 },
				lastKnownName: `${name}1`,
				path: `${name}1.md`,
			},
			version: 1,
		},
		{
			member: {
				identity: { ctime: 2_000 },
				lastKnownName: `${name}2`,
				path: `${name}2.md`,
			},
			version: 2,
		},
	],
});
const orderedConflictBase = {
	...synchronizedBase,
	series: [orderedConflictVariant('A')],
};
const orderedConflictMerged = mergeExternalPluginData(
	orderedConflictBase,
	{ ...orderedConflictBase, series: [orderedConflictVariant('B')] },
	{ ...orderedConflictBase, series: [orderedConflictVariant('C')] },
);
const orderedConflictOldReplay = mergeExternalPluginData(
	orderedConflictBase,
	orderedConflictMerged,
	orderedConflictBase,
);
assert.deepEqual(
	orderedConflictOldReplay,
	orderedConflictMerged,
	'an older A snapshot cannot duplicate B after the B/C recovery family exists',
);
assertions += 1;
const orderedConflictWithNewVariant = mergeExternalPluginData(
	orderedConflictBase,
	orderedConflictMerged,
	{ ...orderedConflictBase, series: [orderedConflictVariant('D')] },
);
const orderedConflictMappings = (data: typeof orderedConflictWithNewVariant) =>
	data.series.map((record) => record.slots.map((slot) => [
		slot.version,
		slot.member?.path,
	])).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
assert.deepEqual(
	orderedConflictMappings(orderedConflictWithNewVariant),
	['B', 'C', 'D'].map((name) => orderedConflictVariant(name).slots.map((slot) => [
		slot.version,
		slot.member?.path,
	])).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
	'a genuinely new D mapping is added once without covering B or C',
);
assertions += 1;
const orderedConflictNewReplay = mergeExternalPluginData(
	orderedConflictBase,
	orderedConflictWithNewVariant,
	{ ...orderedConflictBase, series: [orderedConflictVariant('D')] },
);
assert.deepEqual(
	orderedConflictNewReplay,
	orderedConflictWithNewVariant,
	'replaying D after recovery is idempotent and does not grow the family',
);
assertions += 1;

let synchronizedData = synchronizedBase;
let synchronizedPersists = 0;
const synchronizedStore = new SerializedDataStore(
	synchronizedData,
	async (next) => {
		synchronizedPersists += 1;
		synchronizedData = next;
	},
	(next) => {
		synchronizedData = next;
	},
);
const synchronizedRegistry = new VersionRegistry(
	synchronizedVault,
	[],
	async (series) => synchronizedStore.update((current) => ({
		...current,
		series,
	})),
);
await synchronizedRegistry.reload(async () => {
	const next = await synchronizedStore.reconcile(
		synchronizedBase,
		synchronizedIncoming,
		mergeExternalPluginData,
		versionPluginDataEqual,
	);
	return next.series;
});
equal(synchronizedPersists, 0, 'registry reload adopts external data without persistence');
equal(
	synchronizedRegistry.index.getGroupById('synchronized-series')?.status,
	'healthy',
	'an externally synchronized relationship becomes active without restarting the plugin',
);
const staleManagementSnapshot = synchronizedRegistry.getRecordById(
	'synchronized-series',
);
check(staleManagementSnapshot, 'management captures the original synchronized series');
const externallySwappedRecords = [{
	id: 'synchronized-series',
	slots: [
		{ member: synchronizedRecords[0].slots[1].member, version: 1 },
		{ member: synchronizedRecords[0].slots[0].member, version: 2 },
	],
}];
await synchronizedRegistry.reload(async () => externallySwappedRecords);
await assert.rejects(
	() => synchronizedRegistry.saveSeriesSlots(
		'synchronized-series',
		staleManagementSnapshot.slots,
		staleManagementSnapshot,
	),
	/changed while this editor was open/u,
);
assertions += 1;
assert.deepEqual(
	synchronizedRegistry.getRecordById('synchronized-series')?.slots.map(
		(slot) => [slot.version, slot.member?.path],
	),
	[
		[1, 'Synchronized board.canvas'],
		[2, 'Synchronized topic.md'],
	],
	'a stale management save cannot overwrite an externally synchronized slot swap',
);
assertions += 1;
equal(
	synchronizedPersists,
	0,
	'rejecting a stale editor performs no registry persistence or file operation',
);
await assert.rejects(
	() => synchronizedRegistry.dissolveSeries(
		'synchronized-series',
		staleManagementSnapshot,
	),
	/changed while this editor was open/u,
);
assertions += 1;
equal(
	synchronizedRegistry.getRecords().length,
	1,
	'a stale one-version confirmation cannot dissolve an externally changed series',
);
await assert.rejects(
	() => synchronizedRegistry.reload(async () => {
		throw new Error('registry reload failed');
	}),
	/registry reload failed/u,
);
assertions += 1;
equal(
	synchronizedRegistry.index.getGroupById('synchronized-series')?.status,
	'healthy',
	'a failed registry loader preserves the previous index snapshot',
);
await synchronizedRegistry.dissolveSeries('synchronized-series');
equal(
	synchronizedRegistry.getRecords().length,
	0,
	'the registry mutation queue continues after an external loader failure',
);

const overlappingReloadVault = new Vault([
	'Overlapping/S1.md',
	'Overlapping/S2.md',
	'Overlapping/S3.md',
	'Overlapping/T2.md',
]) as unknown as Vault;
const overlappingSeriesS = {
	id: 'overlapping-series-s',
	slots: [
		{ member: memberAt(overlappingReloadVault, 'Overlapping/S1.md'), version: 1 },
		{ member: memberAt(overlappingReloadVault, 'Overlapping/S2.md'), version: 2 },
	],
};
const overlappingSeriesT = {
	id: 'overlapping-series-t',
	slots: [
		{ member: overlappingSeriesS.slots[0].member, version: 1 },
		{ member: memberAt(overlappingReloadVault, 'Overlapping/T2.md'), version: 2 },
	],
};
let overlappingMutationPersists = 0;
const overlappingReloadRegistry = new VersionRegistry(
	overlappingReloadVault,
	[overlappingSeriesS],
	async () => {
		overlappingMutationPersists += 1;
	},
);
const overlappingExpectedS = overlappingReloadRegistry.getRecordById(
	'overlapping-series-s',
);
check(overlappingExpectedS, 'the original S relationship is captured before reload');
const overlappingS2 = overlappingReloadRegistry.index
	.getGroupById('overlapping-series-s')?.versions.find(
		(member) => member.version === 2,
	);
check(overlappingS2, 'the exact S2 member is captured before reload');
const overlappingS2Capture = captureVersionForTrash(overlappingS2);
await overlappingReloadRegistry.reload(async () => [
	overlappingSeriesS,
	overlappingSeriesT,
]);
equal(
	overlappingReloadRegistry.index.getGroupById('overlapping-series-s')?.status,
	'invalid',
	'an externally added T relationship makes S ownership ambiguous',
);
const overlappingNewMember = overlappingReloadVault.getFileByPath(
	'Overlapping/S3.md',
);
check(overlappingNewMember, 'the proposed S3 file exists');
const overlappingBlockedMutations: Array<[string, () => Promise<unknown>]> = [
	[
		'release',
		() => overlappingReloadRegistry.releaseVersionMembers(
			'overlapping-series-s',
			[overlappingS2Capture],
			overlappingExpectedS,
		),
	],
	[
		'dissolve',
		() => overlappingReloadRegistry.dissolveSeries(
			'overlapping-series-s',
			overlappingExpectedS,
		),
	],
	[
		'save',
		() => overlappingReloadRegistry.saveSeriesSlots(
			'overlapping-series-s',
			overlappingExpectedS.slots,
			overlappingExpectedS,
		),
	],
	[
		'add',
		() => overlappingReloadRegistry.addMember(
			'overlapping-series-s',
			3,
			overlappingNewMember,
		),
	],
];
for (const [operationName, operation] of overlappingBlockedMutations) {
	await assert.rejects(
		operation,
		`external overlap must block the stale S ${operationName} operation`,
	);
	assertions += 1;
}
equal(
	overlappingMutationPersists,
	0,
	'no stale S mutation persists after external ownership becomes ambiguous',
);
assert.deepEqual(
	overlappingReloadRegistry.getRecords(),
	[overlappingSeriesS, overlappingSeriesT],
	'blocked S operations preserve both externally synchronized relationships exactly',
);
assertions += 1;

const staleSourceVault = new Vault([
	'Stale source/Old S1.md',
	'Stale source/Old S2.md',
	'Stale source/New S1.md',
	'Stale source/New S2.md',
	'Stale source/T2.md',
]) as unknown as Vault;
const staleSourceSeriesS = {
	id: 'stale-source-series-s',
	slots: [
		{ member: memberAt(staleSourceVault, 'Stale source/Old S1.md'), version: 1 },
		{ member: memberAt(staleSourceVault, 'Stale source/Old S2.md'), version: 2 },
	],
};
const staleSourceSeriesT = {
	id: 'stale-source-series-t',
	slots: [
		{ member: staleSourceSeriesS.slots[0].member, version: 1 },
		{ member: memberAt(staleSourceVault, 'Stale source/T2.md'), version: 2 },
	],
};
let staleSourcePersists = 0;
const staleSourceRegistry = new VersionRegistry(
	staleSourceVault,
	[staleSourceSeriesS],
	async () => {
		staleSourcePersists += 1;
	},
);
const staleSourceExpectedS = staleSourceRegistry.getRecordById(
	'stale-source-series-s',
);
check(staleSourceExpectedS, 'management captures S before the external overlap');
const staleSourceRevision = staleSourceRegistry.getRevision();
const staleSourceFinalSlots = [
	{ member: memberAt(staleSourceVault, 'Stale source/New S1.md'), version: 1 },
	{ member: memberAt(staleSourceVault, 'Stale source/New S2.md'), version: 2 },
];
await staleSourceRegistry.reload(async () => [
	staleSourceSeriesS,
	staleSourceSeriesT,
]);
assert.deepEqual(
	staleSourceRegistry.getRecordById('stale-source-series-s'),
	staleSourceExpectedS,
	'the external reload leaves the captured S record itself byte-for-byte unchanged',
);
assertions += 1;
await assert.rejects(
	() => staleSourceRegistry.saveSeriesSlots(
		'stale-source-series-s',
		staleSourceFinalSlots,
		staleSourceExpectedS,
		staleSourceRevision,
	),
	/registry changed while this editor was open/u,
	'a stale editor cannot evade overlap detection by replacing every old S path',
);
assertions += 1;
equal(
	staleSourcePersists,
	0,
	'a revision rejection occurs before the stale replacement can persist',
);
assert.deepEqual(
	staleSourceRegistry.getRecords(),
	[staleSourceSeriesS, staleSourceSeriesT],
	'the revision rejection preserves S and the externally synchronized overlapping T',
);
assertions += 1;

const queuedReloadVault = new Vault([
	'Queued reload topic.md',
	'Queued reload member.md',
]) as unknown as Vault;
const queuedReloadRecords = [{
	id: 'queued-reload-series',
	slots: [
		{ member: memberAt(queuedReloadVault, 'Queued reload topic.md'), version: 1 },
		{ member: memberAt(queuedReloadVault, 'Queued reload member.md'), version: 2 },
	],
}];
const queuedReloadBase = normalizePluginData({
	filenameTemplate: '{{name}} (V{{version}})',
	language: 'en',
	releasedVersionDestination: 'series-folder',
	schemaVersion: 3,
	series: [],
});
const queuedReloadIncoming = {
	...queuedReloadBase,
	series: queuedReloadRecords,
};
let queuedReloadDisk = queuedReloadIncoming;
let releaseQueuedReloadSave: (() => void) | null = null;
const queuedReloadSaveGate = new Promise<void>((resolve) => {
	releaseQueuedReloadSave = resolve;
});
let queuedReloadPersists = 0;
let queuedReloadData = queuedReloadBase;
const queuedReloadStore = new SerializedDataStore(
	queuedReloadData,
	async (next) => {
		queuedReloadPersists += 1;
		if (queuedReloadPersists === 1) {
			await queuedReloadSaveGate;
		}
		queuedReloadDisk = next;
	},
	(next) => {
		queuedReloadData = next;
	},
);
const queuedReloadRegistry = new VersionRegistry(
	queuedReloadVault,
	[],
	async (series) => queuedReloadStore.update((current) => ({
		...current,
		series,
	})),
);
const queuedLocalSettingsSave = queuedReloadStore.update((current) => ({
	...current,
	language: 'ja',
}));
const queuedExternalReload = queuedReloadRegistry.reload(async () => {
	const next = await queuedReloadStore.reconcile(
		queuedReloadBase,
		queuedReloadIncoming,
		mergeExternalPluginData,
		versionPluginDataEqual,
	);
	return next.series;
});
await Promise.resolve();
equal(
	queuedReloadPersists,
	1,
	'a concurrent stale local settings save reaches persistence before reconciliation',
);
releaseQueuedReloadSave?.();
await Promise.all([queuedLocalSettingsSave, queuedExternalReload]);
equal(
	queuedReloadPersists,
	2,
	'a raced local save is followed by one persisted merged snapshot',
);
equal(queuedReloadDisk.language, 'ja', 'the merged disk snapshot preserves the local setting');
assert.deepEqual(queuedReloadDisk.series, queuedReloadRecords);
assertions += 1;
equal(
	queuedReloadRegistry.index.getGroupById('queued-reload-series')?.status,
	'healthy',
	'the captured external series survives a concurrent stale whole-file settings save',
);

let rejectNextPersist = true;
let failureCommitted = { language: 'en', series: ['before'] };
const failureStore = new SerializedDataStore(
	failureCommitted,
	async () => {
		if (rejectNextPersist) {
			rejectNextPersist = false;
			throw new Error('disk unavailable');
		}
	},
	(next) => {
		failureCommitted = next;
	},
);
await assert.rejects(
	() => failureStore.update((current) => ({ ...current, language: 'ja' })),
	/disk unavailable/u,
);
assertions += 1;
await failureStore.update((current) => ({ ...current, series: ['after'] }));
equal(failureCommitted.language, 'en', 'failed update never becomes committed state');
assert.deepEqual(failureCommitted.series, ['after']);
assertions += 1;

const rollbackVault = new Vault() as unknown as Vault;
const blankCreated = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Blank.md', '') as unknown as TFile;
const blankCapture = captureFile(blankCreated);
const editedCreated = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Edited.md', '') as unknown as TFile;
const editedCapture = captureFile(editedCreated);
(rollbackVault as unknown as InstanceType<typeof Vault>)
	.modify(editedCreated as never, 'user text');
const failedRollbackPaths = await rollbackCreatedBlankFiles(
	rollbackVault,
	async (file) => {
		(rollbackVault as unknown as InstanceType<typeof Vault>).delete(file);
	},
	[blankCapture, editedCapture],
);
equal(
	(rollbackVault as unknown as InstanceType<typeof Vault>).getFileByPath('Blank.md'),
	null,
	'rollback removes the exact newly created blank file',
);
check(
	(rollbackVault as unknown as InstanceType<typeof Vault>).getFileByPath('Edited.md'),
	'rollback preserves a newly created file if it gained user content',
);
assert.deepEqual(failedRollbackPaths, ['Edited.md']);
assertions += 1;

const replacedBlank = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Replaced.md', '') as unknown as TFile;
const replacedCapture = captureFile(replacedBlank);
(rollbackVault as unknown as InstanceType<typeof Vault>).delete(replacedBlank);
const externalReplacement = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Replaced.md', '') as unknown as TFile;
const replacedRollbackPaths = await rollbackCreatedBlankFiles(
	rollbackVault,
	async (file) => {
		(rollbackVault as unknown as InstanceType<typeof Vault>).delete(file);
	},
	[replacedCapture],
);
equal(
	(rollbackVault as unknown as InstanceType<typeof Vault>).getFileByPath('Replaced.md'),
	externalReplacement,
	'rollback preserves a different file that replaced the provisional path',
);
assert.deepEqual(replacedRollbackPaths, ['Replaced.md']);
assertions += 1;

let replacementTrashCalls = 0;
const samePathOriginal = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Same path.md', '') as unknown as TFile;
const samePathCapture = captureFile(samePathOriginal);
(rollbackVault as unknown as InstanceType<typeof Vault>).delete(samePathOriginal);
const samePathReplacement = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Same path.md', 'external content') as unknown as TFile;
const samePathFailures = await rollbackCreatedBlankFiles(
	rollbackVault,
	async (file) => {
		replacementTrashCalls += 1;
		(rollbackVault as unknown as InstanceType<typeof Vault>).delete(file);
	},
	[samePathCapture],
);
equal(replacementTrashCalls, 0, 'same-path external replacement is never sent to trash');
equal(
	(rollbackVault as unknown as InstanceType<typeof Vault>)
		.getFileByPath('Same path.md'),
	samePathReplacement,
	'same-path external replacement remains the live file',
);
assert.deepEqual(samePathFailures, ['Same path.md']);
assertions += 1;

check(
	isUnchangedCapturedFile(samePathOriginal, samePathCapture),
	'destructive selection accepts the exact captured file object',
);
check(
	!isUnchangedCapturedFile(samePathReplacement, samePathCapture),
	'destructive selection rejects a replacement at the captured path',
);
assert.deepEqual(
	orderVersionsForTrash([
		{ file: samePathOriginal, version: 1 },
		{ file: samePathReplacement, version: 3 },
		{ file: editedCreated, version: 2 },
	]).map(({ version }) => version),
	[2, 3, 1],
);
assertions += 1;

const cleanupFirst = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Cleanup first.md', '') as unknown as TFile;
const cleanupSecond = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Cleanup second.md', '') as unknown as TFile;
const cleanupFirstCapture = captureFile(cleanupFirst);
const cleanupSecondCapture = captureFile(cleanupSecond);
const cleanupAttempts: string[] = [];
const partialCleanupFailures = await rollbackCreatedBlankFiles(
	rollbackVault,
	async (file) => {
		cleanupAttempts.push(file.path);
		if (file === cleanupSecond) {
			throw new Error('trash unavailable');
		}
		(rollbackVault as unknown as InstanceType<typeof Vault>).delete(file);
	},
	[cleanupFirstCapture, cleanupSecondCapture],
);
assert.deepEqual(cleanupAttempts, ['Cleanup second.md', 'Cleanup first.md']);
assertions += 1;
assert.deepEqual(partialCleanupFailures, ['Cleanup second.md']);
assertions += 1;
equal(
	(rollbackVault as unknown as InstanceType<typeof Vault>)
		.getFileByPath('Cleanup first.md'),
	null,
	'one cleanup failure does not prevent later rollback attempts',
);
equal(
	(rollbackVault as unknown as InstanceType<typeof Vault>)
		.getFileByPath('Cleanup second.md'),
	cleanupSecond,
	'failed cleanup residue remains visible and reportable',
);

const renamedCreated = await (rollbackVault as unknown as InstanceType<typeof Vault>)
	.create('Provisional.md', '') as unknown as TFile;
const renamedCapture = captureFile(renamedCreated);
(rollbackVault as unknown as InstanceType<typeof Vault>)
	.rename('Provisional.md', 'User renamed.md');
let renamedTrashCalls = 0;
const renamedFailures = await rollbackCreatedBlankFiles(
	rollbackVault,
	async () => {
		renamedTrashCalls += 1;
	},
	[renamedCapture],
);
equal(renamedTrashCalls, 0, 'rollback never follows a provisional file to its new path');
equal(
	(rollbackVault as unknown as InstanceType<typeof Vault>)
		.getFileByPath('User renamed.md'),
	renamedCreated,
	'a user-renamed provisional file remains readable',
);
assert.deepEqual(renamedFailures, ['User renamed.md']);
assertions += 1;

const deleteRaceVault = new Vault([
	'Delete V1.md',
	'Delete V2.md',
]) as unknown as Vault;
const deleteRaceV1 = deleteRaceVault.getFileByPath('Delete V1.md') as TFile;
const deleteRaceV2 = deleteRaceVault.getFileByPath('Delete V2.md') as TFile;
const deleteRaceCaptures = [
	captureVersionForTrash({ file: deleteRaceV1, path: 'Delete V1.md', version: 1 }),
	captureVersionForTrash({ file: deleteRaceV2, path: 'Delete V2.md', version: 2 }),
];
const trashedRacePaths: string[] = [];
const deleteRaceResult = await trashCapturedVersions(
	deleteRaceVault,
	async (file) => {
		trashedRacePaths.push(file.path);
		(deleteRaceVault as unknown as InstanceType<typeof Vault>).delete(file);
		if (file === deleteRaceV2) {
			(deleteRaceVault as unknown as InstanceType<typeof Vault>)
				.rename('Delete V1.md', 'Externally renamed V1.md');
		}
	},
	deleteRaceCaptures,
);
assert.deepEqual(trashedRacePaths, ['Delete V2.md']);
assertions += 1;
equal(deleteRaceResult.deletedCount, 1, 'only the still-approved delete target is trashed');
assert.deepEqual(deleteRaceResult.failedPaths, ['Delete V1.md']);
assertions += 1;
equal(
	(deleteRaceVault as unknown as InstanceType<typeof Vault>)
		.getFileByPath('Externally renamed V1.md'),
	deleteRaceV1,
	'a selected file renamed during another trash await survives',
);

const v1AnchorVault = new Vault([
	'Anchor V1.md',
	'Anchor V2.md',
	'Anchor V3.md',
]) as unknown as Vault;
const anchorV1 = v1AnchorVault.getFileByPath('Anchor V1.md') as TFile;
const anchorV2 = v1AnchorVault.getFileByPath('Anchor V2.md') as TFile;
const anchorV3 = v1AnchorVault.getFileByPath('Anchor V3.md') as TFile;
const anchorTrashCalls: string[] = [];
const anchorResult = await trashCapturedVersions(
	v1AnchorVault,
	async (file) => {
		anchorTrashCalls.push(file.path);
		if (file === anchorV2) {
			throw new Error('trash unavailable');
		}
		(v1AnchorVault as unknown as InstanceType<typeof Vault>).delete(file);
	},
	[
		captureVersionForTrash({ file: anchorV1, version: 1 }),
		captureVersionForTrash({ file: anchorV2, version: 2 }),
		captureVersionForTrash({ file: anchorV3, version: 3 }),
	],
);
assert.deepEqual(anchorTrashCalls, ['Anchor V2.md', 'Anchor V3.md']);
assertions += 1;
equal(
	v1AnchorVault.getFileByPath('Anchor V1.md'),
	anchorV1,
	'V1 remains as the recovery anchor after a companion trash failure',
);
equal(anchorResult.deletedCount, 1, 'successful companions are counted once');
assert.deepEqual(anchorResult.failedPaths, ['Anchor V2.md', 'Anchor V1.md']);
assertions += 1;

const renameRollbackVault = new Vault([
	'Rename original.md',
	'Rename companion.md',
]) as unknown as Vault;
const renameRollbackInitial = [{
	id: 'rename-rollback',
	slots: [
		{ member: memberAt(renameRollbackVault, 'Rename original.md'), version: 1 },
		{ member: memberAt(renameRollbackVault, 'Rename companion.md'), version: 2 },
	],
}];
let rejectRenamePersistence = true;
const renameRollbackRegistry = new VersionRegistry(
	renameRollbackVault,
	renameRollbackInitial,
	async () => {
		if (rejectRenamePersistence) {
			rejectRenamePersistence = false;
			throw new Error('rename persistence failed');
		}
	},
);
const physicallyRenamed = (renameRollbackVault as unknown as InstanceType<typeof Vault>)
	.rename('Rename companion.md', 'Elsewhere/Rename companion.md') as unknown as TFile;
await assert.rejects(
	() => renameRollbackRegistry.updateMemberPath('Rename companion.md', physicallyRenamed),
	/rename persistence failed/u,
);
assertions += 1;
const physicallyRestored = (renameRollbackVault as unknown as InstanceType<typeof Vault>)
	.rename('Elsewhere/Rename companion.md', 'Rename companion.md') as unknown as TFile;
equal(
	await renameRollbackRegistry.updateMemberPath(
		'Elsewhere/Rename companion.md',
		physicallyRestored,
	),
	false,
	'physical rollback needs no second registry mutation when failed persistence kept the old path',
);
equal(
	renameRollbackRegistry.getRecordById('rename-rollback')?.slots[1].member?.path,
	'Rename companion.md',
	'failed rename persistence followed by physical rollback restores registry/file agreement',
);
equal(
	renameRollbackRegistry.index.getGroupById('rename-rollback')?.status,
	'healthy',
	'rolled-back rename is healthy again',
);

let releaseRegistryWrite: (() => void) | null = null;
const registryWriteGate = new Promise<void>((resolve) => {
	releaseRegistryWrite = resolve;
});
let registryWriteCount = 0;
const queuedRegistry = new VersionRegistry(
	renameRollbackVault,
	renameRollbackInitial,
	async () => {
		registryWriteCount += 1;
		if (registryWriteCount === 1) {
			await registryWriteGate;
			throw new Error('first registry write failed');
		}
	},
);
const firstRegistryMutation = queuedRegistry.dissolveSeries('rename-rollback');
const restoredMember = (renameRollbackVault as unknown as InstanceType<typeof Vault>)
	.getFileByPath('Rename companion.md') as unknown as TFile;
const secondRegistryMutation = queuedRegistry.updateMemberPath(
	'Rename companion.md',
	restoredMember,
);
await Promise.resolve();
equal(registryWriteCount, 1, 'registry runs only one persistence mutation at a time');
releaseRegistryWrite?.();
await assert.rejects(() => firstRegistryMutation, /first registry write failed/u);
assertions += 1;
equal(await secondRegistryMutation, true, 'registry queue continues after an earlier persistence failure');
equal(registryWriteCount, 2, 'queued registry mutation persists after prior rejection');

const reverseSnapshots: Array<{ language: string; series: string[] }> = [];
let releaseReverseWrite: (() => void) | null = null;
const reverseGate = new Promise<void>((resolve) => {
	releaseReverseWrite = resolve;
});
let reverseWrites = 0;
let reverseCommitted = { language: 'en', series: ['old'] };
const reverseStore = new SerializedDataStore(
	reverseCommitted,
	async (next) => {
		reverseWrites += 1;
		if (reverseWrites === 1) {
			await reverseGate;
		}
		reverseSnapshots.push({ language: next.language, series: [...next.series] });
	},
	(next) => {
		reverseCommitted = next;
	},
);
const reverseSeries = reverseStore.update((current) => ({
	...current,
	series: ['new'],
}));
let languageUpdaterRuns = 0;
const reverseLanguage = reverseStore.update((current) => {
	languageUpdaterRuns += 1;
	return { ...current, language: 'ja' };
});
await Promise.resolve();
equal(languageUpdaterRuns, 0, 'queued functional updater is not evaluated against stale state');
releaseReverseWrite?.();
await Promise.all([reverseSeries, reverseLanguage]);
equal(reverseSnapshots.length, 2, 'reverse invocation order persists two serialized snapshots');
assert.deepEqual(reverseSnapshots[1], { language: 'ja', series: ['new'] });
assertions += 1;
assert.deepEqual(reverseCommitted, { language: 'ja', series: ['new'] });
assertions += 1;

const closeGuardRegistry = new VersionRegistry(
	new Vault() as unknown as Vault,
	[],
	async () => undefined,
);
const closeGuardModal = new VersionManagementModal(
	{} as never,
	closeGuardRegistry,
	null,
	'{{name}} (V{{version}})',
	'series-folder',
	new VersionI18n('en'),
	() => undefined,
);
const closeGuardState = closeGuardModal as unknown as {
	closeCalls: number;
	submitting: boolean;
};
closeGuardState.submitting = true;
closeGuardModal.close();
equal(closeGuardState.closeCalls, 0, 'Escape/backdrop/Cancel close is ignored during submission');
closeGuardState.submitting = false;
closeGuardModal.close();
equal(closeGuardState.closeCalls, 1, 'modal can close again after submission settles');

const pointerFocusListeners = new Map<string, () => void>();
const pointerFocusClasses = new Set<string>();
const pointerFocusControl = {
	addEventListener: (type: string, listener: () => void) => {
		pointerFocusListeners.set(type, listener);
	},
	classList: {
		add: (className: string) => pointerFocusClasses.add(className),
		remove: (className: string) => pointerFocusClasses.delete(className),
	},
} as unknown as HTMLElement;
trackPointerFocus(pointerFocusControl);
pointerFocusListeners.get('pointerdown')?.();
check(
	pointerFocusClasses.has('is-pointer-focused'),
	'pointer interaction marks the format select so its persistent focus ring can be suppressed',
);
pointerFocusListeners.get('keydown')?.();
check(
	!pointerFocusClasses.has('is-pointer-focused'),
	'keyboard interaction restores the native focus-visible presentation',
);
pointerFocusListeners.get('pointerdown')?.();
pointerFocusListeners.get('blur')?.();
check(
	!pointerFocusClasses.has('is-pointer-focused'),
	'leaving the format select clears its pointer-focus state',
);

console.log(`Version model tests passed: ${assertions} assertions`);
}

void run();
