import { TFile, Vault } from 'obsidian';
import {
	captureFile,
	CapturedFile,
	resolveCapturedFile,
} from './captured-file';

export interface VersionedFileForTrash {
	file: TFile;
	version: number;
}

export interface CapturedVersionForTrash extends CapturedFile {
	version: number;
}

export interface TrashCapturedVersionsResult {
	deletedCount: number;
	failedPaths: string[];
}

export function captureVersionForTrash(
	versionFile: VersionedFileForTrash & { path?: string },
): CapturedVersionForTrash {
	return {
		...captureFile(versionFile.file, versionFile.path ?? versionFile.file.path),
		version: versionFile.version,
	};
}

/**
 * A destructive action is authorized for the exact file object captured by
 * the confirmation dialog, never merely for whichever file now owns its path.
 */
export function isUnchangedCapturedFile(
	live: unknown,
	captured: CapturedFile,
): live is TFile {
	return resolveCapturedFileLike(live, captured);
}

/** Keep the visible V1 recovery anchor until every selected companion. */
export function orderVersionsForTrash<T extends VersionedFileForTrash>(
	versions: T[],
): T[] {
	return versions.slice().sort((left, right) =>
		left.version === 1
			? 1
			: right.version === 1
				? -1
				: left.version - right.version,
	);
}

/**
 * Revalidate the immutable user-approved target immediately before every
 * destructive await boundary. A rename, edit, or replacement is a failure,
 * never permission to follow the TFile object to its new state.
 */
export async function trashCapturedVersions(
	vault: Vault,
	trashFile: (file: TFile) => Promise<void>,
	versions: CapturedVersionForTrash[],
): Promise<TrashCapturedVersionsResult> {
	let deletedCount = 0;
	const failedPaths: string[] = [];
	const ordered = orderVersionsForTrash(versions);
	const wholeSeriesIncludesV1 = ordered.length > 1 &&
		ordered.some((captured) => captured.version === 1);
	for (const captured of ordered) {
		// If any companion failed, leave V1 in the vault as the clearest visible
		// recovery anchor. The user can review the residue before trying again.
		if (
			captured.version === 1 &&
			wholeSeriesIncludesV1 &&
			failedPaths.length > 0
		) {
			failedPaths.push(captured.path);
			continue;
		}
		const live = resolveCapturedFile(vault, captured);
		if (!live) {
			failedPaths.push(captured.path);
			continue;
		}
		try {
			await trashFile(live);
			deletedCount += 1;
		} catch {
			failedPaths.push(captured.path);
		}
	}
	return { deletedCount, failedPaths };
}

function resolveCapturedFileLike(
	live: unknown,
	captured: CapturedFile,
): live is TFile {
	return (
		live instanceof TFile &&
		live === captured.file &&
		live.path === captured.path &&
		live.stat.ctime === captured.ctime &&
		live.stat.mtime === captured.mtime &&
		live.stat.size === captured.size
	);
}
