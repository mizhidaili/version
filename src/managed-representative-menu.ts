import type { Menu } from 'obsidian';

const VERSION_SECTIONS = new Set(['version', 'version-group']);

interface InternalMenuItem {
	dom?: {
		remove(): void;
	};
	section?: string;
}

interface InternalMenu {
	dom?: {
		querySelectorAll?(selector: string): Iterable<Element>;
	};
	items?: InternalMenuItem[];
	sections?: string[];
}

/**
 * Every member of a healthy series belongs to one topic-level abstraction.
 * Obsidian exposes no public API for removing entries that core and other
 * plugins have already put in `file-menu`, so keep this private-API adapter
 * small and fail closed: a managed file menu contains only Version-owned,
 * topic-aware actions. This also covers hidden members reached through search,
 * backlinks, or another plugin—not only the visible V1 representative. Exact-
 * file actions remain available through the chooser added after this reset.
 */
export function resetManagedFileMenu(menu: Menu): void {
	menu.setUseNativeMenu(false);
	const internal = menu as Menu & InternalMenu;
	removeItems(internal.items ?? []);
	internal.items?.splice(0);
	internal.sections?.splice(0);
	pruneDom(internal);
}

/**
 * Event listeners registered after Version can still append native-looking
 * single-file actions. Run once after the synchronous `file-menu` dispatch so
 * those late entries cannot bypass the exact-version chooser.
 */
export function pruneManagedFileMenu(menu: Menu): void {
	menu.setUseNativeMenu(false);
	const internal = menu as Menu & InternalMenu;
	if (internal.items) {
		const retained = internal.items.filter((item) =>
			item.section !== undefined && VERSION_SECTIONS.has(item.section));
		removeItems(internal.items.filter((item) => !retained.includes(item)));
		internal.items.splice(0, internal.items.length, ...retained);
	}
	if (internal.sections) {
		const retainedSections = internal.sections.filter((section) =>
			VERSION_SECTIONS.has(section));
		internal.sections.splice(
			0,
			internal.sections.length,
			...Array.from(new Set(retainedSections)),
		);
	}
	pruneDom(internal);
}

export function scheduleManagedFileMenuPrune(menu: Menu): number {
	return window.setTimeout(() => pruneManagedFileMenu(menu), 0);
}

function removeItems(items: InternalMenuItem[]): void {
	for (const item of items) {
		item.dom?.remove();
	}
}

function pruneDom(menu: InternalMenu): void {
	const root = menu.dom;
	if (!root?.querySelectorAll) {
		return;
	}

	for (const item of root.querySelectorAll('.menu-item')) {
		if (
			item.instanceOf(HTMLElement) &&
			!VERSION_SECTIONS.has(item.dataset.section ?? '')
		) {
			item.remove();
		}
	}
	for (const separator of root.querySelectorAll('.menu-separator')) {
		separator.remove();
	}
	for (const group of root.querySelectorAll('.menu-group')) {
		if (group.instanceOf(HTMLElement) && !group.querySelector('.menu-item')) {
			group.remove();
		}
	}
}
