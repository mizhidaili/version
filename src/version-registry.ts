import { normalizePath, TFile, Vault } from 'obsidian';
import {
	cloneSeriesRecords,
	memberMatchesFile,
	memberRecordFromFile,
	VersionSeriesRecord,
	VersionSlotRecord,
} from './version-data';
import { isVersionableFile } from './version-file-types';
import { MAX_VERSION, VersionIndex } from './version-index';

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

export class VersionRegistry {
	readonly index: VersionIndex;
	private mutationQueue: Promise<void> = Promise.resolve();
	private records: VersionSeriesRecord[];

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

	rebuild(): void {
		this.index.rebuild(this.records);
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
	): Promise<string> {
		return this.enqueue(async () => {
			this.preflightSeriesSlots(seriesId, slots, true);
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
	): void {
		validateSlots(slots, requireIdentity);
		const existingIndex = seriesId
			? this.records.findIndex((record) => record.id === seriesId)
			: -1;
		if (seriesId && existingIndex < 0) {
			throw new Error('Version series no longer exists.');
		}

		const allowedPaths = new Set<string>();
		if (existingIndex >= 0) {
			for (const slot of this.records[existingIndex].slots) {
				if (slot.member) {
					allowedPaths.add(slot.member.path);
				}
			}
		}
		this.assertPathsAreUnmanaged(
			slots.flatMap((slot) =>
				slot.member && !allowedPaths.has(slot.member.path)
					? [slot.member.path]
					: [],
			),
		);
	}

	async dissolveSeries(seriesId: string): Promise<void> {
		return this.enqueue(async () => {
			const next = this.getRecords();
			const matches = next.filter((record) => record.id === seriesId);
			if (matches.length !== 1) {
				throw new Error('Version series could not be resolved safely.');
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
	): Promise<ReleaseVersionMembersResult> {
		return this.enqueue(async () => {
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
				continue;
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

	private assertPathsAreUnmanaged(paths: string[]): void {
		const managedPaths = new Set(
			this.records.flatMap((series) =>
				series.slots.flatMap((slot) =>
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

	private async commit(next: VersionSeriesRecord[]): Promise<void> {
		await this.persistSeries(next);
		this.records = cloneSeriesRecords(next);
		this.index.rebuild(this.records);
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
