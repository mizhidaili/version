import { App, Menu, TFile } from 'obsidian';

interface InternalPluginWrapper {
	enabled?: boolean;
	instance?: unknown;
}

interface InternalPlugins {
	plugins?: Record<string, InternalPluginWrapper | undefined>;
}

interface AppWithInternalPlugins extends App {
	internalPlugins?: InternalPlugins;
}

interface NoteComposerInstance {
	mergeFile?: (
		target: TFile,
		source: TFile,
		mode?: 'append' | 'prepend',
	) => Promise<void> | void;
	onFileMenu?: (menu: Menu, file: TFile, source: string) => void;
}

interface InternalMenuItem {
	callback?: (event: MouseEvent | KeyboardEvent) => unknown;
	dom?: HTMLElement;
	section?: string;
	title?: string | DocumentFragment;
}

interface MenuWithItems extends Menu {
	items?: InternalMenuItem[];
}

export function canMergeWithNoteComposer(app: App, file: TFile): boolean {
	return file.extension.toLocaleLowerCase() === 'md' &&
		getNoteComposer(app)?.mergeFile !== undefined;
}

export async function mergeWithNoteComposer(
	app: App,
	target: TFile,
	source: TFile,
): Promise<void> {
	const composer = getNoteComposer(app);
	if (!composer?.mergeFile) {
		throw new Error('Note Composer is not available.');
	}
	await composer.mergeFile(target, source, 'append');
}

/**
 * Note Composer exposes no public merge API or target-provider hook. Keep the
 * feature detection and the one private call in this small fail-open adapter.
 */
export function replaceNoteComposerMenuAction(
	app: App,
	menu: Menu,
	file: TFile,
	onClick: () => void,
): boolean {
	const composer = getNoteComposer(app);
	if (!composer?.onFileMenu || !composer.mergeFile || file.extension !== 'md') {
		return false;
	}

	const probe = new Menu() as MenuWithItems;
	composer.onFileMenu(probe, file, 'version-note-composer-probe');
	const probeItem = probe.items?.find((item) =>
		item.section === 'action' && getMenuItemTitle(item) !== null);
	const title = probeItem ? getMenuItemTitle(probeItem) : null;
	if (!title) {
		return false;
	}

	const internal = menu as MenuWithItems;
	let removedOriginal = false;
	if (internal.items) {
		for (let index = internal.items.length - 1; index >= 0; index -= 1) {
			const item = internal.items[index];
			if (item.section === 'action' && getMenuItemTitle(item) === title) {
				item.dom?.remove();
				internal.items.splice(index, 1);
				removedOriginal = true;
			}
		}
	}
	if (!removedOriginal) {
		return false;
	}

	menu.addItem((item) => item
		.setSection('action')
		.setTitle(title)
		.setIcon('git-merge')
		.onClick(onClick));
	return true;
}

function getNoteComposer(app: App): NoteComposerInstance | null {
	const wrapper = (app as AppWithInternalPlugins).internalPlugins
		?.plugins?.['note-composer'];
	if (!wrapper?.enabled || !isNoteComposerInstance(wrapper.instance)) {
		return null;
	}
	return wrapper.instance;
}

function isNoteComposerInstance(value: unknown): value is NoteComposerInstance {
	return typeof value === 'object' && value !== null;
}

function getMenuItemTitle(item: InternalMenuItem): string | null {
	if (typeof item.title === 'string') {
		return item.title;
	}
	if (item.title instanceof DocumentFragment) {
		return item.title.textContent;
	}
	return item.dom?.textContent?.trim() || null;
}
