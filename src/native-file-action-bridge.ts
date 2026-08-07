import { App, Menu, TFile } from 'obsidian';

/**
 * `file-menu` source used only while Version asks Obsidian and other plugins
 * which actions they contribute for one exact real file.
 *
 * Version's own `file-menu` listener must return immediately for this source.
 * That guard is what prevents the managed representative menu from clearing
 * the temporary menu before the bridge can inspect it.
 */
export const VERSION_NATIVE_FILE_ACTION_SOURCE =
	'version-native-file-actions';

const NATIVE_FILE_ACTION_PROBES = new WeakSet<Menu>();

export function isNativeFileActionProbe(menu: Menu): boolean {
	return NATIVE_FILE_ACTION_PROBES.has(menu);
}

export interface NativeFileAction {
	children: NativeFileAction[];
	disabled: boolean;
	run: ((event: MouseEvent | KeyboardEvent) => unknown) | null;
	section: string;
	title: string;
	warning: boolean;
}

export interface NativeFileActionDescriptor {
	callbackSource?: string;
	hasChildren?: boolean;
	icon?: string;
	section?: string;
	title?: string;
}

interface InternalMenu {
	items?: unknown[];
}

interface InternalMenuItem {
	callback?: (event: MouseEvent | KeyboardEvent) => unknown;
	disabled?: boolean;
	dom?: HTMLElement;
	icon?: string;
	iconEl?: HTMLElement;
	section?: string;
	subMenu?: InternalMenu;
	submenu?: InternalMenu;
	title?: string;
	titleEl?: HTMLElement;
}

/**
 * Collects dynamic actions without ever displaying Obsidian's raw menu.
 *
 * `Menu` and `workspace.trigger` are public API. Reading `Menu.items` is a
 * feature-detected compatibility bridge because Obsidian currently exposes no
 * public way to enumerate actions after a `file-menu` event. If that private
 * shape changes, this function deliberately degrades to an empty list and the
 * Version-owned safe actions remain available.
 */
export function collectNativeFileActions(
	app: App,
	file: TFile,
): NativeFileAction[] {
	const menu = new Menu();
	NATIVE_FILE_ACTION_PROBES.add(menu);
	try {
		// Core plugins such as File Recovery condition their contributions on the
		// real file-explorer source. The WeakSet marker lets Version ignore only
		// this exact in-memory probe without lying to core or third-party plugins
		// about the context in which their action will run.
		app.workspace.trigger(
			'file-menu',
			menu,
			file,
			'file-explorer',
		);
		return extractNativeFileActions(menu);
	} catch {
		return [];
	} finally {
		NATIVE_FILE_ACTION_PROBES.delete(menu);
		menu.close();
	}
}

export function extractNativeFileActions(menu: unknown): NativeFileAction[] {
	const items = getMenuItems(menu);
	if (!items) {
		return [];
	}
	return items.flatMap((item) => extractMenuItem(item, false));
}

/**
 * Obsidian 1.13 may expose Copy path as one submenu or as three flattened
 * Menu.items. Normalize both private shapes into one renderable parent while
 * preserving the order and the original callbacks of every child action.
 */
export function groupCopyPathActions(
	actions: NativeFileAction[],
	parentTitle: string,
): NativeFileAction[] {
	const hasParent = actions.some((action) =>
		action.children.length > 0 &&
		COPY_PATH_PARENT_PATTERN.test(normalizeText(action.title)));
	const flatIndexes = actions
		.map((action, index) => ({ action, index }))
		.filter(({ action }) =>
			action.children.length === 0 &&
			COPY_PATH_VARIANT_PATTERN.test(normalizeText(action.title)))
		.map(({ index }) => index);
	if (flatIndexes.length === 0) {
		return actions;
	}
	const flatIndexSet = new Set(flatIndexes);
	if (hasParent) {
		return actions.filter((_action, index) => !flatIndexSet.has(index));
	}

	const children = actions.filter((_action, index) => flatIndexSet.has(index));
	const grouped: NativeFileAction = {
		children,
		disabled: children.every((child) => child.disabled),
		run: null,
		section: children[0]?.section ?? 'action',
		title: parentTitle,
		warning: children.some((child) => child.warning),
	};
	const firstIndex = flatIndexes[0];
	return actions.flatMap((action, index) => {
		if (index === firstIndex) return [grouped];
		return flatIndexSet.has(index) ? [] : [action];
	});
}

/**
 * Keeps contributions that Version cannot safely reproduce itself while
 * removing native single-file actions for which Version already supplies an
 * explicit, relationship-aware implementation.
 */
export function shouldIncludeNativeFileAction(
	descriptor: NativeFileActionDescriptor,
): boolean {
	const section = normalizeText(descriptor.section ?? '');
	if (BLOCKED_SECTIONS.has(section)) {
		return false;
	}

	// Copy-path and third-party submenus are useful even when their parent uses
	// an otherwise duplicated icon such as Lucide's `copy`.
	if (descriptor.hasChildren) {
		return true;
	}

	const title = normalizeText(descriptor.title ?? '');
	const icon = normalizeText(descriptor.icon ?? '');
	const callbackSource = descriptor.callbackSource ?? '';
	if (BLOCKED_ICON_PATTERN.test(icon)) {
		return false;
	}
	if (BLOCKED_TITLE_PATTERN.test(title)) {
		return false;
	}
	if (BLOCKED_CALLBACK_PATTERN.test(callbackSource)) {
		return false;
	}
	return title.length > 0;
}

function extractMenuItem(
	value: unknown,
	isSubmenuChild: boolean,
): NativeFileAction[] {
	if (!isRecord(value)) {
		return [];
	}
	const item = value as InternalMenuItem;
	const title = getItemTitle(item);
	const submenu = getSubmenu(item);
	const children = getMenuItems(submenu)?.flatMap((child) =>
		extractMenuItem(child, true)) ?? [];
	const callback = typeof item.callback === 'function'
		? item.callback.bind(item)
		: null;
	const descriptor: NativeFileActionDescriptor = {
		callbackSource: item.callback
			? Function.prototype.toString.call(item.callback)
			: '',
		hasChildren: children.length > 0,
		icon: getItemIcon(item),
		section: getItemSection(item),
		title,
	};

	if (!isSubmenuChild && !shouldIncludeNativeFileAction(descriptor)) {
		return [];
	}
	if (!title || (!callback && children.length === 0)) {
		return [];
	}

	return [{
		children,
		disabled: isItemDisabled(item),
		run: callback,
		section: descriptor.section ?? '',
		title,
		warning: item.dom?.classList.contains('is-warning') === true,
	}];
}

function getMenuItems(value: unknown): unknown[] | null {
	if (!isRecord(value)) {
		return null;
	}
	const items = (value as InternalMenu).items;
	return Array.isArray(items) ? items : null;
}

function getSubmenu(item: InternalMenuItem): InternalMenu | null {
	for (const candidate of [item.submenu, item.subMenu]) {
		if (getMenuItems(candidate)) {
			return candidate ?? null;
		}
	}
	return null;
}

function getItemTitle(item: InternalMenuItem): string {
	if (typeof item.title === 'string' && item.title.trim()) {
		return item.title.trim();
	}
	const title = item.titleEl?.textContent?.trim() ??
		item.dom?.querySelector('.menu-item-title')?.textContent?.trim() ?? '';
	return title;
}

function getItemSection(item: InternalMenuItem): string {
	return item.section ?? item.dom?.dataset.section ?? '';
}

function getItemIcon(item: InternalMenuItem): string {
	if (typeof item.icon === 'string') {
		return item.icon;
	}
	const svg = item.iconEl?.querySelector('svg') ??
		item.dom?.querySelector('.menu-item-icon svg');
	if (!svg) {
		return '';
	}
	return [...svg.classList]
		.find((className) => className.startsWith('lucide-')) ?? '';
}

function isItemDisabled(item: InternalMenuItem): boolean {
	return item.disabled === true ||
		item.dom?.classList.contains('is-disabled') === true ||
		item.dom?.getAttribute('aria-disabled') === 'true';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function normalizeText(value: string): string {
	return value
		.normalize('NFKC')
		.toLocaleLowerCase()
		.replace(/[.\u2026‥]+$/gu, '')
		.replace(/\s+/gu, ' ')
		.trim();
}

const COPY_PATH_PARENT_PATTERN = /^(?:copy path|复制路径|パスをコピー|kopiér sti|kopier sti)$/iu;

const COPY_PATH_VARIANT_PATTERN = /(?:obsidian(?:\s+url|-url)|vault.*(?:relative )?path|absolute path|复制.*obsidian.*url|(?:复制.*)?(?:库|仓库).*相对.*路径|基于(?:库|仓库)的?相对路径|复制.*绝对路径|绝对路径|保管庫.*相対.*パス|絶対.*パス|relativ.*sti|absolut.*sti)/iu;

const BLOCKED_SECTIONS = new Set([
	'danger',
	'open',
	'system',
]);

const BLOCKED_ICON_PATTERN = /(?:^|-)\b(?:copy|folder-input|folder-output|git-merge|move|pencil|trash-2?)\b/iu;

// `setCurrentFile(...)` belongs to File Recovery's version-history modal and
// must remain available. Filter only callbacks duplicated by Version's own
// safe file operations; Note Composer is identified by title/icon instead.
const BLOCKED_CALLBACK_PATTERN = /(?:\.vault\.copy\s*\(|vault\.copy\s*\(|showItemInFolder\s*\(|openPath\s*\()/u;

const BLOCKED_TITLE_PATTERN = new RegExp(`^(?:${[
	'create (?:a )?copy',
	'move (?:this )?(?:file|note) to',
	'rename(?: this)?(?: file| note)?',
	'delete(?: this)?(?: file| note)?',
	'merge (?:this |the )?(?:entire )?(?:file|note)(?: with| into)?',
	'open (?:with )?(?:the )?default app(?:lication)?',
	'show in (?:finder|file explorer|system file manager)',
	'new drawing file',
	'create (?:a )?new drawing',
	'新建绘图文件',
	'新しい(?:描画|図面)ファイル',
	'ny tegningsfil',
	'opret (?:en )?ny tegning',
	'创建副本',
	'将(?:该)?(?:文件|笔记)移动到',
	'移动(?:这个)?(?:文件|笔记)',
	'重命名',
	'删除',
	'将(?:该)?笔记合并到',
	'使用默认应用打开',
	'在(?:访达|系统文件管理器)中显示',
	'コピーを作成',
	'(?:ファイル|ノート)を移動',
	'名前を変更',
	'削除',
	'(?:ファイル|ノート)をマージ',
	'opret (?:en )?kopi',
	'flyt (?:fil|note) til',
	'omdøb',
	'slet',
	'flet (?:hele )?(?:filen|noten)',
].join('|')})$`, 'iu');
