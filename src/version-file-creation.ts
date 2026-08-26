import { App, normalizePath, TFile } from 'obsidian';
import { captureFile } from './captured-file';
import { rollbackCreatedFilesIfUnchanged } from './created-file-rollback';

export type VersionFileFormat = 'markdown' | 'canvas' | 'excalidraw';

export const VERSION_FILE_SUFFIXES: Readonly<Record<VersionFileFormat, string>> = {
	markdown: '.md',
	canvas: '.canvas',
	excalidraw: '.excalidraw.md',
};

export enum VersionFileCreationErrorCode {
	InvalidStem = 'invalid-stem',
	UnsupportedFormat = 'unsupported-format',
	ExcalidrawPluginUnavailable = 'excalidraw-plugin-unavailable',
	ExcalidrawApiUnavailable = 'excalidraw-api-unavailable',
	ExcalidrawContentPreparationFailed = 'excalidraw-content-preparation-failed',
	InvalidExcalidrawContent = 'invalid-excalidraw-content',
	PathConflict = 'path-conflict',
	CreateFailed = 'create-failed',
}

interface VersionFileCreationErrorOptions {
	path?: string;
	originalCause?: unknown;
	rollbackFailures?: string[];
}

/** A user-presentable failure that is safe for callers to branch on. */
export class VersionFileCreationError extends Error {
	readonly code: VersionFileCreationErrorCode;
	readonly path?: string;
	readonly originalCause?: unknown;
	readonly rollbackFailures: string[];

	constructor(
		code: VersionFileCreationErrorCode,
		message: string,
		options: VersionFileCreationErrorOptions = {},
	) {
		super(message);
		this.name = 'VersionFileCreationError';
		this.code = code;
		this.path = options.path;
		this.originalCause = options.originalCause;
		this.rollbackFailures = [...(options.rollbackFailures ?? [])];
	}
}

export interface VersionFileCreationOptions {
	folderPath: string;
	stem: string;
	format: VersionFileFormat;
}

export interface PreparedVersionFile {
	format: VersionFileFormat;
	path: string;
	content: string;
}

interface FileLike {
	name: string;
	extension?: string;
}

interface ExcalidrawPluginApi {
	createDrawing(
		filename: string,
		folderPath: string,
		content: string,
	): Promise<TFile>;
	getBlankDrawing(): Promise<string> | string;
}

interface InternalPluginRegistry {
	enabledPlugins?: {
		has(pluginId: string): boolean;
	};
	plugins?: Record<string, unknown>;
}

const EXCALIDRAW_PLUGIN_ID = 'obsidian-excalidraw-plugin';
const LEGACY_EXCALIDRAW_SUFFIX = '.excalidraw';
const INVALID_STEM_CHARACTERS = /[\\/\0]/u;

export function isVersionFileFormat(value: unknown): value is VersionFileFormat {
	return value === 'markdown' || value === 'canvas' || value === 'excalidraw';
}

/**
 * Detects the note format from a filename/path or a TFile-like object.
 * `.excalidraw.md` is checked before the generic Markdown suffix.
 */
export function detectVersionFileFormat(
	fileOrName: string | FileLike,
): VersionFileFormat | null {
	const name = typeof fileOrName === 'string'
		? fileOrName
		: fileOrName.name;
	const lowerName = name.toLocaleLowerCase();

	if (
		lowerName.endsWith(VERSION_FILE_SUFFIXES.excalidraw) ||
		lowerName.endsWith(LEGACY_EXCALIDRAW_SUFFIX)
	) {
		return 'excalidraw';
	}
	if (lowerName.endsWith(VERSION_FILE_SUFFIXES.canvas)) {
		return 'canvas';
	}
	if (lowerName.endsWith(VERSION_FILE_SUFFIXES.markdown)) {
		return 'markdown';
	}

	return null;
}

export function getVersionFileSuffix(format: VersionFileFormat): string {
	assertSupportedFormat(format);
	return VERSION_FILE_SUFFIXES[format];
}

/** Removes a recognized Version file suffix without changing the parent path. */
export function stripVersionFileSuffix(nameOrPath: string): string {
	const format = detectVersionFileFormat(nameOrPath);
	if (format === null) {
		return nameOrPath;
	}

	const lowerName = nameOrPath.toLocaleLowerCase();
	const suffix = format === 'excalidraw' && lowerName.endsWith(LEGACY_EXCALIDRAW_SUFFIX)
		? LEGACY_EXCALIDRAW_SUFFIX
		: VERSION_FILE_SUFFIXES[format];
	return nameOrPath.slice(0, -suffix.length);
}

/** Builds a canonical filename; existing supported suffixes are not duplicated. */
export function buildVersionFileName(
	stem: string,
	format: VersionFileFormat,
): string {
	assertSupportedFormat(format);
	const normalizedStem = normalizeStem(stem);
	return `${normalizedStem}${VERSION_FILE_SUFFIXES[format]}`;
}

/** Builds a vault-relative path, with a separate folder and filename stem. */
export function buildVersionFilePath(
	folderPath: string,
	stem: string,
	format: VersionFileFormat,
): string {
	const filename = buildVersionFileName(stem, format);
	const normalizedFolder = normalizeFolderPath(folderPath);
	return normalizePath(normalizedFolder ? `${normalizedFolder}/${filename}` : filename);
}

/** A minimal valid Obsidian Canvas document. */
export function getBlankCanvasContent(): string {
	return `${JSON.stringify({ nodes: [], edges: [] }, null, 2)}\n`;
}

/**
 * Performs a conservative validation of the Markdown document returned by
 * Excalidraw. The plugin marker and a non-empty drawing payload are both
 * required so a malformed ordinary Markdown file is never created silently.
 */
export function isValidExcalidrawMarkdown(content: unknown): content is string {
	if (typeof content !== 'string' || content.trim().length === 0) {
		return false;
	}

	const frontmatter = content.match(
		/^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?:[\t ]*\r?\n|$)/u,
	);
	if (
		frontmatter === null ||
		!/^excalidraw-plugin[\t ]*:[\t ]*\S+/mu.test(frontmatter[1] ?? '')
	) {
		return false;
	}

	const drawingHeading = /^#{1,6}[\t ]+Drawing[\t ]*$/mu.exec(content);
	if (drawingHeading === null || drawingHeading.index === undefined) {
		return false;
	}

	const drawingSection = content.slice(drawingHeading.index + drawingHeading[0].length);
	const payload = /```(?:compressed-json|json)[\t ]*\r?\n([\s\S]*?)\r?\n```/u.exec(
		drawingSection,
	);
	return payload !== null && (payload[1] ?? '').trim().length > 0;
}

/** Validates the legacy JSON format used by Excalidraw compatibility mode. */
export function isValidLegacyExcalidrawJson(content: unknown): content is string {
	if (typeof content !== 'string' || content.trim().length === 0) {
		return false;
	}
	try {
		const parsed = JSON.parse(content) as unknown;
		return typeof parsed === 'object' &&
			parsed !== null &&
			'type' in parsed &&
			parsed.type === 'excalidraw' &&
			'elements' in parsed &&
			Array.isArray(parsed.elements) &&
			'appState' in parsed &&
			typeof parsed.appState === 'object' &&
			parsed.appState !== null;
	} catch {
		return false;
	}
}

export async function prepareVersionFileContent(
	app: App,
	format: VersionFileFormat,
): Promise<string> {
	assertSupportedFormat(format);

	switch (format) {
		case 'markdown':
			return '';
		case 'canvas':
			return getBlankCanvasContent();
		case 'excalidraw':
			return prepareExcalidrawContent(app);
	}
}

/** Prepares and validates all data before any vault write occurs. */
export async function prepareVersionFile(
	app: App,
	options: VersionFileCreationOptions,
): Promise<PreparedVersionFile> {
	let path: string;
	let content: string;
	if (options.format === 'excalidraw') {
		// Excalidraw's supported compatibility mode returns legacy JSON. Follow
		// the API's actual blank format instead of writing legacy JSON into a
		// misleading Markdown file.
		content = await prepareVersionFileContent(app, options.format);
		path = isValidLegacyExcalidrawJson(content)
			? buildVersionFilePathWithSuffix(
				options.folderPath,
				options.stem,
				LEGACY_EXCALIDRAW_SUFFIX,
			)
			: buildVersionFilePath(
				options.folderPath,
				options.stem,
				options.format,
			);
	} else {
		path = buildVersionFilePath(
			options.folderPath,
			options.stem,
			options.format,
		);
		// Fail before doing any asynchronous preparation for ordinary formats.
		assertPathAvailable(app, path);
		content = await prepareVersionFileContent(app, options.format);
	}
	// Excalidraw preparation is asynchronous and can also determine the suffix.
	// Every format is rechecked immediately before the later vault write.
	assertPathAvailable(app, path);
	return {
		format: options.format,
		path,
		content,
	};
}

/**
 * Creates a fully prepared Version member. Excalidraw template acquisition and
 * validation happen before its public `createDrawing` API is invoked,
 * preventing malformed placeholder files when the dependency is disabled or
 * its API changes.
 */
export async function createVersionFile(
	app: App,
	options: VersionFileCreationOptions,
): Promise<TFile> {
	const prepared = await prepareVersionFile(app, options);
	return createPreparedVersionFile(app, prepared);
}

/**
 * Writes content already prepared by the shared creation service. Management
 * can prepare every pending file before the first vault write, then use this
 * function for each exact path while retaining the initial content for a safe
 * compensating rollback.
 */
export async function createPreparedVersionFile(
	app: App,
	prepared: PreparedVersionFile,
): Promise<TFile> {
	assertSupportedFormat(prepared.format);
	assertPathAvailable(app, prepared.path);
	if (prepared.format === 'excalidraw') {
		return createPreparedExcalidrawFile(app, prepared);
	}

	try {
		return await app.vault.create(prepared.path, prepared.content);
	} catch (error) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.CreateFailed,
			`Could not create the ${prepared.format} version file at "${prepared.path}".`,
			{ path: prepared.path, originalCause: error },
		);
	}
}

async function createPreparedExcalidrawFile(
	app: App,
	prepared: PreparedVersionFile,
): Promise<TFile> {
	const plugin = getEnabledExcalidrawPlugin(app);
	const separator = prepared.path.lastIndexOf('/');
	const filename = separator >= 0
		? prepared.path.slice(separator + 1)
		: prepared.path;
	// Excalidraw falls back to its configured default folder for a falsey folder
	// argument. A truthy root marker keeps root-level Version members at root.
	const folderPath = separator >= 0
		? prepared.path.slice(0, separator)
		: '/';

	let file: TFile;
	try {
		file = await plugin.createDrawing(
			filename,
			folderPath || '/',
			prepared.content,
		);
	} catch (error) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.CreateFailed,
			`Could not create the Excalidraw version file at "${prepared.path}".`,
			{ path: prepared.path, originalCause: error },
		);
	}
	if (!(file instanceof TFile)) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.ExcalidrawApiUnavailable,
			'Excalidraw createDrawing() did not return a vault file; no version relationship was registered.',
			{ path: prepared.path },
		);
	}

	if (file.path === prepared.path) {
		return file;
	}

	// Excalidraw deliberately uniquifies a destination that appeared after our
	// preflight. Never register that surprise path. Remove it only while the
	// exact returned TFile and byte-for-byte prepared content are unchanged.
	const rollbackFailures = await rollbackCreatedFilesIfUnchanged(
		app.vault,
		(createdFile) => app.fileManager.trashFile(createdFile),
		[{
			capture: captureFile(file),
			expectedContent: prepared.content,
		}],
	);
	const cleanupDetail = rollbackFailures.length > 0
		? ` The unexpected file at "${file.path}" was preserved because it could not be safely removed.`
		: '';
	throw new VersionFileCreationError(
		VersionFileCreationErrorCode.PathConflict,
		`The requested path "${prepared.path}" became unavailable during creation.${cleanupDetail}`,
		{ path: prepared.path, rollbackFailures },
	);
}

function normalizeStem(stem: string): string {
	const trimmedStem = stripVersionFileSuffix(stem.trim());
	if (
		trimmedStem.length === 0 ||
		trimmedStem === '.' ||
		trimmedStem === '..' ||
		INVALID_STEM_CHARACTERS.test(trimmedStem)
	) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.InvalidStem,
			`"${stem}" is not a valid version filename stem.`,
		);
	}
	return trimmedStem;
}

function normalizeFolderPath(folderPath: string): string {
	// Folder names may legally begin or end with spaces. Never trim a real
	// registry/TFile parent path; remove only root separators.
	const relativeFolder = folderPath.replace(/^\/+|\/+$/gu, '');
	return relativeFolder.length > 0 ? normalizePath(relativeFolder) : '';
}

function buildVersionFilePathWithSuffix(
	folderPath: string,
	stem: string,
	suffix: string,
): string {
	const filename = `${normalizeStem(stem)}${suffix}`;
	const normalizedFolder = normalizeFolderPath(folderPath);
	return normalizePath(normalizedFolder ? `${normalizedFolder}/${filename}` : filename);
}

function assertSupportedFormat(format: unknown): asserts format is VersionFileFormat {
	if (!isVersionFileFormat(format)) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.UnsupportedFormat,
			`"${String(format)}" is not a supported version file format.`,
		);
	}
}

function assertPathAvailable(app: App, path: string): void {
	if (app.vault.getAbstractFileByPath(path) !== null) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.PathConflict,
			`A vault item already exists at "${path}".`,
			{ path },
		);
	}
}

async function prepareExcalidrawContent(app: App): Promise<string> {
	const plugin = getEnabledExcalidrawPlugin(app);
	let content: unknown;
	try {
		content = await plugin.getBlankDrawing();
	} catch (error) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.ExcalidrawContentPreparationFailed,
			'Excalidraw could not prepare a blank drawing.',
			{ originalCause: error },
		);
	}

	if (
		!isValidExcalidrawMarkdown(content) &&
		!isValidLegacyExcalidrawJson(content)
	) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.InvalidExcalidrawContent,
			'Excalidraw returned an invalid blank drawing; no file was created.',
		);
	}
	return content;
}

function getEnabledExcalidrawPlugin(app: App): ExcalidrawPluginApi {
	const registry = getInternalPluginRegistry(app);
	if (!registry.enabledPlugins?.has(EXCALIDRAW_PLUGIN_ID)) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.ExcalidrawPluginUnavailable,
			'Enable the Excalidraw community plugin before creating an Excalidraw version.',
		);
	}

	const plugin = registry.plugins?.[EXCALIDRAW_PLUGIN_ID];
	if (!isExcalidrawPluginApi(plugin)) {
		throw new VersionFileCreationError(
			VersionFileCreationErrorCode.ExcalidrawApiUnavailable,
			'The enabled Excalidraw plugin does not expose getBlankDrawing() and createDrawing(); no file was created.',
		);
	}
	return plugin;
}

/** Keep the single private Obsidian registry cast isolated in this adapter. */
function getInternalPluginRegistry(app: App): InternalPluginRegistry {
	return (app as App & { plugins?: InternalPluginRegistry }).plugins ?? {};
}

function isExcalidrawPluginApi(value: unknown): value is ExcalidrawPluginApi {
	return typeof value === 'object' &&
		value !== null &&
		'createDrawing' in value &&
		typeof value.createDrawing === 'function' &&
		'getBlankDrawing' in value &&
		typeof value.getBlankDrawing === 'function';
}
