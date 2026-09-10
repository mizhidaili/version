import { normalizePath, TFile, Vault } from 'obsidian';
import { captureFile, isCapturedFile } from './captured-file';
import {
	cloneSeriesRecords,
	memberMatchesFile,
	memberRecordFromFile,
	memberResolvesToFile,
	VersionMemberRecord,
	VersionSeriesRecord,
	VersionSlotRecord,
	versionSeriesRecordsEqual,
} from './version-data';
import { isVersionableFile } from './version-file-types';
import {
	isVersionGroupExactlyResolved,
	MAX_VERSION,
	VersionGroup,
	VersionIndex,
} from './version-index';

type PersistSeries = (series: VersionSeriesRecord[]) => Promise<void>;

export interface VersionMemberRelease {
	ctime: number;
	file: TFile;
	mtime: number;
	path: string;
	size: number;
	version: number;
}

export interface ReleaseVersionMembersResult {
	dissolved: boolean;
	releasedVersions: number[];
}

/**
 * One-shot compare-and-swap guard for adding a new member without rewriting
 * any existing member identity. The live file references are intentionally
 * process-local: they let the commit reject a same-path replacement that
 * happened after the creation dialog was opened, including when both files
 * expose the same whole-second ctime.
 */
interface ResolvedSeriesExpectation {
	readonly members: ReadonlyArray<{
		readonly ctime: number;
		readonly file: TFile;
		readonly path: string;
		readonly version: number;
	}>;
	readonly revision: number;
	readonly series: VersionSeriesRecord;
	readonly seriesId: string;
}

export interface VersionAppendExpectation extends ResolvedSeriesExpectation {
	readonly purpose: 'append';
}

/**
 * Process-local authorization for editing the slot mapping of one fully
 * resolved relationship. Unlike the general repair path, this expectation may
 * accept the narrow cross-device ctime precision mismatch. Every pre-existing
 * member record must still be preserved byte-for-byte and remain attached to
 * the exact TFile object captured here.
 */
export interface VersionManagementExpectation extends ResolvedSeriesExpectation {
	readonly purpose: 'management';
}

export interface VersionManagementSlotAssignment {
	readonly file: TFile;
	readonly member: VersionMemberRecord;
	readonly version: number;
}

export class VersionRegistry {
	readonly index: VersionIndex;
	private readonly appendExpectations = new WeakSet<VersionAppendExpectation>();
	private readonly managementExpectations =
		new WeakSet<VersionManagementExpectation>();
	private mutationQueue: Promise<void> = Promise.resolve();
	private records: VersionSeriesRecord[];
	private revision = 0;

	constructor(
		private readonly vault: Vault,
		initialRecords: VersionSeriesRecord[],
		private readonly persistSeries: PersistSeries,
	) {
		this.records = cloneSeriesRecords(initialRecords);
		this.index = new VersionIndex(this.vault);
		this.index.rebuild(this.records);
	}

	getRecords(): VersionSeriesRecord[] {
		return cloneSeriesRecords(this.records);
	}

	getRecordById(seriesId: string): VersionSeriesRecord | null {
		const matches = this.records.filter((record) => record.id === seriesId);
		return matches.length === 1
			? cloneSeriesRecords(matches)[0]
			: null;
	}

	/**
	 * Monotonic in-memory generation for compare-and-swap across workflows that
	 * move real files before their final registry commit. Rebuild-only Vault UI
	 * events do not advance it; successful local commits and external reloads do.
	 */
	getRevision(): number {
		return this.revision;
	}

	/**
	 * Capture the exact registry generation and the currently resolved TFile
	 * objects for a later append-only commit. Both exact and narrowly
	 * precision-compatible healthy groups are eligible; incomplete or ambiguous
	 * relationships return null and remain fail-open.
	 */
	captureAppendExpectation(seriesId: string): VersionAppendExpectation | null {
		const expectation = this.captureResolvedSeriesExpectation(
			seriesId,
			'append',
		);
		if (expectation) {
			this.appendExpectations.add(expectation);
		}
		return expectation;
	}

	/**
	 * Capture a fresh, read-only view of every live member before opening Version
	 * management. Rebuilding here prevents a cached exact group from being mixed
	 * with newer iCloud TFile metadata inside the modal.
	 */
	captureManagementExpectation(
		seriesId: string,
	): VersionManagementExpectation | null {
		const expectation = this.captureResolvedSeriesExpectation(
			seriesId,
			'management',
		);
		if (expectation) {
			this.managementExpectations.add(expectation);
		}
		return expectation;
	}

	private captureResolvedSeriesExpectation(
		seriesId: string,
		purpose: 'append',
	): VersionAppendExpectation | null;
	private captureResolvedSeriesExpectation(
		seriesId: string,
		purpose: 'management',
	): VersionManagementExpectation | null;
	private captureResolvedSeriesExpectation(
		seriesId: string,
		purpose: 'append' | 'management',
	): VersionAppendExpectation | VersionManagementExpectation | null {
		// Vault events normally keep the index current, but rebuilding here makes
		// this authorization independent of event delivery timing.
		this.index.rebuild(this.records);
		const group = this.index.getGroupById(seriesId);
		const series = this.getRecordById(seriesId);
		if (!group || group.status !== 'healthy' || !series) {
			return null;
		}

		const members: Array<VersionAppendExpectation['members'][number]> = [];
		for (const slot of series.slots) {
			if (!slot.member) {
				return null;
			}
			const file = this.vault.getFileByPath(slot.member.path);
			const indexed = group.versions.find((candidate) =>
				candidate.version === slot.version &&
				candidate.path === slot.member?.path &&
				candidate.file === file);
			if (
				!file ||
				!isVersionableFile(file) ||
				!memberResolvesToFile(slot.member, file) ||
				!indexed
			) {
				return null;
			}
			members.push({
				ctime: file.stat.ctime,
				file,
				path: file.path,
				version: slot.version,
			});
		}
		if (members.length !== group.versions.length) {
			return null;
		}

		const expectation = {
			members,
			purpose,
			revision: this.revision,
			series,
			seriesId,
		} as VersionAppendExpectation | VersionManagementExpectation;
		return expectation;
	}

	rebuild(): void {
		this.index.rebuild(this.records);
	}

	/**
	 * Resolve one relationship for an operation that may mutate a real file.
	 * TFile metadata can change in place without a Vault event, so never trust a
	 * previously computed exact identityStatus: rebuild and compare every raw
	 * registry member with its current live TFile before returning authorization.
	 */
	resolveExactlyMatchedGroup(seriesId: string): VersionGroup | null {
		this.index.rebuild(this.records);
		const group = this.index.getGroupById(seriesId);
		const series = this.getRecordById(seriesId);
		if (!group || !series || !isVersionGroupExactlyResolved(group)) {
			return null;
		}
		if (series.slots.length !== group.versions.length) {
			return null;
		}

		for (const slot of series.slots) {
			if (!slot.member) {
				return null;
			}
			const file = this.vault.getFileByPath(slot.member.path);
			const indexed = group.versions.find((candidate) =>
				candidate.version === slot.version &&
				candidate.path === slot.member?.path &&
				candidate.file === file);
			if (
				!file ||
				!isVersionableFile(file) ||
				!memberMatchesFile(slot.member, file) ||
				!indexed
			) {
				return null;
			}
		}
		return group;
	}

	/**
	 * Replace the in-memory snapshot after plugin data changes externally.
	 * Loading happens inside the registry mutation queue so a synchronized
	 * snapshot cannot be applied in the middle of a local relationship save.
	 * External data is deliberately not persisted again here.
	 */
	reload(load: () => Promise<VersionSeriesRecord[]>): Promise<void> {
		return this.enqueue(async () => {
			const next = cloneSeriesRecords(await load());
			const registryChanged = !versionSeriesRecordsEqual(this.records, next);
			this.records = next;
			this.index.rebuild(this.records);
			if (registryChanged) {
				this.revision += 1;
			}
		});
	}

	/**
	 * Schema-2 records knew only a path. Resolve those exact paths once and
	 * persist a ctime identity hint before the index is allowed to aggregate or
	 * hide any member. A missing path, unsupported file, identity mismatch, or
	 * failed save leaves that entire series fail-open for explicit repair.
	 */
	async migrateLegacyMemberIdentities(): Promise<number> {
		return this.enqueue(async () => {
			const next = this.getRecords();
			let migratedSeries = 0;

			for (const series of next) {
				const candidates = series.slots.map((slot) => {
					if (!slot.member) {
						return null;
					}
					const file = this.vault.getFileByPath(slot.member.path);
					if (!file || !isVersionableFile(file)) {
						return null;
					}
					if (slot.member.identity && !memberMatchesFile(slot.member, file)) {
						return null;
					}
					return { file, slot };
				});
				if (candidates.some((candidate) => candidate === null)) {
					continue;
				}
				if (candidates.every((candidate) => candidate?.slot.member?.identity)) {
					continue;
				}
				for (const candidate of candidates) {
					if (candidate?.slot.member && !candidate.slot.member.identity) {
						candidate.slot.member = memberRecordFromFile(candidate.file);
					}
				}
				migratedSeries += 1;
			}

			if (migratedSeries === 0) {
				this.rebuild();
				return 0;
			}
			await this.commit(next);
			return migratedSeries;
		});
	}

	async createSeries(v1: TFile, v2: TFile): Promise<string> {
		return this.enqueue(async () => {
			this.assertFilesAreLive([v1, v2]);
			this.assertFilesAreUnmanaged([v1, v2]);
			const id = createSeriesId();
			const next = this.getRecords();
			next.push({
				id,
				slots: [
					{ member: memberRecordFromFile(v1), version: 1 },
					{ member: memberRecordFromFile(v2), version: 2 },
				],
			});
			await this.commit(next);
			return id;
		});
	}

	async addMember(
		seriesId: string,
		version: number,
		file: TFile,
	): Promise<void> {
		return this.enqueue(async () => {
			if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
				throw new Error(`Invalid version number: V${version}.`);
			}
			this.assertFilesAreLive([file]);
			this.assertFilesAreUnmanaged([file]);
			const next = this.getRecords();
			const series = next.find((record) => record.id === seriesId);
			if (!series) {
				throw new Error('Version series no longer exists.');
			}
			this.assertSeriesExactlyResolved(seriesId);
			this.assertMembersResolve(series.slots);
			const existingSlot = series.slots.find((slot) => slot.version === version);
			if (existingSlot?.member) {
				throw new Error(`V${version} is already occupied.`);
			}

			if (existingSlot) {
				existingSlot.member = memberRecordFromFile(file);
			} else {
				series.slots.push({ member: memberRecordFromFile(file), version });
			}
			series.slots.sort((left, right) => left.version - right.version);
			await this.commit(next);
		});
	}

	/**
	 * Add one new file to a healthy exact or precision-compatible relationship.
	 * This is deliberately narrower than addMember: every pre-existing slot is
	 * retained byte-for-byte, so a device never rebases another device's ctime.
	 */
	async appendMemberToResolvedSeries(
		expectation: VersionAppendExpectation,
		version: number,
		file: TFile,
	): Promise<void> {
		// TFile is mutable in Obsidian. Freeze the newly created file's complete
		// identity before this operation waits behind another registry mutation so
		// a rename or same-path replacement cannot change what gets registered.
		const fileCapture = captureFile(file);
		const member = memberRecordFromFile(file);
		return this.enqueue(async () => {
			if (!this.appendExpectations.delete(expectation)) {
				throw new Error('Version append authorization is no longer valid.');
			}
			if (expectation.purpose !== 'append') {
				throw new Error('Version append authorization is invalid.');
			}
			if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
				throw new Error(`Invalid version number: V${version}.`);
			}
			if (expectation.seriesId !== expectation.series.id) {
				throw new Error('Version append authorization is invalid.');
			}

			this.assertExpectedRevision(expectation.revision);
			this.assertExpectedSeries(expectation.seriesId, expectation.series);
			this.index.rebuild(this.records);
			const group = this.index.getGroupById(expectation.seriesId);
			if (!group || group.status !== 'healthy') {
				throw new Error(
					'Version series changed or disappeared before the relationship was saved.',
				);
			}

			const matchingIndexes = this.records.flatMap((record, index) =>
				record.id === expectation.seriesId ? [index] : []);
			if (matchingIndexes.length !== 1) {
				throw new Error('Version series could not be resolved safely.');
			}
			const seriesIndex = matchingIndexes[0];
			const series = this.records[seriesIndex];
			this.assertResolvedSeriesExpectation(series, expectation);
			this.assertPathsAreUnmanaged(
				series.slots.flatMap((slot) => slot.member ? [slot.member.path] : []),
				seriesIndex,
			);
			const liveFile = this.vault.getFileByPath(fileCapture.path);
			if (
				!isCapturedFile(liveFile, fileCapture) ||
				!isVersionableFile(liveFile)
			) {
				throw new Error(
					`${fileCapture.path} is no longer the same supported file.`,
				);
			}
			this.assertPathsAreUnmanaged([member.path]);
			if (series.slots.some((slot) => slot.version === version)) {
				throw new Error(`V${version} is already occupied.`);
			}

			const next = this.getRecords();
			next[seriesIndex].slots.push({
				member,
				version,
			});
			await this.commit(next);
		});
	}

	/**
	 * Save a reordered or reduced slot mapping for a healthy exact or
	 * precision-compatible series. Old member records are not regenerated on the
	 * current device: callers must pass the original record alongside the exact
	 * TFile object captured when management opened. Newly assigned files use
	 * their current exact identity. Any registry race or change to a retained
	 * member rejects the operation; a member explicitly removed from the final
	 * mapping may meanwhile change because forgetting that mapping is safe.
	 */
	async saveResolvedSeriesManagement(
		expectation: VersionManagementExpectation,
		assignments: VersionManagementSlotAssignment[],
	): Promise<string> {
		const capturedAssignments = assignments.map((assignment) => ({
			capture: captureFile(assignment.file),
			member: cloneMemberRecord(assignment.member),
			version: assignment.version,
		}));
		return this.enqueue(async () => {
			if (!this.managementExpectations.delete(expectation)) {
				throw new Error('Version management authorization is no longer valid.');
			}
			if (expectation.purpose !== 'management') {
				throw new Error('Version management authorization is invalid.');
			}

			this.assertExpectedRevision(expectation.revision);
			this.assertExpectedSeries(expectation.seriesId, expectation.series);
			this.index.rebuild(this.records);

			const matchingIndexes = this.records.flatMap((record, index) =>
				record.id === expectation.seriesId ? [index] : []);
			if (matchingIndexes.length !== 1) {
				throw new Error('Version series could not be resolved safely.');
			}
			const seriesIndex = matchingIndexes[0];
			const series = this.records[seriesIndex];

			const slots: VersionSlotRecord[] = capturedAssignments.map(
				({ member, version }) => ({ member, version }),
			);
			validateSlots(slots, true);
			this.assertPathsAreUnmanaged(
				slots.flatMap((slot) => slot.member ? [slot.member.path] : []),
				seriesIndex,
			);

			const originalByFile = new Map<TFile, VersionMemberRecord>();
			const originalByPath = new Map<string, TFile>();
			if (expectation.members.length !== series.slots.length) {
				throw new Error(
					'Version relationship authorization no longer matches the series.',
				);
			}
			for (const expected of expectation.members) {
				const originalSlot = series.slots.find((slot) =>
					slot.version === expected.version &&
					slot.member?.path === expected.path);
				if (
					!originalSlot?.member ||
					originalByFile.has(expected.file) ||
					originalByPath.has(expected.path)
				) {
					throw new Error('Version management authorization is ambiguous.');
				}
				originalByFile.set(expected.file, originalSlot.member);
				originalByPath.set(expected.path, expected.file);
			}

			for (const assignment of capturedAssignments) {
				const live = this.vault.getFileByPath(assignment.capture.path);
				if (
					!isCapturedFile(live, assignment.capture) ||
					!isVersionableFile(live)
				) {
					throw new Error(
						`${assignment.capture.path} is no longer the same supported file.`,
					);
				}
				if (assignment.member.path !== assignment.capture.path) {
					throw new Error(
						`${assignment.capture.path} no longer matches its Version member record.`,
					);
				}

				const originalMember = originalByFile.get(assignment.capture.file);
				if (originalMember) {
					const expected = expectation.members.find(
						(candidate) => candidate.file === assignment.capture.file,
					);
					if (
						!expected ||
						expected.path !== assignment.capture.path ||
						expected.file.path !== expected.path ||
						expected.file.stat.ctime !== expected.ctime ||
						!memberRecordsEqual(assignment.member, originalMember) ||
						!memberResolvesToFile(originalMember, assignment.capture.file)
					) {
						throw new Error(
							`${assignment.capture.path} no longer matches its original Version identity.`,
						);
					}
					continue;
				}
				if (originalByPath.has(assignment.member.path)) {
					throw new Error(
						`${assignment.capture.path} is not the originally registered Version file.`,
					);
				}

				const currentMember = memberRecordFromFile(assignment.capture.file);
				if (
					!memberRecordsEqual(assignment.member, currentMember) ||
					!memberMatchesFile(assignment.member, assignment.capture.file)
				) {
					throw new Error(
						`${assignment.capture.path} does not have an exact new Version identity.`,
					);
				}
			}

			const next = this.getRecords();
			next[seriesIndex] = {
				id: expectation.seriesId,
				slots: slots
					.map((slot) => ({
						member: slot.member ? cloneMemberRecord(slot.member) : null,
						version: slot.version,
					}))
					.sort((left, right) => left.version - right.version),
			};
			await this.commit(next);
			return expectation.seriesId;
		});
	}

	/**
	 * Dissolve a fully resolved relationship under the same one-shot registry CAS
	 * used for reorder/remove saves. Every captured member must still be the same
	 * supported TFile at the same path and live ctime before the mapping is
	 * forgotten. Any optional released-file move is authorized separately from a
	 * complete CapturedFile snapshot.
	 */
	async dissolveResolvedSeriesManagement(
		expectation: VersionManagementExpectation,
	): Promise<void> {
		return this.enqueue(async () => {
			if (!this.managementExpectations.delete(expectation)) {
				throw new Error('Version management authorization is no longer valid.');
			}
			if (expectation.purpose !== 'management') {
				throw new Error('Version management authorization is invalid.');
			}

			this.assertExpectedRevision(expectation.revision);
			this.assertExpectedSeries(expectation.seriesId, expectation.series);
			this.index.rebuild(this.records);

			const matchingIndexes = this.records.flatMap((record, index) =>
				record.id === expectation.seriesId ? [index] : []);
			if (matchingIndexes.length !== 1) {
				throw new Error('Version series could not be resolved safely.');
			}
			const seriesIndex = matchingIndexes[0];
			const series = this.records[seriesIndex];
			this.assertResolvedSeriesExpectation(series, expectation);

			const next = this.getRecords();
			next.splice(seriesIndex, 1);
			await this.commit(next);
		});
	}

	async saveSeriesMembers(
		seriesId: string | null,
		members: Array<{ file: TFile; version: number }>,
	): Promise<string> {
		return this.saveSeriesSlots(
			seriesId,
			members.map(({ file, version }) => ({
				member: memberRecordFromFile(file),
				version,
			})),
		);
	}

	async saveSeriesSlots(
		seriesId: string | null,
		slots: VersionSlotRecord[],
		expectedSeries?: VersionSeriesRecord | null,
		expectedRevision?: number,
	): Promise<string> {
		return this.enqueue(async () => {
			this.preflightSeriesSlots(
				seriesId,
				slots,
				true,
				expectedSeries,
				expectedRevision,
			);
			this.assertMembersResolve(slots);
			const next = this.getRecords();
			const existingIndex = seriesId
				? next.findIndex((record) => record.id === seriesId)
				: -1;

			const id = seriesId ?? createSeriesId();
			const replacement: VersionSeriesRecord = {
				id,
				slots: slots
					.map((slot) => ({
						member: slot.member ? { ...slot.member } : null,
						version: slot.version,
					}))
					.sort((left, right) => left.version - right.version),
			};
			if (existingIndex >= 0) {
				next[existingIndex] = replacement;
			} else {
				next.push(replacement);
			}
			await this.commit(next);
			return id;
		});
	}

	preflightSeriesSlots(
		seriesId: string | null,
		slots: VersionSlotRecord[],
		requireIdentity = false,
		expectedSeries?: VersionSeriesRecord | null,
		expectedRevision?: number,
	): void {
		this.assertExpectedRevision(expectedRevision);
		this.assertExpectedSeries(seriesId, expectedSeries);
		validateSlots(slots, requireIdentity);
		const matchingIndexes = seriesId
			? this.records.flatMap((record, index) =>
				record.id === seriesId ? [index] : [],
			)
			: [];
		if (seriesId && matchingIndexes.length === 0) {
			throw new Error('Version series no longer exists.');
		}
		if (matchingIndexes.length > 1) {
			throw new Error('Version series could not be resolved safely.');
		}

		// A repair may keep paths already owned by the one target relationship,
		// including while that relationship is incomplete. It must never adopt a
		// path that another relationship also owns, even if that overlap arrived
		// through external sync while the management editor was open.
		this.assertPathsAreUnmanaged(
			slots.flatMap((slot) => slot.member ? [slot.member.path] : []),
			matchingIndexes[0],
		);
	}

	async dissolveSeries(
		seriesId: string,
		expectedSeries?: VersionSeriesRecord | null,
		expectedRevision?: number,
	): Promise<void> {
		return this.enqueue(async () => {
			this.assertExpectedRevision(expectedRevision);
			this.assertExpectedSeries(seriesId, expectedSeries);
			const next = this.getRecords();
			const matches = next.filter((record) => record.id === seriesId);
			if (matches.length !== 1) {
				throw new Error('Version series could not be resolved safely.');
			}
			// Explicit management repair may dissolve an already incomplete record
			// without touching any user file. Legacy/direct callers still require a
			// fully exact group; the revision token proves the repair editor saw the
			// complete registry generation it is removing from.
			if (expectedRevision === undefined) {
				this.assertSeriesExactlyResolved(seriesId);
				this.assertMembersResolve(matches[0].slots);
			}
			await this.commit(next.filter((record) => record.id !== seriesId));
		});
	}

	/**
	 * Release exact, still-live V2+ members before their real files cross a
	 * destructive trash boundary. A middle number becomes an ordinary numeric
	 * gap; if only V1 would remain, the series is dissolved explicitly.
	 */
	async releaseVersionMembers(
		seriesId: string,
		captures: VersionMemberRelease[],
		expectedSeries?: VersionSeriesRecord | null,
	): Promise<ReleaseVersionMembersResult> {
		return this.enqueue(async () => {
			this.assertExpectedSeries(seriesId, expectedSeries);
			if (captures.length === 0) {
				throw new Error('No version members were selected.');
			}
			const versions = new Set<number>();
			for (const capture of captures) {
				if (capture.version === 1) {
					throw new Error('V1 must be replaced before it can leave a series.');
				}
				if (versions.has(capture.version)) {
					throw new Error(`Duplicate version selection: V${capture.version}.`);
				}
				versions.add(capture.version);
				const live = this.vault.getFileByPath(capture.path);
				if (
					live !== capture.file ||
					capture.file.path !== capture.path ||
					capture.file.stat.ctime !== capture.ctime ||
					capture.file.stat.mtime !== capture.mtime ||
					capture.file.stat.size !== capture.size
				) {
					throw new Error(`V${capture.version} changed after it was selected.`);
				}
			}

			const next = this.getRecords();
			const seriesIndex = next.findIndex((record) => record.id === seriesId);
			if (seriesIndex < 0) {
				throw new Error('Version series no longer exists.');
			}
			const series = next[seriesIndex];
			this.assertSeriesExactlyResolved(seriesId);
			this.assertMembersResolve(series.slots);
			for (const capture of captures) {
				const slot = series.slots.find(
					(candidate) => candidate.version === capture.version,
				);
				if (
					!slot?.member ||
					slot.member.path !== capture.path ||
					!memberMatchesFile(slot.member, capture.file)
				) {
					throw new Error(`V${capture.version} is no longer the registered file.`);
				}
			}

			series.slots = series.slots.filter(
				(slot) => !versions.has(slot.version),
			);
			const dissolved = series.slots.length < 2;
			if (dissolved) {
				next.splice(seriesIndex, 1);
			}
			await this.commit(next);
			return {
				dissolved,
				releasedVersions: [...versions].sort((left, right) => left - right),
			};
		});
	}

	/** Apply the same slot semantics after Obsidian itself has already deleted
	 * an exact registered file. V1 deletion dissolves the series so no remaining
	 * member can stay hidden without a representative. */
	async recordDeletedMember(
		seriesId: string,
		version: number,
		deletedFile: TFile,
	): Promise<ReleaseVersionMembersResult> {
		return this.enqueue(async () => {
			const next = this.getRecords();
			const seriesIndex = next.findIndex((record) => record.id === seriesId);
			if (seriesIndex < 0) {
				throw new Error('Version series no longer exists.');
			}
			const series = next[seriesIndex];
			const slot = series.slots.find((candidate) => candidate.version === version);
			if (
				!slot?.member ||
				slot.member.path !== deletedFile.path ||
				!memberMatchesFile(slot.member, deletedFile)
			) {
				throw new Error(`Deleted V${version} is no longer the registered file.`);
			}

			series.slots = series.slots.filter(
				(candidate) => candidate.version !== version,
			);
			const dissolved = version === 1 || series.slots.length < 2;
			if (dissolved) {
				next.splice(seriesIndex, 1);
			}
			await this.commit(next);
			return { dissolved, releasedVersions: [version] };
		});
	}

	async updateMemberPath(oldPath: string, file: TFile): Promise<boolean> {
		return this.enqueue(async () => {
			const liveFile = this.vault.getFileByPath(file.path);
			if (
				liveFile !== file ||
				!isVersionableFile(file)
			) {
				this.rebuild();
				return false;
			}
			const next = this.getRecords();
			const matches = next.flatMap((series) =>
				series.slots.flatMap((slot) =>
					slot.member?.path === oldPath && memberMatchesFile(slot.member, file)
						? [{ series, slot }]
						: [],
				),
			);

			// A rename event may belong to an unrelated file that reused a stale
			// registered path. Only the one exact registered identity may move.
			// Zero or ambiguous matches stay fail-open for explicit repair.
			if (matches.length !== 1) {
				this.rebuild();
				return false;
			}
			matches[0].slot.member = memberRecordFromFile(file);

			// The old registered path is already unresolved. Rebuild first so the
			// file explorer fails open while the updated relationship is persisted.
			this.rebuild();
			await this.commit(next);
			return true;
		});
	}

	/**
	 * Reconcile one folder rename/move that Obsidian has already completed.
	 * This operation updates relationship paths only; it never renames, rolls
	 * back, or otherwise writes any user file. Every registered descendant is
	 * verified first and all affected series are persisted in one commit.
	 */
	async reconcileFolderRename(
		oldFolderPath: string,
		newFolderPath: string,
	): Promise<number> {
		return this.enqueue(async () => {
			const oldFolder = normalizePath(oldFolderPath);
			const newFolder = normalizePath(newFolderPath);
			if (!oldFolder || !newFolder || oldFolder === newFolder) {
				this.rebuild();
				return 0;
			}
			// Obsidian has already moved the physical folder. Keep the unchanged
			// records active but rebuild them immediately so any verification or
			// persistence failure exposes every unresolved member fail-open.
			this.rebuild();

			const next = this.getRecords();
			const affected: Array<{
				file: TFile;
				newPath: string;
				slot: VersionSlotRecord;
			}> = [];
			const unaffectedPaths = new Set<string>();
			const seenOldPaths = new Set<string>();
			const seenNewPaths = new Set<string>();
			const seenSeriesIds = new Set<string>();

			for (const series of next) {
				if (seenSeriesIds.has(series.id)) {
					throw new Error('Version series identifiers are ambiguous.');
				}
				seenSeriesIds.add(series.id);
				for (const slot of series.slots) {
					if (!slot.member) {
						continue;
					}
					const mapped = mapFolderDescendantPath(
						slot.member.path,
						oldFolder,
						newFolder,
					);
					if (!mapped) {
						unaffectedPaths.add(slot.member.path);
						continue;
					}
					if (
						seenOldPaths.has(slot.member.path) ||
						seenNewPaths.has(mapped)
					) {
						throw new Error('Version folder members are ambiguous.');
					}
					seenOldPaths.add(slot.member.path);
					seenNewPaths.add(mapped);
					const file = this.vault.getFileByPath(mapped);
					if (
						!file ||
						!isVersionableFile(file) ||
						!memberMatchesFile(slot.member, file)
					) {
						throw new Error(
							`The moved Version member could not be verified at ${mapped}.`,
						);
					}
					affected.push({ file, newPath: mapped, slot });
				}
			}

			if (affected.length === 0) {
				this.rebuild();
				return 0;
			}
			for (const item of affected) {
				if (unaffectedPaths.has(item.newPath)) {
					throw new Error(
						`The moved Version path is already registered: ${item.newPath}.`,
					);
				}
				// Recheck the exact live object immediately before persistence. A
				// replacement file with the same name must never be adopted.
				if (this.vault.getFileByPath(item.newPath) !== item.file) {
					throw new Error(
						`The moved Version member changed at ${item.newPath}.`,
					);
				}
				item.slot.member = memberRecordFromFile(item.file);
			}

			await this.commit(next);
			return affected.length;
		});
	}

	private assertFilesAreUnmanaged(files: TFile[]): void {
		this.assertPathsAreUnmanaged(files.map((file) => file.path));
	}

	private assertFilesAreLive(files: TFile[]): void {
		const paths = new Set<string>();
		for (const file of files) {
			if (paths.has(file.path)) {
				throw new Error(`Duplicate Version file: ${file.path}.`);
			}
			paths.add(file.path);
			const current = this.vault.getFileByPath(file.path);
			if (
				!current ||
				current !== file ||
				!isVersionableFile(current) ||
				!memberMatchesFile(memberRecordFromFile(file), current)
			) {
				throw new Error(`${file.path} is no longer the same supported file.`);
			}
		}
	}

	private assertMembersResolve(slots: VersionSlotRecord[]): void {
		for (const slot of slots) {
			if (!slot.member) {
				throw new Error(`V${slot.version} does not have a file.`);
			}
			const file = this.vault.getFileByPath(slot.member.path);
			if (
				!file ||
				!isVersionableFile(file) ||
				!memberMatchesFile(slot.member, file)
			) {
				throw new Error(
					`V${slot.version} changed or disappeared before the relationship was saved.`,
				);
			}
		}
	}

	private assertResolvedSeriesExpectation(
		series: VersionSeriesRecord,
		expectation: ResolvedSeriesExpectation,
	): void {
		if (expectation.members.length !== series.slots.length) {
			throw new Error('Version relationship authorization no longer matches the series.');
		}
		const expectedByVersion = new Map(
			expectation.members.map((member) => [member.version, member] as const),
		);
		if (expectedByVersion.size !== expectation.members.length) {
			throw new Error('Version relationship authorization is ambiguous.');
		}

		for (const slot of series.slots) {
			if (!slot.member) {
				throw new Error(`V${slot.version} does not have a file.`);
			}
			const expected = expectedByVersion.get(slot.version);
			const live = expected
				? this.vault.getFileByPath(expected.path)
				: null;
			if (
				!expected ||
				expected.path !== slot.member.path ||
				expected.file.path !== expected.path ||
				expected.file.stat.ctime !== expected.ctime ||
				live !== expected.file ||
				!isVersionableFile(expected.file) ||
				!memberResolvesToFile(slot.member, expected.file)
			) {
				throw new Error(
					`V${slot.version} changed or disappeared before the relationship was saved.`,
				);
			}
		}
	}

	private assertPathsAreUnmanaged(
		paths: string[],
		allowedRecordIndex = -1,
	): void {
		const managedPaths = new Set(
			this.records.flatMap((series, index) =>
				index === allowedRecordIndex
					? []
					: series.slots.flatMap((slot) =>
						slot.member ? [slot.member.path] : [],
					),
			),
		);
		for (const path of paths) {
			if (managedPaths.has(path)) {
				throw new Error(`${path} already belongs to a Version series.`);
			}
		}
	}

	private assertSeriesExactlyResolved(seriesId: string): void {
		if (!this.resolveExactlyMatchedGroup(seriesId)) {
			throw new Error(
				'Version series changed or disappeared before the relationship was saved.',
			);
		}
	}

	private assertExpectedSeries(
		seriesId: string | null,
		expectedSeries: VersionSeriesRecord | null | undefined,
	): void {
		if (expectedSeries === undefined) {
			return;
		}
		const matches = seriesId
			? this.records.filter((record) => record.id === seriesId)
			: [];
		const current = matches.length === 1 ? matches[0] : null;
		const unchanged =
			(current === null && expectedSeries === null) ||
			(current !== null &&
				expectedSeries !== null &&
				versionSeriesRecordsEqual([current], [expectedSeries]));
		if (!unchanged) {
			throw new Error(
				'Version series changed while this editor was open. Reopen Version management.',
			);
		}
	}

	private assertExpectedRevision(expectedRevision: number | undefined): void {
		if (
			expectedRevision !== undefined &&
			expectedRevision !== this.revision
		) {
			throw new Error(
				'Version registry changed while this editor was open. Reopen Version management.',
			);
		}
	}

	private async commit(next: VersionSeriesRecord[]): Promise<void> {
		await this.persistSeries(next);
		this.records = cloneSeriesRecords(next);
		this.index.rebuild(this.records);
		this.revision += 1;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function validateSlots(
	slots: VersionSlotRecord[],
	requireIdentity: boolean,
): void {
	if (slots.length < 2) {
		throw new Error('A Version series needs at least two version slots.');
	}
	const versions = new Set<number>();
	const paths = new Set<string>();
	for (const slot of slots) {
		const { version } = slot;
		if (
			!Number.isInteger(version) ||
			version < 1 ||
			version > 99 ||
			versions.has(version)
		) {
			throw new Error(`Invalid or duplicate version number: V${version}.`);
		}
		if (!slot.member) {
			throw new Error(`V${version} does not have a note.`);
		}
		if (
			requireIdentity &&
			(!slot.member.identity || !Number.isFinite(slot.member.identity.ctime))
		) {
			throw new Error(`V${version} does not have a verified file identity.`);
		}
		if (slot.member && paths.has(slot.member.path)) {
			throw new Error(`Duplicate Version file: ${slot.member.path}.`);
		}
		versions.add(version);
		if (slot.member) {
			paths.add(slot.member.path);
		}
	}
	if (!versions.has(1)) {
		throw new Error('A Version series must have V1.');
	}
}

function cloneMemberRecord(member: VersionMemberRecord): VersionMemberRecord {
	return {
		identity: member.identity ? { ...member.identity } : undefined,
		lastKnownName: member.lastKnownName,
		path: member.path,
	};
}

function memberRecordsEqual(
	left: VersionMemberRecord,
	right: VersionMemberRecord,
): boolean {
	return (
		left.path === right.path &&
		left.lastKnownName === right.lastKnownName &&
		left.identity?.ctime === right.identity?.ctime
	);
}

function createSeriesId(): string {
	if (typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}

	return `version-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mapFolderDescendantPath(
	path: string,
	oldFolderPath: string,
	newFolderPath: string,
): string | null {
	const prefix = `${oldFolderPath}/`;
	if (!path.startsWith(prefix)) {
		return null;
	}
	return normalizePath(`${newFolderPath}/${path.slice(prefix.length)}`);
}
