import { App, Modal, Notice, Setting, TextComponent } from 'obsidian';
import { VersionI18n } from '../i18n';
import {
	isVersionFileFormat,
	stripVersionFileSuffix,
	type VersionFileFormat,
} from '../version-file-creation';

export class CreateVersionModal extends Modal {
	private filename = '';
	private format: VersionFileFormat;
	private submitting = false;

	constructor(
		app: App,
		private readonly version: number,
		defaultFilename: string,
		defaultFormat: VersionFileFormat,
		private readonly fillsGap: boolean,
		private readonly onCreate: (
			filename: string,
			format: VersionFileFormat,
		) => Promise<boolean>,
		private readonly i18n: VersionI18n,
	) {
		super(app);
		this.filename = defaultFilename;
		this.format = defaultFormat;
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

		new Setting(this.contentEl)
			.setName(this.i18n.t('create.format'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('markdown', this.i18n.t('create.formatMarkdown'))
					.addOption('canvas', this.i18n.t('create.formatCanvas'))
					.addOption('excalidraw', this.i18n.t('create.formatExcalidraw'))
					.setValue(this.format)
					.onChange((value) => {
						if (isVersionFileFormat(value)) {
							this.format = value;
						}
					}),
			);

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
			if (await this.onCreate(filename, this.format)) {
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
	const stem = stripVersionFileSuffix(filename).trim();
	return stem.length > 0 ? stem : null;
}
