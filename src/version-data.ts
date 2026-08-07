import { isVersionLanguage, type VersionLanguage } from './i18n';

export const VERSION_DATA_SCHEMA = 3;

export type ReleasedVersionDestination = 'series-folder' | 'vault-root';

export interface VersionMemberRecord {
	identity?: {
		ctime: number;
	};
	lastKnownName: string;
	path: string;
}

export interface VersionSlotRecord {
	member: VersionMemberRecord | null;
	version: number;
}

export interface VersionSeriesRecord {
	id: string;
	slots: VersionSlotRecord[];
}

export interface VersionPluginData {
	filenameTemplate: string;
	language: VersionLanguage;
	releasedVersionDestination: ReleasedVersionDestination;
	schemaVersion: number;
	series: VersionSeriesRecord[];
}

export const DEFAULT_FILENAME_TEMPLATE = '{{name}} (V{{version}})';

export const DEFAULT_PLUGIN_DATA: VersionPluginData = {
	filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
	language: 'en',
	releasedVersionDestination: 'series-folder',
	schemaVersion: VERSION_DATA_SCHEMA,
	series: [],
};

export function normalizePluginData(value: unknown): VersionPluginData {
	if (!isRecord(value)) {
		return clonePluginData(DEFAULT_PLUGIN_DATA);
	}

	const language = isVersionLanguage(value.language) ? value.language : 'en';
	const filenameTemplate =
		typeof value.filenameTemplate === 'string' &&
		isValidFilenameTemplate(value.filenameTemplate)
			? value.filenameTemplate
			: DEFAULT_FILENAME_TEMPLATE;
	const releasedVersionDestination = value.releasedVersionDestination === 'vault-root'
		? 'vault-root'
		: 'series-folder';
	const normalizedSeries = Array.isArray(value.series)
		? value.series.flatMap(normalizeSeriesRecord)
		: [];
	const series = makeSeriesIdsUnique(normalizedSeries);

	return {
		filenameTemplate,
		language,
		releasedVersionDestination,
		schemaVersion: VERSION_DATA_SCHEMA,
		series,
	};
}

export function isValidFilenameTemplate(value: string): boolean {
	return (
		Boolean(value.trim()) &&
		value.includes('{{version}}') &&
		!/[/\\\n\r]/u.test(value)
	);
}

function makeSeriesIdsUnique(
	series: VersionSeriesRecord[],
): VersionSeriesRecord[] {
	const used = new Set<string>();
	return series.map((record, index) => {
		let id = record.id;
		let attempt = 1;
		while (used.has(id)) {
			id = `${record.id}--recovered-${index + 1}-${attempt}`;
			attempt += 1;
		}
		used.add(id);
		return {
			id,
			slots: record.slots,
		};
	});
}

export function cloneSeriesRecords(
	series: VersionSeriesRecord[],
): VersionSeriesRecord[] {
	return series.map((record) => ({
		id: record.id,
		slots: record.slots.map((slot) => ({
		member: slot.member
				? {
						identity: slot.member.identity
							? { ...slot.member.identity }
							: undefined,
						lastKnownName: slot.member.lastKnownName,
						path: slot.member.path,
					}
				: null,
			version: slot.version,
		})),
	}));
}

function clonePluginData(data: VersionPluginData): VersionPluginData {
	return {
		...data,
		series: cloneSeriesRecords(data.series),
	};
}

function normalizeSeriesRecord(value: unknown): VersionSeriesRecord[] {
	if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
		return [];
	}

	if (!Array.isArray(value.slots)) {
		return [];
	}

	// Schema 1 used an explicit null member to mean a numeric gap. Schema 2
	// represents a gap by the absence of that version number. This also keeps
	// "a Version exists but has no note" as a draft-only, unsavable state.
	const slots = value.slots
		.flatMap(normalizeSlotRecord)
		.filter((slot) => slot.member !== null);
	if (slots.length < 2) {
		return [];
	}

	return [{ id: value.id, slots }];
}

function normalizeSlotRecord(value: unknown): VersionSlotRecord[] {
	if (!isRecord(value) || !Number.isInteger(value.version)) {
		return [];
	}

	const member = normalizeMemberRecord(value.member);
	return [{ member, version: value.version as number }];
}

function normalizeMemberRecord(value: unknown): VersionMemberRecord | null {
	if (!isRecord(value)) {
		return null;
	}

	if (
		typeof value.path !== 'string' ||
		!value.path ||
		typeof value.lastKnownName !== 'string'
	) {
		return null;
	}

	const identity = isRecord(value.identity) &&
		typeof value.identity.ctime === 'number' &&
		Number.isFinite(value.identity.ctime) &&
		value.identity.ctime >= 0
		? { ctime: value.identity.ctime }
		: undefined;

	return {
		identity,
		lastKnownName: value.lastKnownName,
		path: value.path,
	};
}

export function memberRecordFromFile(file: {
	basename: string;
	path: string;
	stat: { ctime: number };
}): VersionMemberRecord {
	return {
		identity: { ctime: file.stat.ctime },
		lastKnownName: file.basename,
		path: file.path,
	};
}

export function memberMatchesFile(
	member: VersionMemberRecord,
	file: { stat: { ctime: number } },
): boolean {
	return Boolean(
		member.identity &&
		Number.isFinite(member.identity.ctime) &&
		member.identity.ctime === file.stat.ctime,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
