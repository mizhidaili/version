import { App, Modal, Notice, Setting, TextComponent } from 'obsidian';
import { VersionI18n } from '../i18n';

export class CreateVersionModal extends Modal {
	private filename = '';
	private submitting = false;

	constructor(
		app: App,
		private readonly version: number,
		defaultFilename: string,
		private readonly fillsGap: boolean,
		private readonly onCreate: (filename: string) => Promise<boolean>,
		private readonly i18n: VersionI18n,
	) {
		super(app);
		this.filename = defaultFilename;
	}

	onOpen(): void {
		this.setTitle(this.i18n.t('create.title', { version: this.version }));
		this.contentEl.createEl('p', {
			cls: 'version-create-description',
			text: this.i18n.t('create.description'),
		});
		if (this.fillsGap) {
			this.contentEl.createEl('p', {
				cls: 'version-create-warning',
				text: this.i18n.t('create.gapWarning', {
					version: this.version,
				}),
			});
		}

		let filenameInput: TextComponent | null = null;
		new Setting(this.contentEl)
			.setName(this.i18n.t('create.filename'))
			.setDesc(this.i18n.t('create.filenameDescription'))
			.addText((text) => {
				filenameInput = text;
				text
					.setValue(this.filename)
					.onChange((value) => {
						this.filename = value;
					});
			});

		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText(this.i18n.t('common.cancel'))
					.onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(this.i18n.t('create.confirm', {
						version: this.version,
					}))
					.setCta()
					.onClick(() => void this.submit()),
			);

		this.contentEl.win.setTimeout(() => filenameInput?.inputEl.select(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		if (this.submitting) {
			return;
		}
		const filename = normalizeFilename(this.filename);
		if (!filename) {
			new Notice(this.i18n.t('create.invalidFilename'));
			return;
		}

		this.submitting = true;
		try {
			if (await this.onCreate(filename)) {
				this.close();
			}
		} finally {
			this.submitting = false;
		}
	}
}

function normalizeFilename(value: string): string | null {
	const filename = value.trim();
	if (!filename || /[/\\\n\r]/u.test(filename)) {
		return null;
	}
	return filename.toLocaleLowerCase().endsWith('.md')
		? filename.slice(0, -3)
		: filename;
}
