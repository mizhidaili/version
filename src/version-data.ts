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
	const sourceSchema = Number.isInteger(value.schemaVersion)
		? value.schemaVersion as number
		: 1;
	const preserveDamagedSlots = sourceSchema >= 2;
	const normalizedSeries = Array.isArray(value.series)
		? value.series.flatMap((record) =>
			normalizeSeriesRecord(record, preserveDamagedSlots),
		)
		: [];
	// Schema 1 did not guarantee unique technical IDs, so retain its explicit
	// migration. In current schemas, a duplicate ID is registry damage: leave it
	// intact for VersionIndex to mark both relationships invalid and fail open.
	const series = preserveDamagedSlots
		? normalizedSeries
		: makeSeriesIdsUnique(normalizedSeries);

	return {
		filenameTemplate,
		language,
		releasedVersionDestination,
		schemaVersion: VERSION_DATA_SCHEMA,
		series,
	};
}

/**
 * External reloads must never interpret a transiently missing or truncated
 * data.json as an intentional request to erase every relationship. Field-level
 * damage is still passed to normalizePluginData so it remains visible and
 * repairable under the current-schema fail-open rules.
 */
export function isVersionPluginDataSnapshot(
	value: unknown,
): value is Record<string, unknown> & { series: unknown[] } {
	return isRecord(value) && Array.isArray(value.series);
}

export function normalizeExternalPluginData(
	value: unknown,
): VersionPluginData | null {
	if (!isVersionPluginDataSnapshot(value)) {
		return null;
	}
	if (hasUnsupportedExplicitSchema(value)) {
		return null;
	}
	const normalized = normalizePluginData(value);
	return normalized.series.length === value.series.length
		? normalized
		: null;
}

export function hasUnsupportedExplicitSchema(value: unknown): boolean {
	if (!isRecord(value) || !('schemaVersion' in value)) {
		return false;
	}
	return (
		!Number.isInteger(value.schemaVersion) ||
		(value.schemaVersion as number) < 1 ||
		(value.schemaVersion as number) > VERSION_DATA_SCHEMA
	);
}

export function mergeExternalPluginData(
	base: VersionPluginData,
	current: VersionPluginData,
	incoming: VersionPluginData,
): VersionPluginData {
	return clonePluginData({
		filenameTemplate: current.filenameTemplate === base.filenameTemplate
			? incoming.filenameTemplate
			: current.filenameTemplate,
		language: current.language === base.language
			? incoming.language
			: current.language,
		releasedVersionDestination:
			current.releasedVersionDestination === base.releasedVersionDestination
				? incoming.releasedVersionDestination
				: current.releasedVersionDestination,
		schemaVersion: VERSION_DATA_SCHEMA,
		series: mergeVersionSeriesRecords(
			base.series,
			current.series,
			incoming.series,
		),
	});
}

export function versionPluginDataEqual(
	left: VersionPluginData,
	right: VersionPluginData,
): boolean {
	return (
		left.filenameTemplate === right.filenameTemplate &&
		left.language === right.language &&
		left.releasedVersionDestination === right.releasedVersionDestination &&
		versionSeriesRecordsEqual(left.series, right.series)
	);
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

export function versionSeriesRecordsEqual(
	left: VersionSeriesRecord[],
	right: VersionSeriesRecord[],
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Three-way merge registry records by their stable technical ID. Disjoint
 * device edits are retained. Divergent live records for the same relationship
 * are both retained under separately repairable IDs rather than silently
 * choosing and overwriting one side.
 */
export function mergeVersionSeriesRecords(
	base: VersionSeriesRecord[],
	current: VersionSeriesRecord[],
	incoming: VersionSeriesRecord[],
): VersionSeriesRecord[] {
	const canonicalBase = canonicalizeSyncConflictFamilies(base);
	const canonicalCurrent = canonicalizeSyncConflictFamilies(current);
	const canonicalIncoming = canonicalizeSyncConflictFamilies(incoming);
	const effectiveIncoming = retainUnresolvedSyncConflictFamilies(
		canonicalBase,
		canonicalCurrent,
		canonicalIncoming,
	);
	if (versionSeriesRecordsEqual(canonicalCurrent, canonicalBase)) {
		return cloneSeriesRecords(effectiveIncoming);
	}
	if (versionSeriesRecordsEqual(effectiveIncoming, canonicalBase)) {
		return cloneSeriesRecords(canonicalCurrent);
	}
	if (versionSeriesRecordsEqual(canonicalCurrent, effectiveIncoming)) {
		return cloneSeriesRecords(canonicalCurrent);
	}

	const baseById = uniqueSeriesById(canonicalBase);
	const currentById = uniqueSeriesById(canonicalCurrent);
	const incomingById = uniqueSeriesById(effectiveIncoming);
	if (!baseById || !currentById || !incomingById) {
		throw new Error(
			'Concurrent Version registry changes could not be merged safely.',
		);
	}

	const orderedIdSet = new Set<string>();
	for (const records of [canonicalBase, canonicalCurrent, effectiveIncoming]) {
		for (const record of records) {
			orderedIdSet.add(record.id);
		}
	}
	const orderedIds = [...orderedIdSet].sort(compareStrings);

	const merged: VersionSeriesRecord[] = [];
	const usedIds = new Set(orderedIds);
	const handledRecoveryIds = new Set<string>();
	for (const id of orderedIds) {
		if (handledRecoveryIds.has(id)) {
			continue;
		}
		const baseRecord = baseById.get(id);
		const currentRecord = currentById.get(id);
		const incomingRecord = incomingById.get(id);
		const currentChanged = !optionalSeriesRecordEqual(
			currentRecord,
			baseRecord,
		);
		const incomingChanged = !optionalSeriesRecordEqual(
			incomingRecord,
			baseRecord,
		);
		if (
			currentChanged &&
			incomingChanged &&
			!optionalSeriesRecordEqual(currentRecord, incomingRecord)
		) {
			// A delete-versus-edit conflict keeps the surviving relationship: losing
			// a mapping is less recoverable than retaining ordinary readable files.
			// When both sides still contain divergent records, retain both under a
			// canonical order. The second copy receives a deterministic recovery ID;
			// overlapping paths then make both groups invalid/fail-open in
			// VersionIndex, while disjoint records remain independently repairable.
			if (currentRecord && incomingRecord) {
				const [primary, secondary] = [currentRecord, incomingRecord].sort(
					(left, right) => compareStrings(
						seriesRecordContentKey(left),
						seriesRecordContentKey(right),
					),
				);
				const primaryCopy = cloneSeriesRecords([primary])[0];
				primaryCopy.id = id;
				merged.push(primaryCopy);

				for (const duplicate of findExistingRecoveryRecords(
					id,
					primary,
					canonicalCurrent,
					effectiveIncoming,
				)) {
					handledRecoveryIds.add(duplicate.id);
				}
				const existingRecoveries = findExistingRecoveryRecords(
					id,
					secondary,
					canonicalCurrent,
					effectiveIncoming,
				);
				for (const duplicate of existingRecoveries) {
					handledRecoveryIds.add(duplicate.id);
				}
				const recovered = cloneSeriesRecords([secondary])[0];
				recovered.id = existingRecoveries[0]?.id ??
					createSyncConflictSeriesId(id, secondary, usedIds);
				usedIds.add(recovered.id);
				merged.push(recovered);
				continue;
			}
			const survivingRecord = currentRecord ?? incomingRecord;
			if (survivingRecord) {
				merged.push(cloneSeriesRecords([survivingRecord])[0]);
			}
			continue;
		}
		const chosen = currentChanged
			? currentRecord
			: incomingChanged
				? incomingRecord
				: baseRecord;
		if (chosen) {
			merged.push(cloneSeriesRecords([chosen])[0]);
		}
	}
	return canonicalizeSyncConflictFamilies(merged)
		.sort((left, right) => compareStrings(left.id, right.id));
}

/**
 * Once a same-series conflict has been materialized, an older synchronized
 * snapshot cannot be distinguished from a conflict resolution performed on a
 * different device. Preserve every local recovery-family mapping until this
 * device resolves it explicitly; merge any genuinely new incoming variant as
 * another recovery record. This favors recoverability over remote auto-cleanup.
 */
function retainUnresolvedSyncConflictFamilies(
	base: VersionSeriesRecord[],
	current: VersionSeriesRecord[],
	incoming: VersionSeriesRecord[],
): VersionSeriesRecord[] {
	const protectedRoots = new Set(
		current.flatMap((record) => {
			const root = getSyncConflictRoot(record.id);
			return root ? [root] : [];
		}),
	);
	if (protectedRoots.size === 0) {
		return incoming;
	}

	const output = cloneSeriesRecords(incoming.filter((record) =>
		!protectedRoots.has(getSyncConflictRoot(record.id) ?? record.id)));
	const usedIds = new Set(output.map((record) => record.id));
	for (const root of [...protectedRoots].sort(compareStrings)) {
		const currentFamily = current.filter((record) =>
			(getSyncConflictRoot(record.id) ?? record.id) === root);
		const currentKeys = new Set(currentFamily.map(seriesRecordContentKey));
		const baseKeys = new Set(base.filter((record) =>
			(getSyncConflictRoot(record.id) ?? record.id) === root)
			.map(seriesRecordContentKey));
		const familyRecords = [
			...currentFamily,
			...incoming.filter((record) => {
				if ((getSyncConflictRoot(record.id) ?? record.id) !== root) {
					return false;
				}
				const key = seriesRecordContentKey(record);
				return currentKeys.has(key) || !baseKeys.has(key);
			}),
		];
		output.push(...canonicalizeSyncConflictFamily(root, familyRecords, usedIds));
	}
	return output.sort((left, right) => compareStrings(left.id, right.id));
}

function canonicalizeSyncConflictFamilies(
	records: VersionSeriesRecord[],
): VersionSeriesRecord[] {
	const roots = new Set(records.flatMap((record) => {
		const root = getSyncConflictRoot(record.id);
		return root ? [root] : [];
	}));
	if (roots.size === 0) {
		return records;
	}
	const output = cloneSeriesRecords(records.filter((record) =>
		!roots.has(getSyncConflictRoot(record.id) ?? record.id)));
	const usedIds = new Set(output.map((record) => record.id));
	for (const root of [...roots].sort(compareStrings)) {
		const family = records.filter((record) =>
			(getSyncConflictRoot(record.id) ?? record.id) === root);
		output.push(...canonicalizeSyncConflictFamily(root, family, usedIds));
	}
	return output.sort((left, right) => compareStrings(left.id, right.id));
}

function canonicalizeSyncConflictFamily(
	root: string,
	records: VersionSeriesRecord[],
	usedIds: Set<string>,
): VersionSeriesRecord[] {
	const byContent = new Map<string, VersionSeriesRecord>();
	for (const record of records) {
		byContent.set(seriesRecordContentKey(record), record);
	}
	const variants = [...byContent.entries()].sort(([left], [right]) =>
		compareStrings(left, right));
	return variants.map(([, record], index) => {
		const copy = cloneSeriesRecords([record])[0];
		copy.id = index === 0
			? root
			: createSyncConflictSeriesId(root, record, usedIds);
		usedIds.add(copy.id);
		return copy;
	});
}

function getSyncConflictRoot(id: string): string | null {
	const marker = '--sync-conflict-';
	const markerIndex = id.indexOf(marker);
	return markerIndex > 0 ? id.slice(0, markerIndex) : null;
}

function findExistingRecoveryRecords(
	originalId: string,
	record: VersionSeriesRecord,
	...recordSets: VersionSeriesRecord[][]
): VersionSeriesRecord[] {
	const prefix = `${originalId}--sync-conflict-`;
	const matches = new Map<string, VersionSeriesRecord>();
	for (const records of recordSets) {
		for (const candidate of records) {
			if (
				candidate.id.startsWith(prefix) &&
				seriesRecordContentKey(candidate) === seriesRecordContentKey(record)
			) {
				matches.set(candidate.id, candidate);
			}
		}
	}
	return [...matches.values()].sort((left, right) =>
		compareStrings(left.id, right.id));
}

function seriesRecordContentKey(record: VersionSeriesRecord): string {
	const slots = record.slots.map((slot) => ({
		member: slot.member
			? {
					ctime: slot.member.identity?.ctime ?? null,
					lastKnownName: slot.member.lastKnownName,
					path: slot.member.path,
				}
			: null,
		version: slot.version,
	}));
	slots.sort((left, right) => {
		if (left.version !== right.version) {
			return left.version - right.version;
		}
		return compareStrings(JSON.stringify(left), JSON.stringify(right));
	});
	return JSON.stringify(slots);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function createSyncConflictSeriesId(
	originalId: string,
	record: VersionSeriesRecord,
	usedIds: ReadonlySet<string>,
): string {
	const fingerprint = stableStringHash(seriesRecordContentKey(record)).toString(36);
	const base = `${originalId}--sync-conflict-${fingerprint}`;
	let candidate = base;
	let attempt = 2;
	while (usedIds.has(candidate)) {
		candidate = `${base}-${attempt}`;
		attempt += 1;
	}
	return candidate;
}

function stableStringHash(value: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function uniqueSeriesById(
	records: VersionSeriesRecord[],
): Map<string, VersionSeriesRecord> | null {
	const byId = new Map<string, VersionSeriesRecord>();
	for (const record of records) {
		if (byId.has(record.id)) {
			return null;
		}
		byId.set(record.id, record);
	}
	return byId;
}

function optionalSeriesRecordEqual(
	left: VersionSeriesRecord | undefined,
	right: VersionSeriesRecord | undefined,
): boolean {
	if (!left || !right) {
		return left === right;
	}
	return (
		left.id === right.id &&
		seriesRecordContentKey(left) === seriesRecordContentKey(right)
	);
}

function normalizeSeriesRecord(
	value: unknown,
	preserveDamagedSlots: boolean,
): VersionSeriesRecord[] {
	if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
		return [];
	}

	if (!Array.isArray(value.slots)) {
		return [];
	}

	// Schema 1 used an explicit null member to mean a numeric gap, so those nulls
	// are migrated away. Schema 2+ represents a gap by absence; a present but
	// malformed/null member is therefore registry damage and must survive as an
	// unresolved sentinel so the whole relationship remains fail-open.
	const slots = value.slots
		.flatMap((slot, index) =>
			normalizeSlotRecord(slot, preserveDamagedSlots, index),
		)
		.filter((slot) => preserveDamagedSlots || slot.member !== null);
	if (
		slots.length < 2 &&
		(!preserveDamagedSlots || !slots.some((slot) => slot.member !== null))
	) {
		return [];
	}

	return [{ id: value.id, slots }];
}

function normalizeSlotRecord(
	value: unknown,
	preserveDamagedSlots: boolean,
	index: number,
): VersionSlotRecord[] {
	if (!isRecord(value) || !Number.isInteger(value.version)) {
		return preserveDamagedSlots
			? [{ member: null, version: -1 - index }]
			: [];
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
	const storedCtime = member.identity?.ctime;
	const liveCtime = file.stat.ctime;
	return Boolean(
		typeof storedCtime === 'number' &&
		Number.isFinite(storedCtime) &&
		Number.isFinite(liveCtime) &&
		storedCtime > 0 &&
		liveCtime > 0 &&
		storedCtime === liveCtime,
	);
}

/**
 * Resolve a registry member for non-destructive display and navigation when a
 * filesystem/sync path exposes the same creation timestamp at different
 * precisions. Identity-rewriting and destructive operations must continue to
 * use memberMatchesFile so a coarse comparison can never authorize a rename,
 * move, replacement, or trash. Dedicated cross-device append and management
 * operations may use this resolver only while separately proving that every
 * old slot and live TFile is unchanged and preserving those old identities
 * byte-for-byte.
 */
export function memberResolvesToFile(
	member: VersionMemberRecord,
	file: { stat: { ctime: number } },
): boolean {
	if (memberMatchesFile(member, file)) {
		return true;
	}

	const storedCtime = member.identity?.ctime;
	const liveCtime = file.stat.ctime;
	if (
		typeof storedCtime !== 'number' ||
		!Number.isFinite(storedCtime) ||
		!Number.isFinite(liveCtime) ||
		storedCtime <= 0 ||
		liveCtime <= 0
	) {
		return false;
	}

	// Limit compatibility to the detectable whole-second versus millisecond
	// precision mismatch observed in an iCloud-backed test vault. This is the
	// narrowest distinction the existing path + ctime record can express after
	// one side loses sub-second precision; two millisecond-precision values remain
	// strict.
	return (
		(storedCtime % 1_000 === 0 || liveCtime % 1_000 === 0) &&
		Math.floor(storedCtime / 1_000) === Math.floor(liveCtime / 1_000)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
