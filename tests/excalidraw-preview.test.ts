import assert from 'node:assert/strict';
import {
	App,
	markdownRenderCalls,
	TFile,
} from 'obsidian';
import {
	createExcalidrawPreviewSvg,
	isExcalidrawPreviewSource,
} from '../src/excalidraw-preview';
import { VersionNotePreview } from '../src/ui/note-preview';

interface TestExcalidrawGlobal {
	ExcalidrawAutomate?: unknown;
}

const pluginId = 'obsidian-excalidraw-plugin';
const testWindow = {} as Window & TestExcalidrawGlobal;
const drawing = new TFile('Drawings/Preview.excalidraw.md');
const ordinaryNamedDrawing = new TFile('Drawings/Preview.md');
const ordinaryDrawingSource = [
	'---',
	'',
	'excalidraw-plugin: parsed',
	'tags: [excalidraw]',
	'---',
	'',
	'# Excalidraw Data',
	'',
	'## Drawing',
	'```compressed-json',
	'N4IgZglgNgpgziAXAbVAOwJYBsCmAvkA',
	'```',
].join('\n');
const serializedDataOnlySource = [
	'# Excalidraw Data',
	'',
	'## Drawing',
	'```compressed-json',
	'N4IgZglgNgpgziAXAbVAOwJYBsCmAvkA',
	'```',
].join('\n');
const ordinaryMarkdownSource = [
	'# Ordinary Markdown',
	'',
	'This article mentions `excalidraw-plugin: parsed` in prose.',
	'',
	'# Excalidraw Data',
	'',
	'## Drawing',
	'```json',
	'{"type":"article","body":"not a drawing"}',
	'```',
].join('\n');
const fencedFormatExampleSource = [
	'# Excalidraw format documentation',
	'',
	'````markdown',
	'---',
	'excalidraw-plugin: parsed',
	'---',
	'# Excalidraw Data',
	'## Drawing',
	'```json',
	'{"type":"excalidraw"}',
	'```',
	'````',
].join('\n');

export async function runExcalidrawPreviewTests(): Promise<void> {
	let assertions = 0;

	assert.equal(
		isExcalidrawPreviewSource(ordinaryNamedDrawing, ordinaryDrawingSource),
		true,
		'an ordinary .md with official Excalidraw frontmatter is a drawing preview',
	);
	assert.equal(
		isExcalidrawPreviewSource(
			new TFile('Drawings/Serialized data only.md'),
			serializedDataOnlySource,
		),
		false,
		'serialized drawing headings without root frontmatter remain ordinary Markdown',
	);
	for (const value of ['raw', 'locked', '"parsed"']) {
		assert.equal(
			isExcalidrawPreviewSource(
				ordinaryNamedDrawing,
				`---\nexcalidraw-plugin: ${value}\n---\n`,
			),
			true,
			`the official ${value} frontmatter state is recognized`,
		);
	}
	assert.equal(
		isExcalidrawPreviewSource(ordinaryNamedDrawing, ordinaryMarkdownSource),
		false,
		'headings and prose mentions without an Excalidraw payload remain ordinary Markdown',
	);
	assert.equal(
		isExcalidrawPreviewSource(ordinaryNamedDrawing, fencedFormatExampleSource),
		false,
		'an ordinary Markdown code example containing official markers is not a drawing',
	);
	assert.equal(
		isExcalidrawPreviewSource(
			ordinaryNamedDrawing,
			'---\ntags: [excalidraw]\n---\n# Tagged note',
		),
		false,
		'the generic excalidraw tag alone does not promote an ordinary note',
	);
	assert.equal(
		isExcalidrawPreviewSource(
			ordinaryNamedDrawing,
			'---\nexcalidraw-plugin: false\n---\n',
		),
		false,
		'an unknown frontmatter value does not acquire drawing identity',
	);
	assertions += 9;

	{
		const svg = {
			localName: 'svg',
			namespaceURI: 'http://www.w3.org/2000/svg',
		} as SVGSVGElement;
		const createCalls: unknown[][] = [];
		let destroyCalls = 0;
		testWindow.ExcalidrawAutomate = {
			getAPI: () => ({
				createSVG: async (...args: unknown[]) => {
					createCalls.push(args);
					return svg;
				},
				destroy: () => {
					destroyCalls += 1;
				},
			}),
		};

		assert.equal(
			await createExcalidrawPreviewSvg(makeApp(true), drawing, testWindow),
			svg,
		);
		assert.deepEqual(createCalls, [[drawing.path, false]]);
		assert.equal(destroyCalls, 1);
		assertions += 3;
	}

	{
		let apiCalls = 0;
		testWindow.ExcalidrawAutomate = {
			getAPI: () => {
				apiCalls += 1;
				throw new Error('must not run while disabled');
			},
		};
		assert.equal(
			await createExcalidrawPreviewSvg(makeApp(false), drawing, testWindow),
			null,
		);
		assert.equal(apiCalls, 0);
		assertions += 2;
	}

	{
		let destroyCalls = 0;
		testWindow.ExcalidrawAutomate = {
			getAPI: () => ({
				createSVG: async () => {
					throw new Error('render failed');
				},
				destroy: () => {
					destroyCalls += 1;
				},
			}),
		};
		assert.equal(
			await createExcalidrawPreviewSvg(makeApp(true), drawing, testWindow),
			null,
		);
		assert.equal(destroyCalls, 1);
		assertions += 2;
	}

	{
		testWindow.ExcalidrawAutomate = {
			getAPI: () => ({
				createSVG: async () => ({
					localName: 'div',
					namespaceURI: 'http://www.w3.org/1999/xhtml',
				}),
				destroy: () => undefined,
			}),
		};
		assert.equal(
			await createExcalidrawPreviewSvg(makeApp(true), drawing, testWindow),
			null,
		);
		assertions += 1;
	}

	{
		delete testWindow.ExcalidrawAutomate;
		assert.equal(
			await createExcalidrawPreviewSvg(makeApp(true), drawing, testWindow),
			null,
		);
		assertions += 1;
	}

	{
		markdownRenderCalls.length = 0;
		const svg = makeSvg();
		let apiCalls = 0;
		testWindow.ExcalidrawAutomate = {
			getAPI: () => {
				apiCalls += 1;
				return {
					createSVG: async () => svg,
					destroy: () => undefined,
				};
			},
		};
		const { app, root } = makePreviewEnvironment(true, 'drawing source');
		const preview = new VersionNotePreview(app, root, makeI18n());
		preview.load();
		await preview.show(drawing);
		const body = findByClass(root, 'version-note-preview-body');
		const host = findByClass(body, 'version-note-preview-excalidraw');
		assert.equal(apiCalls, 1);
		assert.equal(markdownRenderCalls.length, 0);
		assert.equal(host.children[0], svg);
		assert.ok(svg.classList.contains('version-note-preview-excalidraw-svg'));
		preview.unload();
		assertions += 4;
	}

	{
		markdownRenderCalls.length = 0;
		const svg = makeSvg();
		const createCalls: unknown[][] = [];
		testWindow.ExcalidrawAutomate = {
			getAPI: () => ({
				createSVG: async (...args: unknown[]) => {
					createCalls.push(args);
					return svg;
				},
				destroy: () => undefined,
			}),
		};
		const { app, root } = makePreviewEnvironment(true, ordinaryDrawingSource);
		const preview = new VersionNotePreview(app, root, makeI18n());
		preview.load();
		await preview.show(ordinaryNamedDrawing);
		const body = findByClass(root, 'version-note-preview-body');
		const host = findByClass(body, 'version-note-preview-excalidraw');
		assert.deepEqual(createCalls, [[ordinaryNamedDrawing.path, false]]);
		assert.equal(markdownRenderCalls.length, 0);
		assert.equal(host.children[0], svg);
		preview.unload();
		assertions += 3;
	}

	{
		markdownRenderCalls.length = 0;
		let apiCalls = 0;
		testWindow.ExcalidrawAutomate = {
			getAPI: () => {
				apiCalls += 1;
				throw new Error('Canvas must not call Excalidraw');
			},
		};
		const canvas = new TFile('Boards/Preview.canvas');
		const { app, root } = makePreviewEnvironment(true, '{"nodes":[]}');
		const preview = new VersionNotePreview(app, root, makeI18n());
		preview.load();
		await preview.show(canvas);
		assert.equal(apiCalls, 0);
		assert.deepEqual(markdownRenderCalls, [{
			markdown: '![[Boards/Preview.canvas]]',
			sourcePath: '',
		}]);
		preview.unload();
		assertions += 2;
	}

	{
		markdownRenderCalls.length = 0;
		const markdown = new TFile('Notes/Preview.md');
		let apiCalls = 0;
		testWindow.ExcalidrawAutomate = {
			getAPI: () => {
				apiCalls += 1;
				throw new Error('Ordinary Markdown must not call Excalidraw');
			},
		};
		const { app, root } = makePreviewEnvironment(true, ordinaryMarkdownSource);
		const preview = new VersionNotePreview(app, root, makeI18n());
		preview.load();
		await preview.show(markdown);
		assert.equal(apiCalls, 0);
		assert.deepEqual(markdownRenderCalls, [{
			markdown: ordinaryMarkdownSource,
			sourcePath: markdown.path,
		}]);
		preview.unload();
		assertions += 2;
	}

	{
		markdownRenderCalls.length = 0;
		delete testWindow.ExcalidrawAutomate;
		const { app, root } = makePreviewEnvironment(true, 'raw warning');
		const preview = new VersionNotePreview(app, root, makeI18n());
		preview.load();
		await preview.show(drawing);
		const body = findByClass(root, 'version-note-preview-body');
		const fallback = findByClass(body, 'version-note-preview-empty');
		assert.equal(fallback.text, 'preview.openVisual');
		assert.equal(markdownRenderCalls.length, 0);
		preview.unload();
		assertions += 2;
	}

	console.log(`Excalidraw preview tests passed: ${assertions} assertions`);
}

function makeApp(enabled: boolean): App {
	return {
		plugins: {
			enabledPlugins: {
				has: (id: string) => enabled && id === pluginId,
			},
		},
	} as unknown as App;
}

class FakeClassList {
	private readonly classes = new Set<string>();

	add(...classes: string[]): void {
		for (const cls of classes) {
			this.classes.add(cls);
		}
	}

	contains(cls: string): boolean {
		return this.classes.has(cls);
	}
}

class FakeDocument {
	readonly defaultView = testWindow;

	importNode<T extends Node>(node: T): T {
		return node;
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly classList = new FakeClassList();
	disabled = false;
	isConnected = true;
	text = '';

	constructor(readonly ownerDocument: FakeDocument) {}

	createDiv(options?: string | { cls?: string | string[]; text?: string }): FakeElement {
		return this.createChild(options);
	}

	createEl(
		_tag: string,
		options?: string | { cls?: string | string[]; text?: string },
	): FakeElement {
		return this.createChild(options);
	}

	addEventListener(): void {}

	appendChild(child: FakeElement): FakeElement {
		this.children.push(child);
		return child;
	}

	empty(): void {
		this.children.length = 0;
		this.text = '';
	}

	querySelectorAll<T extends Element>(_selectors: string): T[] {
		return [];
	}

	remove(): void {
		this.isConnected = false;
	}

	setText(text: string): void {
		this.text = text;
	}

	private createChild(
		options?: string | { cls?: string | string[]; text?: string },
	): FakeElement {
		const child = new FakeElement(this.ownerDocument);
		const cls = typeof options === 'string' ? options : options?.cls;
		if (typeof cls === 'string') {
			child.classList.add(...cls.split(' '));
		} else if (cls) {
			child.classList.add(...cls);
		}
		if (typeof options === 'object' && options.text) {
			child.text = options.text;
		}
		this.children.push(child);
		return child;
	}
}

function makePreviewEnvironment(
	enabled: boolean,
	source: string,
): { app: App; root: HTMLElement } {
	const document = new FakeDocument();
	const root = new FakeElement(document);
	const app = makeApp(enabled) as App & {
		fileManager: { generateMarkdownLink(file: TFile): string };
		metadataCache: { getFirstLinkpathDest(): null };
		vault: { cachedRead(file: TFile): Promise<string> };
		workspace: { getLeaf(): { openFile(): Promise<void> } };
	};
	app.vault = { cachedRead: async () => source };
	app.fileManager = {
		generateMarkdownLink: (file: TFile) => `[[${file.path}]]`,
	};
	app.metadataCache = { getFirstLinkpathDest: () => null };
	app.workspace = {
		getLeaf: () => ({ openFile: async () => undefined }),
	};
	return {
		app,
		root: root as unknown as HTMLElement,
	};
}

function makeI18n(): { t(key: string): string } {
	return { t: (key: string) => key };
}

function makeSvg(): SVGSVGElement & FakeElement {
	const svg = new FakeElement(new FakeDocument()) as FakeElement & {
		localName: string;
		namespaceURI: string;
	};
	svg.localName = 'svg';
	svg.namespaceURI = 'http://www.w3.org/2000/svg';
	return svg as SVGSVGElement & FakeElement;
}

function findByClass(root: HTMLElement | FakeElement, cls: string): FakeElement {
	const element = root as unknown as FakeElement;
	if (element.classList.contains(cls)) {
		return element;
	}
	for (const child of element.children) {
		try {
			return findByClass(child, cls);
		} catch {
			// Search the remaining descendants.
		}
	}
	throw new Error(`Missing fake element with class ${cls}`);
}
