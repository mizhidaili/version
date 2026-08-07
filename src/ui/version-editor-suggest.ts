import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from 'obsidian';
import { VersionI18n } from '../i18n';
import { VersionGroup, VersionIndex } from '../version-index';
import {
	renderThemeSuggestion,
	VersionChoiceModal,
	VersionLinkChoice,
} from './version-link-modal';

type LinkSuggestion =
	| {
			group: VersionGroup;
			kind: 'theme';
	  }
	| {
			file: TFile;
			kind: 'file';
	  };

export class VersionEditorSuggest extends EditorSuggest<LinkSuggestion> {
	constructor(
		app: App,
		private readonly index: VersionIndex,
		private readonly i18n: VersionI18n,
	) {
		super(app);
		this.limit = 50;
		this.refreshLanguage();
	}

	refreshLanguage(): void {
		this.setInstructions([
			{ command: '↑↓', purpose: this.i18n.t('editor.navigate') },
			{ command: '↵', purpose: this.i18n.t('editor.select') },
			{ command: 'esc', purpose: this.i18n.t('editor.dismiss') },
		]);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		if (!file) {
			return null;
		}

		const beforeCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
		const opening = beforeCursor.lastIndexOf('[[');
		if (opening < 0 || beforeCursor[opening - 1] === '\\') {
			return null;
		}

		const query = beforeCursor.slice(opening + 2);
		if (/[\]#^|\n]/u.test(query)) {
			return null;
		}

		const afterCursor = editor.getLine(cursor.line).slice(cursor.ch);
		const end = afterCursor.startsWith(']]')
			? { line: cursor.line, ch: cursor.ch + 2 }
			: cursor;

		return {
			start: { line: cursor.line, ch: opening },
			end,
			query,
		};
	}

	getSuggestions(context: EditorSuggestContext): LinkSuggestion[] {
		const query = context.query.trim().toLocaleLowerCase();
		const matches = (name: string, path = '') =>
			!query ||
			name.toLocaleLowerCase().includes(query) ||
			path.toLocaleLowerCase().includes(query);

		const themes: LinkSuggestion[] = this.index
			.getGroups()
			.filter((group) => matches(group.topic, group.folder))
			.map((group) => ({ kind: 'theme', group }));

		const files: LinkSuggestion[] = this.app.vault
			.getMarkdownFiles()
			.filter((file) => {
				const group = this.index.getGroupForFile(file);
				return !group || group.status !== 'healthy';
			})
			.filter((file) => matches(file.basename, file.path))
			.sort((left, right) => left.path.localeCompare(right.path))
			.map((file) => ({ kind: 'file', file }));

		return [...themes, ...files].slice(0, this.limit);
	}

	renderSuggestion(suggestion: LinkSuggestion, el: HTMLElement): void {
		if (suggestion.kind === 'theme') {
			renderThemeSuggestion(suggestion.group, el);
			return;
		}

		el.createDiv({
			cls: 'version-theme-suggestion-name',
			text: suggestion.file.basename,
		});
		const folder =
			suggestion.file.parent?.path === '/'
				? ''
				: suggestion.file.parent?.path;
		if (folder) {
			el.createDiv({
				cls: 'version-theme-suggestion-folder',
				text: folder,
			});
		}
	}

	selectSuggestion(
		suggestion: LinkSuggestion,
		_event: MouseEvent | KeyboardEvent,
	): void {
		const context = this.context;
		if (!context) {
			return;
		}

		const { editor, file, start, end } = context;
		if (suggestion.kind === 'file') {
			const link = this.app.fileManager.generateMarkdownLink(
				suggestion.file,
				file.path,
			);
			editor.replaceRange(link, start, end);
			this.close();
			return;
		}

		const group = suggestion.group;
		this.close();
		new VersionChoiceModal(
			this.app,
			group,
			(choice: VersionLinkChoice) => {
				const link = this.app.fileManager.generateMarkdownLink(
					choice.file,
					file.path,
					undefined,
					choice.alias,
				);
				editor.replaceRange(link, start, end);
			},
			this.i18n,
		).open();
	}
}
