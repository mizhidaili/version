import { App, Notice, normalizePath } from 'obsidian';
import { VersionI18n } from './i18n';

export function chooseRecoveredMarkdown(
	app: App,
	i18n: VersionI18n,
): void {
	const document = app.workspace.containerEl.doc;
	const input = document.body.createEl('input');
	input.type = 'file';
	input.accept = '.md,text/markdown,text/plain';
	input.hidden = true;
	document.body.appendChild(input);

	const cleanUp = (): void => input.remove();
	input.addEventListener(
		'change',
		() => {
			const file = input.files?.[0];
			if (file) {
				void importRecoveredMarkdown(app, file, i18n);
			}
			cleanUp();
		},
		{ once: true },
	);
	input.addEventListener('cancel', cleanUp, { once: true });
	input.click();
}

export async function importRecoveredMarkdown(
	app: App,
	source: File,
	i18n: VersionI18n,
): Promise<void> {
	if (!source.name.toLocaleLowerCase().endsWith('.md')) {
		new Notice(i18n.t('import.chooseMarkdown'));
		return;
	}

	const basename = source.name.slice(0, -3);
	const targetPath = findRecoveryPath(app, basename);

	try {
		const markdown = await source.text();
		const recovered = await app.vault.create(targetPath, markdown);
		await app.workspace.getLeaf(false).openFile(recovered, {
			active: true,
		});
		new Notice(
			i18n.t('import.success', { path: recovered.path }),
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error);
		new Notice(i18n.t('import.failed', { message }));
	}
}

export function findRecoveryPath(app: App, basename: string): string {
	let suffix = 2;
	while (true) {
		const candidate = normalizePath(`${basename}${suffix}.md`);
		if (!app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}
		suffix += 1;
	}
}
