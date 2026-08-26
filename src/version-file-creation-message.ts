import { VersionI18n } from './i18n';
import {
	VersionFileCreationError,
	VersionFileCreationErrorCode,
} from './version-file-creation';

/** Localize dependency failures while preserving useful native errors. */
export function getVersionFileCreationErrorMessage(
	error: unknown,
	i18n: VersionI18n,
): string {
	if (!(error instanceof VersionFileCreationError)) {
		return error instanceof Error ? error.message : String(error);
	}

	switch (error.code) {
		case VersionFileCreationErrorCode.ExcalidrawPluginUnavailable:
		case VersionFileCreationErrorCode.ExcalidrawApiUnavailable:
			return i18n.t('create.excalidrawUnavailable');
		case VersionFileCreationErrorCode.ExcalidrawContentPreparationFailed:
		case VersionFileCreationErrorCode.InvalidExcalidrawContent:
			return i18n.t('create.excalidrawPreparationFailed');
		default:
			return error.originalCause instanceof Error
				? error.originalCause.message
				: error.message;
	}
}
