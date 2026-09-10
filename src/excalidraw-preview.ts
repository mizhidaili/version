import { App, TFile } from 'obsidian';
import {
	isExcalidrawVersionFile,
	isMarkdownVersionFile,
} from './version-file-types';

interface InternalPluginRegistry {
	enabledPlugins?: {
		has(pluginId: string): boolean;
	};
}

interface ExcalidrawAutomateInstance {
	createSVG(
		templatePath?: string,
		embedFont?: boolean,
	): Promise<unknown>;
	destroy(): void;
}

interface ExcalidrawAutomateFactory {
	getAPI(): ExcalidrawAutomateInstance;
}

interface ExcalidrawGlobal {
	ExcalidrawAutomate?: unknown;
}

const EXCALIDRAW_PLUGIN_ID = 'obsidian-excalidraw-plugin';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EXCALIDRAW_FRONTMATTER =
	/^(?:"excalidraw-plugin"|'excalidraw-plugin'|excalidraw-plugin)[ \t]*:[ \t]*(?:"(?:locked|parsed|raw)"|'(?:locked|parsed|raw)'|(?:locked|parsed|raw))(?:[ \t]+#.*)?[ \t]*$/u;

/**
 * Decide whether a Version hover preview should use Excalidraw's SVG API.
 * Explicit Excalidraw suffixes remain authoritative. An ordinary `.md` file is
 * promoted only when its opening root frontmatter carries Excalidraw's official
 * plugin flag, so prose and pasted format examples continue through the normal
 * Markdown renderer.
 */
export function isExcalidrawPreviewSource(
	file: TFile,
	source: string,
): boolean {
	if (isExcalidrawVersionFile(file)) {
		return true;
	}
	return isMarkdownVersionFile(file) && hasExcalidrawFrontmatter(source);
}

/**
 * Renders an existing drawing through Excalidraw's documented Automate API.
 * The returned node is detached and can be adopted by the preview document.
 */
export async function createExcalidrawPreviewSvg(
	app: App,
	file: TFile,
	hostWindow: Window,
): Promise<SVGSVGElement | null> {
	if (!isExcalidrawPluginEnabled(app)) {
		return null;
	}

	const factory = getExcalidrawAutomateFactory(hostWindow);
	if (!factory) {
		return null;
	}

	let automate: ExcalidrawAutomateInstance | null = null;
	try {
		automate = factory.getAPI();
		if (!isExcalidrawAutomateInstance(automate)) {
			return null;
		}
		const svg = await automate.createSVG(file.path, false);
		return isSvgElement(svg) ? svg : null;
	} catch {
		return null;
	} finally {
		try {
			automate?.destroy();
		} catch {
			// Preview cleanup must not hide an otherwise valid SVG or affect files.
		}
	}
}

function isExcalidrawPluginEnabled(app: App): boolean {
	const registry = (app as App & { plugins?: InternalPluginRegistry }).plugins;
	return registry?.enabledPlugins?.has(EXCALIDRAW_PLUGIN_ID) === true;
}

function getExcalidrawAutomateFactory(
	hostWindow: Window,
): ExcalidrawAutomateFactory | null {
	const value = (hostWindow as Window & ExcalidrawGlobal).ExcalidrawAutomate;
	return isExcalidrawAutomateFactory(value) ? value : null;
}

function isExcalidrawAutomateFactory(
	value: unknown,
): value is ExcalidrawAutomateFactory {
	return typeof value === 'object' &&
		value !== null &&
		'getAPI' in value &&
		typeof value.getAPI === 'function';
}

function isExcalidrawAutomateInstance(
	value: unknown,
): value is ExcalidrawAutomateInstance {
	return typeof value === 'object' &&
		value !== null &&
		'createSVG' in value &&
		typeof value.createSVG === 'function' &&
		'destroy' in value &&
		typeof value.destroy === 'function';
}

function isSvgElement(value: unknown): value is SVGSVGElement {
	return typeof value === 'object' &&
		value !== null &&
		'namespaceURI' in value &&
		value.namespaceURI === SVG_NAMESPACE &&
		'localName' in value &&
		value.localName === 'svg';
}

function hasExcalidrawFrontmatter(source: string): boolean {
	const lines = splitSourceLines(source);
	if (lines[0]?.trim() !== '---') {
		return false;
	}
	let found = false;
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === '---' || line.trim() === '...') {
			return found;
		}
		if (EXCALIDRAW_FRONTMATTER.test(line)) {
			found = true;
		}
	}
	return false;
}

function splitSourceLines(source: string): string[] {
	return source.replace(/^\uFEFF/u, '').split(/\r?\n/u);
}
