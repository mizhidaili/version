export interface RenameCompletionEnvironment<File> {
	cancelTimeout: (handle: unknown) => void;
	getFileByPath: (path: string) => File | null;
	onRename: (
		listener: (file: File, oldPath: string) => void,
	) => () => void;
	rename: () => Promise<void> | void;
	scheduleTimeout: (callback: () => void, delay: number) => unknown;
}

/**
 * Obsidian's FileManager.renameFile() is not a completion barrier on every
 * supported desktop build: it may return before Vault updates the TFile and
 * emits `rename`. Keep the caller's transaction paused until the exact file is
 * observable at the exact destination. This also keeps internal rename-event
 * suppression active for the whole physical operation.
 */
export async function renameAndWaitForExactDestination<
	File extends { path: string },
>(
	file: File,
	from: string,
	to: string,
	environment: RenameCompletionEnvironment<File>,
	timeoutMs = 5_000,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let operationFinished = false;
		let renameObserved = false;
		let settled = false;

		const isAtDestination = () =>
			file.path === to && environment.getFileByPath(to) === file;
		let stopListening = () => {};
		let timeout: unknown = null;
		const cleanupAndSettle = (error?: unknown) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout !== null) {
				environment.cancelTimeout(timeout);
			}
			stopListening();
			if (error !== undefined) {
				reject(error instanceof Error ? error : new Error('File move failed.'));
			} else {
				resolve();
			}
		};
		const finishIfComplete = () => {
			if (operationFinished && renameObserved && isAtDestination()) {
				cleanupAndSettle();
			}
		};
		stopListening = environment.onRename((renamedFile, oldPath) => {
			if (
				renamedFile === file &&
				oldPath === from &&
				isAtDestination()
			) {
				renameObserved = true;
				finishIfComplete();
			}
		});
		timeout = environment.scheduleTimeout(() => {
			cleanupAndSettle(new Error(`Timed out moving file from ${from} to ${to}.`));
		}, timeoutMs);

		let operation: Promise<void>;
		try {
			operation = Promise.resolve(environment.rename());
		} catch (error) {
			cleanupAndSettle(error);
			return;
		}
		void operation.then(
			() => {
				operationFinished = true;
				// Some Obsidian versions update the live file synchronously.
				if (isAtDestination()) {
					renameObserved = true;
				}
				finishIfComplete();
			},
			(error: unknown) => cleanupAndSettle(error),
		);
	});
}
