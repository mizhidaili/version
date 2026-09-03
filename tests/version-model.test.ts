import assert from 'node:assert/strict';
import { FileView, Modal, TFile, Vault } from 'obsidian';
import { findRecoveryPath } from '../src/import-recovered-markdown';
import {
	isValidFilenameTemplate,
	memberRecordFromFile,
	normalizePluginData,
	VersionMemberRecord,
} from '../src/version-data';
import {
	getMissingVersions,
	getNextVersion,
	VersionIndex,
} from '../src/version-index';
import { VersionRegistry } from '../src/version-registry';
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

const explorerDecorator = new FileExplorerDecorator(
	{ workspace: { getActiveFile: () => null } } as never,
	visibilityIndex,
	new VersionI18n('en'),
);
const explorerHarness = explorerDecorator as unknown as {
	decorateGroup(group: typeof visibilityGroup, titles: Map<string, unknown>): void;
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
