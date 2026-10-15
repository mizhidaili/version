import { normalizePath } from 'obsidian';

export interface FolderPathChange {
	oldPath: string;
	newPath: string;
}

/** Replay observed directory moves in order, including moves before a save. */
export function mapFolderChanges(path: string, changes: readonly FolderPathChange[]): string {
	let current = normalizePath(path);
	for (const change of changes) {
		const oldPath = normalizePath(change.oldPath);
		const newPath = normalizePath(change.newPath);
		if (oldPath && newPath && current.startsWith(`${oldPath}/`)) {
			current = normalizePath(`${newPath}/${current.slice(oldPath.length + 1)}`);
		}
	}
	return current;
}

/** Poll actual destinations, not an assumed duration of Obsidian's event burst.
 * Missing/replaced members have a bounded wait and are left for explicit repair.
 * The latest batch is reread after every await so consecutive moves compose.
 */
export async function waitForFolderRenameTargets(environment: {
	getChanges: () => FolderPathChange[];
	isReady: (changes: FolderPathChange[]) => boolean;
	isStopped: () => boolean;
	wait: () => Promise<void>;
}, attempts = 100): Promise<FolderPathChange[]> {
	let changes = environment.getChanges();
	for (let attempt = 0; attempt < attempts && !environment.isStopped(); attempt++) {
		if (environment.isReady(changes)) {
			return changes;
		}
		await environment.wait();
		changes = environment.getChanges();
	}
	return changes;
}
