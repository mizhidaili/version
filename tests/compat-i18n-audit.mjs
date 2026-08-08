import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const pluginRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
const obsidianRoot = path.resolve(pluginRoot, '..', '..');

const expectedPlugins = new Map([
	['dataview', '0.5.68'],
	['obsidian-excalidraw-plugin', '2.26.3'],
	['obsidian-style-settings', '1.0.9'],
]);
const enabledPlugins = JSON.parse(read('.obsidian/community-plugins.json'));
for (const [id, version] of expectedPlugins) {
	const manifest = JSON.parse(read(`.obsidian/plugins/${id}/manifest.json`));
	assert.equal(manifest.id, id, `${id} manifest must be installed`);
	assert.equal(manifest.version, version, `${id} version changed; repeat review`);
	assert.ok(enabledPlugins.includes(id), `${id} must be enabled in the test vault`);
}
const appearance = JSON.parse(read('.obsidian/appearance.json'));
const theme = JSON.parse(read('.obsidian/themes/AnuPpuccin/manifest.json'));
assert.equal(appearance.cssTheme, 'AnuPpuccin');
assert.equal(theme.version, '1.5.0', 'AnuPpuccin changed; repeat review');

const versionCss = readPlugin('styles.css');
assert.doesNotMatch(
	versionCss,
	/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\(/iu,
	'Version CSS must not hard-code colors',
);
const importantRules = versionCss.match(/!important/gu) ?? [];
assert.equal(
	importantRules.length,
	1,
	'Only the scoped pointer-drag cursor override may use !important',
);
assert.match(
	versionCss,
	/\.version-management-modal\.is-pointer-dragging[\s\S]*?cursor:\s*grabbing\s*!important/iu,
);
for (const selector of collectRuleSelectors(versionCss)) {
	assert.match(
		selector,
		/\.version-/u,
		`Version CSS selector must stay scoped: ${selector}`,
	);
}

const installedCss = [
	'.obsidian/plugins/dataview/styles.css',
	'.obsidian/plugins/obsidian-excalidraw-plugin/styles.css',
	'.obsidian/plugins/obsidian-style-settings/styles.css',
	'.obsidian/themes/AnuPpuccin/theme.css',
].map(read).join('\n');
const ownClasses = collectClasses(versionCss).filter((name) =>
	name.startsWith('version-'),
);
const installedClasses = new Set(collectClasses(installedCss));
const collisions = ownClasses.filter((name) => installedClasses.has(name));
assert.deepEqual(
	[...new Set(collisions)],
	[],
	'Version-prefixed classes must not collide with reviewed plugins/theme',
);

const fileTypes = readPlugin('src/version-file-types.ts');
assert.match(fileTypes, /new Set\(\['canvas', 'excalidraw', 'md'\]\)/u);
const viewDecorator = readPlugin('src/ui/version-view-decorator.ts');
assert.match(viewDecorator, /viewType === 'canvas'/u);
assert.match(viewDecorator, /includes\('excalidraw'\)/u);
assert.match(
	viewDecorator,
	/version-view-type-canvas[\s\S]*?version-view-type-excalidraw/u,
	'Visual editor controls must expose stable, Version-owned CSS hooks',
);
assert.match(
	viewDecorator,
	/existing\.tabsEl\.isConnected[\s\S]*?view\.contentEl\.contains\(existing\.tabsEl\)/u,
	'Version controls must be recreated after a third-party view replaces its DOM',
);
assert.match(
	viewDecorator,
	/existing\.isConnected[\s\S]*?view\.containerEl\.contains\(existing\)/u,
	'Standalone actions must be recreated after a third-party view replaces its toolbar',
);
assert.match(
	viewDecorator,
	/canUpdateInPlace[\s\S]*?this\.updateVersionButton[\s\S]*?return;/u,
	'Repeated compatibility refreshes must preserve stable version-tab nodes',
);
assert.match(
	versionCss,
	/\.version-view-content\.version-view-type-canvas,\s*\n\.version-view-content\.version-view-type-excalidraw\s*\{[\s\S]*?--version-visual-rail-gutter/u,
	'Visual editors must share the same horizontal native-tool gutter',
);
assert.doesNotMatch(
	versionCss,
	/version-view-type-canvas \.version-tabs-shell/u,
	'Canvas must inherit the same top-to-bottom rail anchor as Markdown',
);
assert.match(
	versionCss,
	/\.version-view-content\.version-view-type-excalidraw \.version-tabs-shell\s*\{[\s\S]*?38rem[\s\S]*?top:\s*calc\(var\(--size-4-16\) \+ var\(--size-4-4\)\)/u,
	'Excalidraw must retain a narrow-pane fallback that clears its overflowing native toolbar',
);
assert.match(
	versionCss,
	/version-excalidraw-rail-top-aligned[\s\S]*?version-tabs-shell[\s\S]*?top:\s*var\(--size-4-6\)/u,
	'Wide Excalidraw panes must share the regular 24px top anchor',
);
assert.match(
	viewDecorator,
	/EXCALIDRAW_TOP_ALIGNMENT_MIN_WIDTH[\s\S]*?clientWidth\s*>=\s*EXCALIDRAW_TOP_ALIGNMENT_MIN_WIDTH[\s\S]*?EXCALIDRAW_TOP_ALIGNED_CLASS/u,
	'Excalidraw rail clearance must respond to editor-pane width without querying private plugin DOM',
);
assert.match(
	viewDecorator,
	/applyViewTypeClass[\s\S]*?toLocaleLowerCase\(\)[\s\S]*?includes\('excalidraw'\)[\s\S]*?version-view-type-excalidraw/u,
	'Every accepted Excalidraw-compatible view type must receive the visual-editor safety classes',
);
assert.match(
	versionCss,
	/\.version-view-content\.version-view-type-canvas > :not\(\.version-tabs-shell\),[\s\S]*?width:\s*calc\(100% - var\(--version-visual-rail-gutter\)\)/u,
	'Visual editors must reserve a non-intercepting gutter for the version rail',
);
assert.match(
	versionCss,
	/\.version-view-content\s*\{[\s\S]*?--version-tab-face-width:\s*2rem;[\s\S]*?--version-tab-height:\s*6rem;[\s\S]*?--version-tab-hit-width:\s*2\.75rem;/u,
	'The visible rail tabs must remain narrower than their accessible hit targets and taller than both',
);
assert.match(
	versionCss,
	/@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.version-management-drag-handle,[\s\S]*?\.version-management-slot-controls \.clickable-icon,[\s\S]*?\.version-management-delete-slot,[\s\S]*?\.version-management-add-slot[\s\S]*?min-height:\s*2\.75rem;[\s\S]*?min-width:\s*2\.75rem;/u,
	'Version management must expose 44px touch targets without changing the desktop layout',
);
assert.match(
	versionCss,
	/@media \(max-width: 900px\)[\s\S]*?\.version-management-slot-body\s*\{[^}]*overflow:\s*visible;[\s\S]*?\.version-management-slot-body \.version-management-slot-name,[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*normal;/u,
	'iPad-width management cards must wrap filenames instead of requiring horizontal text scrolling',
);
assert.match(
	versionCss,
	/@media \(max-width: 900px\)[\s\S]*?\.version-management-slot-card\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?\.version-management-slot-controls\s*\{[^}]*justify-self:\s*end;/u,
	'iPad-width management controls must use their own row rather than squeezing filenames',
);
assert.match(
	versionCss,
	/\.version-tabs-shell\s*\{[\s\S]*?height:\s*min\([\s\S]*?38rem\);[\s\S]*?pointer-events:\s*none;[\s\S]*?top:\s*var\(--size-4-6\);/u,
	'V1 must start from a fixed upper anchor while the regular rail fits five complete tabs',
);
assert.match(
	versionCss,
	/\.version-tabs-overflow-cue\.is-visible[\s\S]*?\.version-tabs-overflow-cue\.is-up[\s\S]*?\.version-tabs-overflow-cue\.is-down/u,
	'Overflowing rails must expose theme-aware continuation cues in both directions',
);
assert.match(
	viewDecorator,
	/scrollHeight - clientHeight > 1[\s\S]*?scrollUpCueEl\.classList\.toggle[\s\S]*?scrollDownCueEl\.classList\.toggle/u,
	'Rail continuation cues must appear only when more registered versions are off-screen',
);
assert.match(
	versionCss,
	/\.version-view-content \.version-tabs > button\.version-tab::before,[\s\S]*?clip-path:\s*polygon\(0 11%, 100% 0, 100% 100%, 0 89%\);/u,
	'The tab face must use the sketch\'s vertically oriented, symmetric outward trapezoid',
);
assert.match(
	versionCss,
	/\.version-view-content \.version-tabs > button\.version-tab\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?background:\s*transparent;[\s\S]*?background-image:\s*none;[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;/u,
	'Community themes must not expose the rectangular accessible hit target around a trapezoid',
);
assert.match(
	versionCss,
	/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.version-hover-preview\.popover[\s\S]*?animation:\s*none/u,
	'Hover previews must respect reduced-motion preferences',
);
const main = readPlugin('src/main.ts');
const settingsSource = readPlugin('src/settings.ts');
assert.match(
	settingsSource,
	/getSettingDefinitions\(\): SettingDefinitionItem<VersionSettingKey>\[\][\s\S]*?type: 'group'[\s\S]*?cls: 'version-settings-section'/u,
	'Obsidian 1.13 declarative settings must expose the localized grouped layout on first open',
);
assert.match(
	settingsSource,
	/private getVersionSettingDefinitions\(\)[\s\S]*?const definitions = this\.getVersionSettingDefinitions\(\)/u,
	'Setting rows must remain internal to the single grouped renderer',
);
assert.doesNotMatch(
	settingsSource,
	/\bdisplay\(\): void/u,
	'Obsidian 1.13 settings must not retain the bypassed imperative display path',
);
assert.match(
	settingsSource,
	/settings\.generalHeading[\s\S]*?settings\.versionFilesHeading[\s\S]*?version-settings-section/u,
	'Settings must render localized, function-based sections',
);
assert.match(
	settingsSource,
	/heading: section\.title/u,
	'Settings section labels must use Obsidian native declarative headings',
);
assert.match(
	settingsSource,
	/setting\.settingEl\.addClass\('version-settings-card'\)/u,
	'Each declarative setting must remain an Obsidian-native Setting styled as a scoped card',
);
assert.match(
	main,
	/this\.settingTab\s*=\s*new VersionSettingTab[\s\S]*?this\.settingTab\?\.refreshIfVisible\(\)/u,
	'Changing language must refresh the open settings pane from the shared language source',
);
assert.match(
	versionCss,
	/\.version-settings-card\s*\{[\s\S]*?var\(--background-secondary\)[\s\S]*?var\(--background-modifier-border\)/u,
	'Settings cards must inherit Obsidian theme colors',
);
assert.match(
	versionCss,
	/\.version-settings-tab\s*\{[\s\S]*?max-width:\s*none;[\s\S]*?width:\s*100%;/u,
	'Settings must expand with the available Obsidian settings pane instead of staying in a narrow fixed column',
);
assert.match(
	versionCss,
	/\.version-settings-section\s*\{[\s\S]*?width:\s*100%;/u,
	'Each localized settings section must use the full responsive content width',
);
assert.doesNotMatch(
	versionCss,
	/\.version-settings-section\s*\{[^}]*?flex-direction:\s*column;/u,
	'Settings groups must keep Obsidian\'s native group layout instead of overriding it with a stretching flex column',
);
assert.match(
	main,
	/findRegisteredMembership\(oldPath, file\)[\s\S]*?memberMatchesFile\(slot\.member, file\)/u,
	'Rename handling must identify a registered member by stored identity, not path alone',
);
assert.match(
	main,
	/for \(const delay of \[150, 750, 2_000\]\)/u,
	'Community views must receive bounded post-open refresh passes',
);
assert.match(
	main,
	/for \(const timer of this\.delayedUiRefreshTimers\)[\s\S]*?window\.clearTimeout\(timer\)/u,
	'Delayed community-view refresh timers must be cleared',
);
const readme = readPlugin('README.md');
assert.match(
	readme,
	/Show current file in File Explorer[\s\S]*?Show Vn in Version management/u,
	'English documentation must disclose the native reveal boundary and exact Version-owned fallback',
);
assert.match(
	readme,
	/在文件列表中显示当前文件[\s\S]*?在版本管理中显示 Vn/u,
	'Chinese documentation must mirror the native reveal boundary and exact Version-owned fallback',
);
assert.match(
	readme,
	/Version creates no\s+virtual topic file and does not replace member filenames/u,
	'English documentation must preserve real member filenames instead of promising a virtual title',
);
assert.match(
	readme,
	/Version 不创建虚拟主题文件，\s*\n\s*也不替换成员文件名/u,
	'Chinese documentation must preserve real member filenames instead of promising a virtual title',
);
const acceptanceMatrix = readPlugin('docs/acceptance-matrix.md');
assert.match(
	acceptanceMatrix,
	/Supported members are Markdown[\s\S]*?Canvas[\s\S]*?legacy `\.excalidraw`/u,
	'Acceptance evidence must cover every currently supported member type',
);
assert.match(
	acceptanceMatrix,
	/Current `npm test` passes 215 model assertions and 217 keys across four locales/u,
	'Acceptance evidence must not retain obsolete test counts',
);
assert.match(
	acceptanceMatrix,
	/Physical touch\/mobile management workflow \| not verified/u,
	'Emulation evidence must not be overstated as physical mobile acceptance',
);
assert.match(
	acceptanceMatrix,
	/Move a whole series with preflight and best-effort rollback \| partial/u,
	'Best-effort move rollback must not be documented as atomic or fully accepted',
);
assert.match(
	acceptanceMatrix,
	/`minAppVersion: 1\.13\.4` \| done[\s\S]*?Mobile availability \(`isDesktopOnly: false`\) \| partial[\s\S]*?Root open-source license \| done/u,
	'The release matrix must preserve the tested minimum, partial mobile status, and selected license',
);
for (const boundary of [
	'Reveal a hidden V2+ row in the native File Explorer',
	'Reliably replace or outrank the core `[[` suggester',
	'Clone every native/third-party menu item for a hidden member',
]) {
	assert.match(
		acceptanceMatrix,
		new RegExp(`${escapeRegExp(boundary)} \\| public API limitation`, 'u'),
		`Acceptance matrix must retain public API boundary: ${boundary}`,
	);
}
const notePreview = readPlugin('src/ui/note-preview.ts');
assert.match(notePreview, /endsWith\('\.excalidraw\.md'\)/u);
assert.match(
	notePreview,
	/generateMarkdownLink\(file, ''\)[\s\S]*?renderMarkdown\(file, `!\$\{link\}`, ''\)/u,
	'Canvas and Excalidraw previews must use a real Obsidian embed so their native renderer can participate',
);
const hoverPreview = readPlugin('src/ui/hover-preview.ts');
const showDelay = Number(
	hoverPreview.match(/const SHOW_DELAY_MS = (\d+);/u)?.[1],
);
assert.ok(
	showDelay >= 600 && showDelay <= 700,
	'Top-level Version hover preview delay must stay within the polished 600–700ms range',
);
assert.match(
	hoverPreview,
	/scheduleFile\([\s\S]*?this\.schedule\(\{ file, kind: 'file', label \}, anchorEl\)/u,
	'Every real file in every Version surface must use the same deterministic delayed preview controller',
);
assert.match(
	hoverPreview,
	/version-hover-preview popover hover-popover/u,
	'The deterministic preview must retain Obsidian popover classes and theme variables',
);
const seriesModal = readPlugin('src/ui/version-series-modal.ts');
assert.match(
	seriesModal,
	/if \(this\.allowCreate\) \{[\s\S]*?kind: 'new'/u,
	'Repair-only series selection must be able to omit the dead-end Create choice',
);
const editorSuggest = readPlugin('src/ui/version-editor-suggest.ts');
const versionLinkModal = readPlugin('src/ui/version-link-modal.ts');
assert.match(
	editorSuggest,
	/getGroups\(\)[\s\S]*?kind: 'theme'[\s\S]*?getGroupForFile\(file\)[\s\S]*?group\.status !== 'healthy'/u,
	'Editor link suggestions must expose one healthy-series row and exclude its exact member files from the Version-owned list',
);
assert.match(
	versionLinkModal,
	/version-theme-suggestion-row[\s\S]*?version-count-badge[\s\S]*?group\.versions\.length/u,
	'Grouped link suggestions must show the series count badge beside the V1 topic name',
);
assert.doesNotMatch(
	versionLinkModal,
	/renderThemeSuggestion[\s\S]*?group\.folder/u,
	'Grouped link suggestions must not expose an internal folder label such as 未命名',
);
assert.match(
	seriesModal,
	/filterAllowedSeries\([\s\S]*?this\.allowedSeriesIds/u,
	'Ambiguous repair must be able to show only the relationships that own the path',
);
const fileActions = readPlugin('src/ui/version-file-actions-modal.ts');
const nativeFileActionBridge = readPlugin('src/native-file-action-bridge.ts');
assert.match(
	fileActions,
	/this\.renameTopic \? 'view\.renameTheme' : 'actions\.renameTitle'/u,
	'V1 rename must retain topic semantics through the confirmation dialog',
);
assert.doesNotMatch(
	fileActions,
	/setIcon|VersionNotePreview|version-file-actions-preview/u,
	'Exact-version actions must remain text-only and have no persistent preview pane',
);
assert.match(
	fileActions,
	/nameEl\.addEventListener\('pointerenter'[\s\S]*?hoverPreview\.scheduleFile\(member\.file, nameEl,[\s\S]*?event/u,
	'Only filename text may route each exact file through the shared delayed Version preview',
);
assert.match(
	versionCss,
	/\.version-file-actions-version-name\s*\{[^}]*align-self:\s*flex-start;[^}]*width:\s*fit-content;/u,
	'The exact-version hover target must shrink to the filename text instead of stretching across the row',
);
assert.match(
	fileActions,
	/renderVersions[\s\S]*?hidePreviews\(\)[\s\S]*?versionsEl\.empty\(\)/u,
	'Rebuilding the note column must close any preview anchored to the old rows',
);
assert.doesNotMatch(
	fileActions,
	/await\s+import\('electron'\)/u,
	'Desktop file actions must not use a dynamic Electron import that silently rejects in the CommonJS plugin runtime',
);
assert.match(
	fileActions,
	/getElectronShell\(\)\.openPath\(path\)[\s\S]*?catch \(error\)[\s\S]*?actions\.failed/u,
	'Opening with the default application must invoke Electron shell and surface failures through a localized Notice',
);
assert.match(
	fileActions,
	/getElectronShell\(\)\.showItemInFolder\(path\)[\s\S]*?catch \(error\)[\s\S]*?actions\.failed/u,
	'Revealing a file must invoke Electron shell and surface failures through a localized Notice',
);
assert.doesNotMatch(
	versionCss,
	/\.version-file-actions-layout\s*\{[^}]*preview preview/gu,
	'Responsive exact-version actions must not reserve a deleted preview grid row',
);
assert.match(
	versionCss,
	/\.version-file-actions-list \.version-file-action\s*\{[^}]*justify-content:\s*center;[^}]*text-align:\s*center;/u,
	'Exact-file action labels must remain visually centered',
);
assert.match(
	fileActions,
	/groupCopyPathActions\([\s\S]*?actions\.copyPath[\s\S]*?aria-haspopup[\s\S]*?NATIVE_SUBMENU_OPEN_DELAY_MS[\s\S]*?pointerenter[\s\S]*?pointerleave/u,
	'Copy path variants must render under one delayed hover-expandable parent',
);
assert.match(
	fileActions,
	/ownerDocument\.body\.createDiv\([\s\S]*?version-native-file-action-flyout[\s\S]*?positionNativeActionFlyout/u,
	'Copy path children must use an out-of-flow flyout instead of changing the action-column layout',
);
assert.match(
	versionCss,
	/body > \.version-native-file-action-flyout\s*\{[^}]*position:\s*fixed;[^}]*z-index:/u,
	'Copy path flyout must float beside the parent action and above the modal',
);
assert.match(
	fileActions,
	/ArrowRight[\s\S]*?ArrowDown[\s\S]*?ArrowLeft[\s\S]*?Escape/u,
	'Native-action submenus must expose directional-key and escape navigation',
);
assert.match(
	nativeFileActionBridge,
	/new drawing file[\s\S]*?新建绘图文件/u,
	'Excalidraw new-drawing contributions must be filtered by exact localized title',
);
assert.match(
	fileActions,
	/generalNativeActions[\s\S]*?merge\.action[\s\S]*?copyPathActions[\s\S]*?versionHistoryActions[\s\S]*?actions\.defaultApp[\s\S]*?view\.renameTheme/u,
	'Exact-file actions must follow the native menu grouping order',
);

const fileExplorer = readPlugin('src/ui/file-explorer-decorator.ts');
const deleteVersionsModal = readPlugin('src/ui/delete-versions-modal.ts');
assert.match(fileExplorer, /no public API for hiding individual rows/u);
assert.match(fileExplorer, /const v1Title = titlesByPath\.get\(v1\.path\);[\s\S]*?if \(!v1Title\) \{\s*return;/u);
assert.match(
	fileExplorer,
	/activeGroup\?\.key === group\.key[\s\S]*?v1Title\.addClass\('is-active', 'version-theme-active'\)/u,
	'An active hidden member must mirror Obsidian active feedback onto the visible V1 representative',
);
assert.match(
	fileExplorer,
	/title\.dataset\.path !== activePath[\s\S]*?title\.removeClass\('is-active'\)/u,
	'Mirrored active feedback must be removed without stripping native V1 state',
);
assert.match(
	readPlugin('src/main.ts'),
	/exactVersion[\s\S]*?fileExplorer\.locateVersion[\s\S]*?openVersionManager\(file, group\.id\)/u,
	'Hidden members must expose a visible Version-owned route into their exact relationship slot',
);
assert.match(
	readPlugin('src/ui/version-management-modal.ts'),
	/initialMemberPath[\s\S]*?versionMemberPath[\s\S]*?scrollIntoView[\s\S]*?focus\(\{ preventScroll: true \}\)/u,
	'Version management must visibly locate the exact real member supplied by a menu action',
);
const versionManagementModal = readPlugin('src/ui/version-management-modal.ts');
assert.match(
	versionManagementModal,
	/currentSeries\?\.folder === node\.path[\s\S]*?renderCurrentSeries\(container, entry\.entry\)/u,
	'The managed series representative must be merged into its real folder in the candidate tree',
);
assert.match(
	versionManagementModal,
	/addFolderAncestors\(this\.openFolders, this\.currentSeriesFolder\)[\s\S]*?locateCurrentSeriesInLibrary\(\)[\s\S]*?version-management-current-series-row[\s\S]*?availableEl\.scrollTop/u,
	'Opening version management must expand the current series ancestors and locate its representative inside the library viewport',
);
assert.match(
	versionManagementModal,
	/const count = this\.slots\.length;[\s\S]*?version-management-current-series-count[\s\S]*?text: String\(count\)/u,
	'The managed-series badge must derive from live draft slots so slot deletion and restoration update immediately',
);
assert.doesNotMatch(
	versionManagementModal,
	/kind: 'series'|stageSeriesDestination|commitDraftSeriesMove|seriesDestinationFolder|is-staged-move/u,
	'The current series representative must not expose, stage, or commit whole-series movement from version management',
);
assert.match(
	versionManagementModal,
	/renderAvailableFile[\s\S]*?renderDragHandle[\s\S]*?\{ file, kind: 'file' \}[\s\S]*?dropOnSlot/u,
	'Ordinary files must remain draggable into version slots',
);
assert.doesNotMatch(
	readPlugin('src/main.ts'),
	/\(record, plans\) => this\.moveSeriesFiles\(record\.id, plans, record\)/u,
	'Version management must not receive a whole-series move commit callback',
);
const currentSeriesRowCss = versionCss.match(
	/\.version-management-current-series-row\s*\{([^}]*)\}/u,
)?.[1] ?? '';
assert.match(
	currentSeriesRowCss,
	/border:\s*2px solid var\(--interactive-accent\)/u,
	'The current series representative must use a uniform theme-accent border',
);
assert.match(
	currentSeriesRowCss,
	/box-shadow:\s*none/u,
	'The current series representative must not visually thicken one border edge',
);
assert.doesNotMatch(
	versionCss,
	/\.version-management-current-series-row\.is-staged-move/u,
	'The removed current-series move mode must not leave a staged visual state',
);
assert.match(
	deleteVersionsModal,
	/const initial\s*=\s*this\.group\.versions\.find[\s\S]*?this\.deleteButton\s*=\s*new ButtonComponent[\s\S]*?if \(initial\?\.version !== 1\)[\s\S]*?this\.syncSelectionState\(\)/u,
	'Exact-version delete context must be applied after the dependent CTA exists',
);
assert.doesNotMatch(
	deleteVersionsModal,
	/VersionNotePreview|version-delete-preview|previewTarget/u,
	'Batch trash must not reserve or automatically populate a persistent preview pane',
);
assert.match(
	deleteVersionsModal,
	/nameEl\.addEventListener\('pointerenter'[\s\S]*?hoverPreview\?\.scheduleFile[\s\S]*?event/u,
	'Batch trash preview must be delayed and originate only from filename text',
);
for (const previewOwner of [
	'src/ui/backlinks-modal.ts',
	'src/ui/version-link-modal.ts',
	'src/ui/version-series-modal.ts',
]) {
	assert.doesNotMatch(
		readPlugin(previewOwner),
		/VersionNotePreview|(?:backlinks|link-picker|series-picker|theme-picker)-preview/u,
		`${previewOwner} must use floating hover preview rather than a persistent pane`,
	);
}
assert.doesNotMatch(
	deleteVersionsModal,
	/ToggleComponent|addToggle/u,
	'Destructive file selection must use checkboxes, not settings-style toggles',
);
assert.match(
	deleteVersionsModal,
	/attr: \{ type: 'checkbox' \}[\s\S]*?releaseVersions\(selectedCaptures\)[\s\S]*?trashCapturedVersions/u,
	'Version-owned trashing must release exact registered slots before crossing the trash boundary',
);
const allSource = sourceFiles().map(readPlugin).join('\n');
assert.doesNotMatch(
	allSource,
	/getLeavesOfType\(['"](?:search|switcher|quick-switcher)['"]\)/u,
	'Version must not DOM-patch Search or Quick Switcher',
);

const catalogs = {
	en: readCatalog('src/i18n.ts', 'EN'),
	'zh-CN': readCatalog('src/i18n.ts', 'ZH'),
	da: readCatalog('src/locales/da.ts', 'DA'),
	ja: readCatalog('src/locales/ja.ts', 'JA'),
};
const keyCount = Object.keys(catalogs.en).length;
assert.equal(keyCount, 217);
for (const [language, catalog] of Object.entries(catalogs)) {
	assert.deepEqual(
		Object.keys(catalog).sort(),
		Object.keys(catalogs.en).sort(),
		`${language} key set must match English`,
	);
	assert.equal(
		catalog['actions.delete'],
		catalog['fileExplorer.deleteVersions'],
		`${language} must use one explicit choose-version-files trash label`,
	);
}
const sampledSafety = {
	en: {
		'delete.description': /real file.*trash/iu,
		'manage.deleteSlot': /keep its file/iu,
		'manage.dissolveConfirmDescription': /does not delete or modify any member files/iu,
		'manage.missingPreview': /could not be found.*repair/iu,
		'manage.keyboardPicked': /Enter or Space.*Escape/iu,
	},
	'zh-CN': {
		'delete.description': /真实文件.*废纸篓/u,
		'manage.deleteSlot': /保留文件/u,
		'manage.dissolveConfirmDescription': /不会删除或修改任何成员文件/u,
		'manage.missingPreview': /无法.*找到.*修复/u,
		'manage.keyboardPicked': /Enter.*空格.*Escape/u,
	},
	da: {
		'delete.description': /faktiske fil.*papirkurv/iu,
		'manage.deleteSlot': /behold filen/iu,
		'manage.dissolveConfirmDescription': /sletter eller ændrer ingen medlemsfiler/iu,
		'manage.missingPreview': /ikke fundet.*reparere/iu,
		'manage.keyboardPicked': /Enter.*mellemrum.*Escape/iu,
	},
	ja: {
		'delete.description': /実ファイル.*ゴミ箱/u,
		'manage.deleteSlot': /ファイルは保持/u,
		'manage.dissolveConfirmDescription': /ファイルは削除も変更もされません/u,
		'manage.missingPreview': /見つかりません.*修復/u,
		'manage.keyboardPicked': /Enter.*Space.*Escape/u,
	},
};
for (const [language, checks] of Object.entries(sampledSafety)) {
	for (const [key, pattern] of Object.entries(checks)) {
		assert.match(catalogs[language][key], pattern, `${language}: ${key}`);
	}
}

console.log(
	`compat/i18n audit passed: ${keyCount} keys; ` +
	`${expectedPlugins.size} enabled plugins; ${theme.name} ${theme.version}; ` +
	`${new Set(ownClasses).size} scoped Version CSS classes`,
);

function read(relativePath) {
	return readFileSync(path.join(path.dirname(obsidianRoot), relativePath), 'utf8');
}

function readPlugin(relativePath) {
	return readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

function sourceFiles() {
	return [
		'src/main.ts',
		'src/ui/file-explorer-decorator.ts',
		'src/ui/hover-preview.ts',
		'src/ui/note-preview.ts',
		'src/ui/version-editor-suggest.ts',
		'src/ui/version-link-modal.ts',
		'src/ui/version-view-decorator.ts',
	];
}

function collectClasses(css) {
	return [...css.matchAll(/\.([_a-z][\w-]*)/giu)].map((match) => match[1]);
}

function collectRuleSelectors(css) {
	const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '');
	const selectors = [];
	for (const match of withoutComments.matchAll(/([^{}]+)\{/gu)) {
		const block = match[1].trim();
		if (
			block.startsWith('@') ||
			block === 'from' ||
			block === 'to' ||
			/^\d+%$/u.test(block)
		) {
			continue;
		}
		for (const selector of block.split(',')) {
			selectors.push(selector.trim());
		}
	}
	return selectors;
}

function readCatalog(relativePath, variableName) {
	const filePath = path.join(pluginRoot, relativePath);
	const sourceFile = ts.createSourceFile(
		filePath,
		readFileSync(filePath, 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) continue;
			if (declaration.name.text !== variableName || !declaration.initializer) continue;
			const object = unwrap(declaration.initializer);
			assert.ok(ts.isObjectLiteralExpression(object));
			const catalog = {};
			for (const property of object.properties) {
				assert.ok(ts.isPropertyAssignment(property));
				const value = unwrap(property.initializer);
				assert.ok(ts.isStringLiteralLike(value));
				catalog[property.name.text] = value.text;
			}
			return catalog;
		}
	}
	assert.fail(`Missing ${variableName}`);
}

function unwrap(expression) {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isParenthesizedExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
