import { TFile, Vault } from 'obsidian';
import {
	capturedFileFailurePath,
	CapturedFile,
	isCapturedFile,
	resolveCapturedFile,
} from './captured-file';

export interface CreatedFileRollbackCandidate {
	capture: CapturedFile;
	expectedContent: string;
}

/**
 * Remove only blank files created by the in-flight operation. If a file was
 * edited, replaced, or cannot be removed, fail open and leave its path visible.
 */
export async function rollbackCreatedBlankFiles(
	vault: Vault,
	trashFile: (file: TFile) => Promise<void>,
	files: CapturedFile[],
): Promise<string[]> {
	return rollbackCreatedFilesIfUnchanged(
		vault,
		trashFile,
		files.map((capture) => ({ capture, expectedContent: '' })),
	);
}

/**
 * Compensate an in-flight create only while the exact captured file still has
 * the exact content written by that create. Canvas and Excalidraw blank files
 * are structurally non-empty, so an empty-string check alone is not a safe or
 * complete transaction boundary.
 */
export async function rollbackCreatedFilesIfUnchanged(
	vault: Vault,
	trashFile: (file: TFile) => Promise<void>,
	files: CreatedFileRollbackCandidate[],
): Promise<string[]> {
	const failedPaths: string[] = [];
	for (const created of [...files].reverse()) {
		const live = resolveCapturedFile(vault, created.capture);
		if (!live) {
			const survivingPath = capturedFileFailurePath(vault, created.capture);
			if (survivingPath) {
				failedPaths.push(survivingPath);
			}
			continue;
		}
		try {
			// A cleanup decision must use a direct read, not a potentially stale
			// metadata cache. Revalidate again after the await before trashing.
			if ((await vault.read(live)) !== created.expectedContent) {
				failedPaths.push(live.path);
				continue;
			}
			const revalidated = vault.getFileByPath(created.capture.path);
			if (!isCapturedFile(revalidated, created.capture)) {
				failedPaths.push(
					capturedFileFailurePath(vault, created.capture) ??
						created.capture.path,
				);
				continue;
			}
			await trashFile(revalidated);
		} catch {
			failedPaths.push(
				capturedFileFailurePath(vault, created.capture) ??
					created.capture.path,
			);
		}
	}
	return failedPaths;
}
