export class App {}

export class TFile {
	basename: string;
	extension: string;
	name: string;

	constructor(public path: string) {
		this.name = path.split('/').at(-1) ?? path;
		const dot = this.name.lastIndexOf('.');
		this.extension = dot >= 0 ? this.name.slice(dot + 1) : '';
		this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
	}
}

export class Component {
	load(): void {}
	unload(): void {}
	registerDomEvent(): void {}
}

export class Notice {
	constructor(_message: string | DocumentFragment) {}
}

export interface MarkdownRenderCall {
	markdown: string;
	sourcePath: string;
}

export const markdownRenderCalls: MarkdownRenderCall[] = [];

export const MarkdownRenderer = {
	async render(
		_app: App,
		markdown: string,
		_el: HTMLElement,
		sourcePath: string,
		_component: Component,
	): Promise<void> {
		markdownRenderCalls.push({ markdown, sourcePath });
	},
};

export function getLinkpath(linktext: string): string {
	return linktext;
}

export function setIcon(): void {}
