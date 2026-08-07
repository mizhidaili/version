import { App, TFile } from 'obsidian';

interface FileRecoveryInstance {
	openModal?: (path: string) => unknown;
}

interface InternalPluginWrapper {
	enabled?: boolean;
	instance?: FileRecoveryInstance;
}

interface AppWithInternalPlugins extends App {
	internalPlugins?: {
		plugins?: Record<string, InternalPluginWrapper | undefined>;
	};
}

/**
 * File Recovery does not currently contribute its "Open version history"
 * command through the public `file-menu` event. Keep this private compatibility
 * bridge isolated and feature-detected: if Obsidian changes the internal shape,
 * Version simply hides the action instead of breaking any file operation.
 */
export function canOpenFileRecoveryHistory(app: App): boolean {
	const wrapper = getFileRecoveryPlugin(app);
	return wrapper?.enabled === true &&
		typeof wrapper.instance?.openModal === 'function';
}

export function openFileRecoveryHistory(app: App, file: TFile): boolean {
	const wrapper = getFileRecoveryPlugin(app);
	const openModal = wrapper?.instance?.openModal;
	if (wrapper?.enabled !== true || typeof openModal !== 'function') {
		return false;
	}
	openModal.call(wrapper.instance, file.path);
	return true;
}

function getFileRecoveryPlugin(app: App): InternalPluginWrapper | undefined {
	return (app as AppWithInternalPlugins).internalPlugins?.plugins?.['file-recovery'];
}
