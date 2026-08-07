interface FileNameParts {
	basename: string;
	extension: string;
	name: string;
}

const EXCALIDRAW_MARKDOWN_SUFFIX = '.excalidraw.md';

export function buildCopyFilename(file: FileNameParts, suffix: number): string {
	const lowerName = file.name.toLocaleLowerCase();
	const isExcalidrawMarkdown = lowerName.endsWith(EXCALIDRAW_MARKDOWN_SUFFIX);
	const stem = isExcalidrawMarkdown
		? file.name.slice(0, -EXCALIDRAW_MARKDOWN_SUFFIX.length)
		: file.basename;
	const extension = isExcalidrawMarkdown
		? file.name.slice(-EXCALIDRAW_MARKDOWN_SUFFIX.length)
		: file.extension ? `.${file.extension}` : '';
	const copyMarker = suffix === 1 ? ' copy' : ` copy ${suffix}`;
	return `${stem}${copyMarker}${extension}`;
}
