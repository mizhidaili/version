import {
	App,
	PluginSettingTab,
	Setting,
} from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type VersionPlugin from './main';
import { isVersionLanguage } from './i18n';
import {
	DEFAULT_PLUGIN_DATA,
	isValidFilenameTemplate,
	VersionPluginData,
} from './version-data';

export type VersionSettings = VersionPluginData;
export const DEFAULT_SETTINGS = DEFAULT_PLUGIN_DATA;

type VersionSettingKey =
	| 'filenameTemplate'
	| 'language'
	| 'releasedVersionDestination';

type VersionSettingSection = 'general' | 'versionFiles';

type VersionSettingDefinitionItem<K extends string> = {
	control:
		| {
			key: K;
			options: Record<string, string>;
			type: 'dropdown';
		}
		| {
			key: K;
			placeholder?: string;
			type: 'text';
			validate?: (value: string) => string | void;
		};
	desc?: string | DocumentFragment;
	name: string;
	section: VersionSettingSection;
};

export class VersionSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: VersionPlugin,
	) {
		super(app, plugin);
		this.containerEl.addClass('version-settings-tab');
	}

	getSettingDefinitions(): SettingDefinitionItem<VersionSettingKey>[] {
		const definitions = this.getVersionSettingDefinitions();
		const sections: Array<{
			key: VersionSettingSection;
			title: string;
		}> = [
			{
				key: 'general',
				title: this.plugin.i18n.t('settings.generalHeading'),
			},
			{
				key: 'versionFiles',
				title: this.plugin.i18n.t('settings.versionFilesHeading'),
			},
		];

		return sections.map((section) => ({
			type: 'group',
			heading: section.title,
			cls: 'version-settings-section',
			items: definitions
				.filter((definition) => definition.section === section.key)
				.map((definition) => ({
					name: definition.name,
					desc: definition.desc,
					render: (setting: Setting) => {
						this.renderSetting(setting, definition);
					},
				})),
		}));
	}

	refreshIfVisible(): void {
		if (this.containerEl.isConnected) {
			this.update();
		}
	}

	private getVersionSettingDefinitions(): VersionSettingDefinitionItem<
		VersionSettingKey
	>[] {
		const templateVariables = {
			name: '{{name}}',
			version: '{{version}}',
		};
		return [
			{
				name: this.plugin.i18n.t('settings.language'),
				section: 'general',
				control: {
					key: 'language',
					options: {
						en: this.plugin.i18n.t('settings.english'),
						'zh-CN': this.plugin.i18n.t('settings.chinese'),
						da: this.plugin.i18n.t('settings.danish'),
						ja: this.plugin.i18n.t('settings.japanese'),
					},
					type: 'dropdown',
				},
			},
			{
				name: this.plugin.i18n.t('settings.filenameTemplate'),
				desc: this.plugin.i18n.t(
					'settings.filenameTemplateDescription',
					templateVariables,
				),
				section: 'versionFiles',
				control: {
					key: 'filenameTemplate',
					placeholder: '{{name}} (V{{version}})',
					type: 'text',
					validate: (value) => validateFilenameTemplate(
						value,
						this.plugin.i18n.t('settings.filenameTemplateInvalid'),
					),
				},
			},
			{
				name: this.plugin.i18n.t('settings.releasedVersionDestination'),
				desc: this.plugin.i18n.t(
					'settings.releasedVersionDestinationDescription',
				),
				section: 'versionFiles',
				control: {
					key: 'releasedVersionDestination',
					options: {
						'series-folder': this.plugin.i18n.t(
							'settings.releasedVersionSeriesFolder',
						),
						'vault-root': this.plugin.i18n.t(
							'settings.releasedVersionVaultRoot',
						),
					},
					type: 'dropdown',
				},
			},
		];
	}

	private getVersionControlValue(key: string): unknown {
		if (key === 'language') {
			return this.plugin.settings.language;
		}
		if (key === 'filenameTemplate') {
			return this.plugin.settings.filenameTemplate;
		}
		if (key === 'releasedVersionDestination') {
			return this.plugin.settings.releasedVersionDestination;
		}
		return undefined;
	}

	private async setVersionControlValue(
		key: string,
		value: unknown,
	): Promise<void> {
		if (key === 'language' && isVersionLanguage(value)) {
			await this.plugin.setLanguage(value);
			return;
		}
		if (key === 'filenameTemplate' && typeof value === 'string') {
			await this.plugin.setFilenameTemplate(value);
			return;
		}
		if (
			key === 'releasedVersionDestination' &&
			(value === 'series-folder' || value === 'vault-root')
		) {
			await this.plugin.setReleasedVersionDestination(value);
		}
	}

	private renderSetting(
		setting: Setting,
		definition: VersionSettingDefinitionItem<VersionSettingKey>,
	): void {
		setting.settingEl.addClass('version-settings-card');
		setting.setName(definition.name);
		if (definition.desc) {
			setting.setDesc(definition.desc);
		}

		const { control } = definition;
		if (control.type === 'dropdown') {
			setting.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(control.options)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.getStringControlValue(control.key))
					.onChange(async (value) => {
						await this.setVersionControlValue(control.key, value);
					});
			});
			return;
		}

		setting.addText((text) =>
			text
				.setPlaceholder(control.placeholder ?? '')
				.setValue(this.getStringControlValue(control.key))
				.onChange(async (value) => {
					await this.setVersionControlValue(control.key, value);
				}),
		);
	}

	private getStringControlValue(key: VersionSettingKey): string {
		const value = this.getVersionControlValue(key);
		return typeof value === 'string' ? value : '';
	}
}

function validateFilenameTemplate(
	value: string,
	errorMessage: string,
): string | void {
	if (!isValidFilenameTemplate(value)) {
		return errorMessage;
	}
}
