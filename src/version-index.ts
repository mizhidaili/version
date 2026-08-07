import { normalizePath, TFile, Vault } from 'obsidian';
import {
	memberMatchesFile,
	VersionSeriesRecord,
	VersionSlotRecord,
} from './version-data';
import { isVersionableFile } from './version-file-types';

export const MAX_VERSION = 99;

export type VersionSeriesStatus = 'healthy' | 'incomplete' | 'invalid';

export interface VersionFile {
	file: TFile;
	folder: string;
	groupKey: string;
	path: string;
	topic: string;
	version: number;
}

export interface VersionGroup {
	folder: string;
	id: string;
	key: string;
	maximumVersion: number;
	status: VersionSeriesStatus;
	topic: string;
	versions: VersionFile[];
}

interface MutableVersionGroup extends VersionGroup {
	record: VersionSeriesRecord;
}

export class VersionIndex {
	private readonly filesByPath = new Map<string, VersionGroup>();
	private readonly groups = new Map<string, MutableVersionGroup>();

	constructor(private readonly vault: Vault) {}

	rebuild(records: VersionSeriesRecord[]): void {
		this.filesByPath.clear();
		this.groups.clear();

		const idCounts = new Map<string, number>();
		for (const record of records) {
			idCounts.set(record.id, (idCounts.get(record.id) ?? 0) + 1);
		}
		const ownersByPath = new Map<string, MutableVersionGroup[]>();
		for (const [recordIndex, record] of records.entries()) {
			const group = this.resolveSeries(record);
			if ((idCounts.get(record.id) ?? 0) > 1) {
				group.status = 'invalid';
				group.key = `${record.id}\u0000${recordIndex}`;
			}
			this.groups.set(group.key, group);

			for (const versionFile of group.versions) {
				const owners = ownersByPath.get(versionFile.path) ?? [];
				owners.push(group);
				ownersByPath.set(versionFile.path, owners);
			}
		}

		for (const [path, owners] of ownersByPath) {
			if (owners.length !== 1) {
				for (const owner of owners) {
					owner.status = 'invalid';
				}
				continue;
			}
			this.filesByPath.set(path, owners[0]);
		}
	}

	getGroupForFile(file: TFile): VersionGroup | null {
		return this.filesByPath.get(file.path) ?? null;
	}

	getGroupById(id: string): VersionGroup | null {
		const matches = [...this.groups.values()].filter(
			(group) => group.id === id,
		);
		return matches.length === 1 ? matches[0] : null;
	}

	getGroups(): VersionGroup[] {
		return this.getAllGroups().filter(
			(group) => group.status === 'healthy',
		);
	}

	getAllGroups(): VersionGroup[] {
		return [...this.groups.values()].sort((left, right) =>
			left.topic.localeCompare(right.topic),
		);
	}

	private resolveSeries(record: VersionSeriesRecord): MutableVersionGroup {
		let status: VersionSeriesStatus = 'healthy';
		const versions: VersionFile[] = [];
		const seenVersions = new Set<number>();
		const seenPaths = new Set<string>();

		for (const slot of record.slots) {
			if (!isValidSlot(slot) || seenVersions.has(slot.version)) {
				status = 'invalid';
				continue;
			}
			seenVersions.add(slot.version);

			if (!slot.member) {
				status = status === 'invalid' ? 'invalid' : 'incomplete';
				continue;
			}
			if (seenPaths.has(slot.member.path)) {
				status = 'invalid';
				continue;
			}
			seenPaths.add(slot.member.path);

			const file = this.vault.getFileByPath(slot.member.path);
			if (
				!file ||
				!isVersionableFile(file) ||
				!memberMatchesFile(slot.member, file)
			) {
				status = status === 'invalid' ? 'invalid' : 'incomplete';
				continue;
			}

			versions.push({
				file,
				folder: getFolder(file),
				groupKey: record.id,
				path: file.path,
				topic: '',
				version: slot.version,
			});
		}

		versions.sort((left, right) => left.version - right.version);
		const v1 = versions.find((versionFile) => versionFile.version === 1);
		if (!v1) {
			status = status === 'invalid' ? 'invalid' : 'incomplete';
		}

		const lastKnownV1 = record.slots.find(
			(slot) => slot.version === 1,
		)?.member;
		const topic = v1?.file.basename ?? lastKnownV1?.lastKnownName ?? 'Version';
		const folder = v1 ? getFolder(v1.file) : '';
		for (const versionFile of versions) {
			versionFile.topic = topic;
		}

		return {
			folder,
			id: record.id,
			key: record.id,
			maximumVersion: Math.max(0, ...seenVersions),
			record,
			status,
			topic,
			versions,
		};
	}
}

export function getOverallVersion(group: VersionGroup): VersionFile | null {
	return (
		group.versions.find((versionFile) => versionFile.version === 1) ?? null
	);
}

export function getNextVersion(group: VersionGroup): number {
	return group.maximumVersion + 1;
}

export function getMissingVersions(group: VersionGroup): number[] {
	// The compact add menu is only valid for a fully resolved series. An
	// unresolved registered member must remain a repairable assignment, never
	// be mistaken for an empty numeric slot that can be overwritten.
	if (group.status !== 'healthy') {
		return [];
	}
	const occupied = new Set(
		group.versions.map((versionFile) => versionFile.version),
	);
	const maximum = Math.min(MAX_VERSION, group.maximumVersion);
	const missing: number[] = [];

	for (let version = 1; version <= maximum; version += 1) {
		if (!occupied.has(version)) {
			missing.push(version);
		}
	}

	return missing;
}

export function buildVersionPath(
	group: VersionGroup,
	version: number,
	template = '{{name}} (V{{version}})',
): string {
	const v1 = getOverallVersion(group);
	if (!v1) {
		throw new Error('V1 is missing.');
	}

	const filename = formatVersionFilename(
		template,
		v1.file.basename,
		version,
	);
	return normalizePath(
		group.folder ? `${group.folder}/${filename}.md` : `${filename}.md`,
	);
}

export function formatVersionFilename(
	template: string,
	name: string,
	version: number,
): string {
	const filename = template
		.replaceAll('{{name}}', name)
		.replaceAll('{{version}}', String(version))
		.trim();
	if (!filename || /[/\\\n\r]/u.test(filename)) {
		throw new Error('The version filename template is not valid.');
	}
	return filename.toLocaleLowerCase().endsWith('.md')
		? filename.slice(0, -3)
		: filename;
}

function getFolder(file: TFile): string {
	const parent = file.parent?.path ?? '';
	return parent === '/' ? '' : parent;
}

function isValidSlot(slot: VersionSlotRecord): boolean {
	return (
		Number.isInteger(slot.version) &&
		slot.version >= 1 &&
		slot.version <= MAX_VERSION
	);
}
