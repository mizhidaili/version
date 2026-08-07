import { TFile, Vault } from 'obsidian';

/**
 * Version members are Obsidian note-like files that can be opened in a leaf.
 * Excalidraw commonly uses `.excalidraw.md`, which is covered by `md`; the
 * legacy `.excalidraw` extension is included explicitly.
 */
const VERSIONABLE_EXTENSIONS = new Set(['canvas', 'excalidraw', 'md']);

export function isVersionableFile(file: TFile): boolean {
	return VERSIONABLE_EXTENSIONS.has(file.extension.toLocaleLowerCase());
}

export function getVersionableFiles(vault: Vault): TFile[] {
	return vault.getFiles().filter(isVersionableFile);
}

export function getVersionFileIcon(file: TFile): string {
	switch (file.extension.toLocaleLowerCase()) {
		case 'canvas':
			return 'layout-dashboard';
		case 'excalidraw':
			return 'pencil-ruler';
		default:
			return 'file-text';
	}
}

export function isMarkdownVersionFile(file: TFile): boolean {
	return file.extension.toLocaleLowerCase() === 'md';
}

export function isExcalidrawVersionFile(file: TFile): boolean {
	return file.extension.toLocaleLowerCase() === 'excalidraw' ||
		file.name.toLocaleLowerCase().endsWith('.excalidraw.md');
}
