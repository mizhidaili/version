import type { VersionFile, VersionGroup } from './version-index';

export type VersionFileMenuPrimaryAction =
	| 'create'
	| 'locate'
	| 'manage'
	| 'repair';

export interface VersionFileMenuState {
	action: VersionFileMenuPrimaryAction;
	isManagedMember: boolean;
	resolvedVersion: VersionFile | null;
}

/**
 * Classify only the visible, non-destructive file-menu state. A relationship
 * resolved through the narrow cross-device ctime compatibility rule is healthy
 * and managed; exact identity remains a separate gate for mutating actions.
 */
export function getVersionFileMenuState(
	group: VersionGroup | null,
	filePath: string,
	registeredSeriesCount: number,
): VersionFileMenuState {
	const resolvedVersion = group?.status === 'healthy'
		? group.versions.find((member) => member.path === filePath) ?? null
		: null;
	const isManagedMember = group?.status === 'healthy' &&
		resolvedVersion !== null;
	if (isManagedMember) {
		return {
			action: resolvedVersion.version === 1 ? 'manage' : 'locate',
			isManagedMember: true,
			resolvedVersion,
		};
	}
	return {
		action: group !== null || registeredSeriesCount > 0 ? 'repair' : 'create',
		isManagedMember: false,
		resolvedVersion: null,
	};
}
