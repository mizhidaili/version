import { TFile, Vault } from 'obsidian';
import {
	capturedFileFailurePath,
	CapturedFile,
	isCapturedFile,
	resolveCapturedFile,
} from './captured-file';

/**
 * Remove only blank files created by the in-flight operation. If a file was
 * edited, replaced, or cannot be removed, fail open and leave its path visible.
 */
export async function rollbackCreatedBlankFiles(
	vault: Vault,
	trashFile: (file: TFile) => Promise<void>,
	files: CapturedFile[],
): Promise<string[]> {
	const failedPaths: string[] = [];
	for (const created of [...files].reverse()) {
		const live = resolveCapturedFile(vault, created);
		if (!live) {
			const survivingPath = capturedFileFailurePath(vault, created);
			if (survivingPath) {
				failedPaths.push(survivingPath);
			}
			continue;
		}
		try {
			// A cleanup decision must use a direct read, not a potentially stale
			// metadata cache. Revalidate again after the await before trashing.
			if ((await vault.read(live)) !== '') {
				failedPaths.push(live.path);
				continue;
			}
			const revalidated = vault.getFileByPath(created.path);
			if (!isCapturedFile(revalidated, created)) {
				failedPaths.push(
					capturedFileFailurePath(vault, created) ?? created.path,
				);
				continue;
			}
			await trashFile(revalidated);
		} catch {
			failedPaths.push(
				capturedFileFailurePath(vault, created) ?? created.path,
			);
		}
	}
	return failedPaths;
}
