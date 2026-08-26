import { App, TFile } from 'obsidian';
import { captureFile } from './captured-file';
import { rollbackCreatedFilesIfUnchanged } from './created-file-rollback';
import {
	createPreparedVersionFile,
	prepareVersionFile,
	type VersionFileCreationOptions,
} from './version-file-creation';

export type RegisteredVersionFileResult =
	| { file: TFile; openError: null; openFailed: false }
	| { file: TFile; openError: unknown; openFailed: true };

export class VersionFileRegistrationError extends Error {
	readonly originalCause: unknown;
	readonly path: string;
	readonly rollbackFailures: string[];

	constructor(
		path: string,
		originalCause: unknown,
		rollbackFailures: string[],
	) {
		super(originalCause instanceof Error ? originalCause.message : String(originalCause));
		this.name = 'VersionFileRegistrationError';
		this.originalCause = originalCause;
		this.path = path;
		this.rollbackFailures = rollbackFailures;
	}
}

/**
 * Create, register, and optionally open one exact member. Registration is the
 * commit boundary: a failure compensates only an unchanged file created by
 * this operation, while an opening failure returns after preserving the
 * already committed file and relationship.
 */
export async function createAndRegisterVersionFile(
	app: App,
	options: VersionFileCreationOptions,
	register: (file: TFile) => Promise<void>,
	trashFile: (file: TFile) => Promise<void>,
	openFile?: (file: TFile) => Promise<void>,
): Promise<RegisteredVersionFileResult> {
	const prepared = await prepareVersionFile(app, options);
	const file = await createPreparedVersionFile(app, prepared);
	const capture = captureFile(file);
	try {
		await register(file);
	} catch (error) {
		const rollbackFailures = await rollbackCreatedFilesIfUnchanged(
			app.vault,
			trashFile,
			[{ capture, expectedContent: prepared.content }],
		);
		throw new VersionFileRegistrationError(
			file.path,
			error,
			rollbackFailures,
		);
	}

	if (openFile) {
		try {
			await openFile(file);
		} catch (error) {
			return { file, openError: error, openFailed: true };
		}
	}
	return { file, openError: null, openFailed: false };
}
