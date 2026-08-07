import { normalizePath } from 'obsidian';
import { VersionGroup } from './version-index';

export interface MovePlan {
	file: VersionGroup['versions'][number]['file'];
	from: string;
	to: string;
}

export function buildMovePlans(
	group: VersionGroup,
	destinationFolder: string,
): MovePlan[] {
	return group.versions.map((versionFile) => {
		const filename = versionFile.file.name;
		return {
			file: versionFile.file,
			from: versionFile.file.path,
			to: normalizePath(
				destinationFolder
					? `${destinationFolder}/${filename}`
					: filename,
			),
		};
	});
}
