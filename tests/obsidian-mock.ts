export class TFile {
	basename: string;
	extension: string;
	name: string;
	parent: { isRoot(): boolean; path: string };
	stat: { ctime: number; mtime: number; size: number };
	private static nextCtime = 1;

	constructor(public path: string) {
		this.stat = {
			ctime: TFile.nextCtime++,
			mtime: 0,
			size: 0,
		};
		this.basename = '';
		this.extension = '';
		this.name = '';
		this.parent = { isRoot: () => true, path: '/' };
		this.setPath(path);
	}

	setPath(path: string): void {
		this.path = path;
		this.name = path.split('/').at(-1) ?? path;
		const dot = this.name.lastIndexOf('.');
		this.extension = dot >= 0 ? this.name.slice(dot + 1) : '';
		this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
		const parentPath = path.includes('/')
			? path.slice(0, path.lastIndexOf('/'))
			: '';
		this.parent = {
			isRoot: () => !parentPath,
			path: parentPath || '/',
		};
	}
}

export class TFolder {
	constructor(
		public path = '/',
		public name = path.split('/').at(-1) ?? path,
	) {}

	isRoot(): boolean {
		return this.path === '/';
	}
}

export class App {}

export class Scope {
	constructor(public readonly parent?: Scope) {}

	register(
		modifiers: string[] | null,
		key: string | null,
		func: (event: KeyboardEvent, context: unknown) => false | unknown,
	): { func: typeof func; key: string | null; modifiers: string[] | null; scope: Scope } {
		return { func, key, modifiers, scope: this };
	}
}

export class Component {
	load(): void {}
	unload(): void {}
	registerDomEvent(): void {}
}

export class Menu extends Component {
	close(): void {}
}

export class Modal {
	app: App;
	closeCalls = 0;
	scope: Scope;

	constructor(app: App) {
		this.app = app;
		this.scope = new Scope();
	}

	close(): void {
		this.closeCalls += 1;
	}
}

export const MarkdownRenderer = {
	async render(): Promise<void> {},
};

export function getLinkpath(linktext: string): string {
	return linktext;
}

export function setIcon(): void {}

export class Vault {
	private readonly contents = new Map<string, string>();
	private readonly files = new Map<string, TFile>();

	constructor(paths: string[] = []) {
		for (const path of paths) {
			this.add(path);
		}
	}

	add(path: string, content = ''): TFile {
		const file = new TFile(path);
		this.files.set(path, file);
		this.contents.set(path, content);
		return file;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.contents.get(file.path) ?? '';
	}

	async read(file: TFile): Promise<string> {
		return this.contents.get(file.path) ?? '';
	}

	modify(file: TFile, content: string): void {
		this.contents.set(file.path, content);
		file.stat.mtime += 1;
		file.stat.size = content.length;
	}

	async create(path: string, content: string): Promise<TFile> {
		return this.add(path, content);
	}

	delete(pathOrFile: string | TFile): void {
		const path = typeof pathOrFile === 'string' ? pathOrFile : pathOrFile.path;
		this.files.delete(path);
		this.contents.delete(path);
	}

	getFileByPath(path: string): TFile | null {
		return this.files.get(path) ?? null;
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.getFileByPath(path);
	}

	rename(oldPath: string, newPath: string): TFile {
		const content = this.contents.get(oldPath) ?? '';
		const file = this.files.get(oldPath) ?? new TFile(oldPath);
		this.files.delete(oldPath);
		this.contents.delete(oldPath);
		file.setPath(newPath);
		this.files.set(newPath, file);
		this.contents.set(newPath, content);
		return file;
	}
}

export class Notice {
	constructor(_message: string | DocumentFragment) {}
}

export function normalizePath(path: string): string {
	return path.replaceAll('\\', '/').replace(/\/{2,}/gu, '/').replace(/^\.\//u, '');
}
