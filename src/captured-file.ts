import { TFile, Vault } from 'obsidian';

/**
 * Immutable authorization captured before a destructive or compensating file
 * operation. Obsidian mutates a TFile's path and stat object in place, so the
 * TFile reference alone is not a stable description of what the user approved.
 */
export interface CapturedFile {
	file: TFile;
	mtime: number;
	path: string;
	size: number;
	ctime: number;
}

export function captureFile(file: TFile, path = file.path): CapturedFile {
	return {
		ctime: file.stat.ctime,
		file,
		mtime: file.stat.mtime,
		path,
		size: file.stat.size,
	};
}

export function isCapturedFile(
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

export function resolveCapturedFile(
	vault: Vault,
	captured: CapturedFile,
): TFile | null {
	const live = vault.getFileByPath(captured.path);
	return isCapturedFile(live, captured) ? live : null;
}

/** Report the current path if the exact object survived under a new name. */
export function capturedFileFailurePath(
	vault: Vault,
	captured: CapturedFile,
): string | null {
	const currentPath = captured.file.path;
	return vault.getFileByPath(currentPath) === captured.file
		? currentPath
		: vault.getFileByPath(captured.path)?.path ?? null;
}
