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
const createVersionModal = readPlugin('src/ui/create-version-modal.ts');
assert.match(viewDecorator, /viewType === 'canvas'/u);
assert.match(viewDecorator, /includes\('excalidraw'\)/u);
assert.match(
	viewDecorator,
	/version-view-type-canvas[\s\S]*?version-view-type-excalidraw/u,
	'Visual editor controls must expose stable, Version-owned CSS hooks',
);
assert.match(
	viewDecorator,
	/existing\.contentEl === view\.contentEl[\s\S]*?existing\.tabsEl\.isConnected[\s\S]*?view\.containerEl\.contains\(existing\.tabsEl\)/u,
	'Version controls must rebind their host after a third-party view replaces its content DOM',
);
assert.match(
	viewDecorator,
	/view\.containerEl\.createDiv\(\{[\s\S]*?cls: 'version-tabs-shell'/u,
	'The rail must be a Version-owned sibling on the stable public view container',
);
assert.match(
	viewDecorator,
	/existing\.isConnected[\s\S]*?view\.containerEl\.contains\(existing\)/u,
	'Standalone actions must be recreated after a third-party view replaces its toolbar',
);
assert.match(
	viewDecorator,
	/if \(repair\) \{[\s\S]*?this\.onManage\(view\.file\);[\s\S]*?return;[\s\S]*?this\.openInitialVersionModal\(view\);/u,
	'Only an incomplete relationship may route the standalone toolbar action into Version management',
);
assert.match(
	viewDecorator,
	/private openInitialVersionModal\(view: FileView\)[\s\S]*?new CreateVersionModal\([\s\S]*?\n\s*2,[\s\S]*?detectVersionFileFormat\(v1\) \?\? 'markdown'[\s\S]*?\n\s*false,[\s\S]*?this\.createInitialVersion/u,
	'An unmanaged note must open the format-aware V2 quick-create modal directly',
);
assert.match(
	viewDecorator,
	/openInitialVersionModalForFile\(file: TFile\)[\s\S]*?this\.isLiveUnregisteredFile\(file\)[\s\S]*?this\.findOpenFileView\(file\)[\s\S]*?this\.openInitialVersionModal\(openView\)[\s\S]*?this\.openFileThenInitialVersionModal\(file\)/u,
	'File-menu quick-create must reuse an open editable file view or safely open the real file first',
);
assert.match(
	viewDecorator,
	/private async createInitialVersion[\s\S]*?if \(!this\.isLiveUnregisteredFile\(v1\)\)[\s\S]*?return false;[\s\S]*?createAndRegisterVersionFile/u,
	'Quick-create submit must reject a stale menu or modal before creating any file',
);
assert.match(
	viewDecorator,
	/private async openFileThenInitialVersionModal[\s\S]*?isLiveUnregisteredFile\(file\)[\s\S]*?await leaf\.openFile\(file[\s\S]*?isLiveUnregisteredFile\(file\)[\s\S]*?leaf\.view instanceof FileView[\s\S]*?leaf\.view\.file === file[\s\S]*?isEditableVersionViewType\(leaf\.view\.getViewType\(\)\)/u,
	'File-menu fallback must re-check an unmanaged file after opening the exact editable FileView',
);
assert.match(
	createVersionModal,
	/setButtonText\(this\.i18n\.t\('common\.cancel'\)\)[\s\S]*?\.onClick\(\(\) => this\.close\(\)\)[\s\S]*?setButtonText\(this\.i18n\.t\('create\.confirm'/u,
	'Cancelling quick-create must only close the modal; creation remains behind the explicit confirm button',
);
assert.match(
	viewDecorator,
	/private async createInitialVersion[\s\S]*?createAndRegisterVersionFile\([\s\S]*?this\.registry\.createSeries\(v1, file\)[\s\S]*?view\.leaf\.openFile/u,
	'Initial quick-create must use the shared file transaction and commit a real V1/V2 registry relationship before opening V2',
);
assert.match(
	viewDecorator,
	/canUpdateInPlace[\s\S]*?this\.updateVersionButton[\s\S]*?return;/u,
	'Repeated compatibility refreshes must preserve stable version-tab nodes',
);
assert.match(
	viewDecorator,
	/const openLabel = this\.i18n\.t\('view\.openVersionAria'[\s\S]*?const tooltip = isVersionGroupExactlyResolved\(group\)[\s\S]*?view\.versionActions[\s\S]*?: openLabel;[\s\S]*?setTooltip\(button, tooltip, \{ placement: 'left' \}\)/u,
	'Each version button must advertise context actions only when the group is exact',
);
assert.match(
	viewDecorator,
	/const labelId = `version-tabs-label-[\s\S]*?cls: 'version-visually-hidden'[\s\S]*?'aria-labelledby': labelId/u,
	'The version group must use a hidden accessible label instead of a hoverable generic label',
);
assert.match(
	viewDecorator,
	/controls\.labelEl\.textContent = this\.i18n\.t\('view\.versionsAria'\)/u,
	'The hidden group label must refresh when the UI language changes',
);
assert.doesNotMatch(
	viewDecorator,
	/button\.title\s*=/u,
	'Version tabs must not add a second browser-native hover label',
);
assert.doesNotMatch(
	viewDecorator,
	/cls: 'version-tabs',[\s\S]{0,180}?'aria-label': this\.i18n\.t\('view\.versionsAria'\)/u,
	'The track itself must not expose the stray generic Versions hover label',
);
assert.match(
	versionCss,
	/\.version-view-container\s*\{[\s\S]*?--version-rail-content-offset:[\s\S]*?--version-rail-edge-overlap:[\s\S]*?--version-rail-max-height:[\s\S]*?--version-tab-face-width:[\s\S]*?--version-tab-face-offset:[\s\S]*?--version-tab-gap:[\s\S]*?--version-tab-height:[\s\S]*?--version-tab-hit-width:[\s\S]*?--version-rail-face-inline-inset:[\s\S]*?--version-rail-inline-inset:[\s\S]*?--version-visual-rail-lane-width:/u,
	'Rail edge overlap, fixed face inset, host lane, bounds, and tab dimensions must be centralized as Version variables',
);
assert.match(
	versionCss,
	/--version-rail-edge-overlap:\s*1px;[\s\S]*?--version-tab-face-width:\s*2rem;[\s\S]*?--version-tab-face-offset:\s*0px;[\s\S]*?--version-tab-hit-width:\s*var\(--version-tab-face-width\);[\s\S]*?--version-rail-face-inline-inset:\s*0px;[\s\S]*?--version-rail-inline-inset:\s*var\(--version-rail-face-inline-inset\);[\s\S]*?--version-tab-face-inline-end:\s*0px;[\s\S]*?--version-tab-face-inline-start:\s*0px;[\s\S]*?--version-visual-rail-lane-width:\s*calc\(\s*var\(--version-tab-face-width\) - var\(--version-rail-edge-overlap\)\s*\);/u,
	'The 32px face and hit target must fill the outer-edge lane, with only a one-pixel host overlap to absorb seams',
);
assert.match(
	versionCss,
	/\.version-tabs-shell\s*\{[\s\S]*?var\(--version-rail-max-height\)[\s\S]*?inset-inline-end:\s*var\(--version-rail-inline-inset\);[\s\S]*?pointer-events:\s*none;[\s\S]*?top:\s*calc\(var\(--version-rail-content-offset\) \+ var\(--version-rail-top\)\);/u,
	'The inert sibling shell must use logical positioning relative to the public content area',
);
assert.match(
	versionCss,
	/\.version-tabs\s*\{[\s\S]*?pointer-events:\s*none;[\s\S]*?scrollbar-width:\s*none;/u,
	'The scrollable track must hide its scrollbar and leave gaps inert',
);
assert.match(
	versionCss,
	/\.version-tabs::-webkit-scrollbar\s*\{[\s\S]*?height:\s*0;[\s\S]*?width:\s*0;/u,
	'WebKit must hide the rail scrollbar while overflow cues communicate continuation',
);
assert.match(
	versionCss,
	/\.version-view-container \.version-tabs > button\.version-tab\s*\{[\s\S]*?pointer-events:\s*auto;/u,
	'Only concrete version buttons may opt back into pointer input',
);
assert.match(
	versionCss,
	/\.version-visually-hidden\s*\{[\s\S]*?clip-path:\s*inset\(50%\);[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*1px;/u,
	'The group label must remain available to assistive technology without painting a tooltip target',
);
assert.doesNotMatch(
	versionCss,
	/\.version-view-container\.version-view-type-excalidraw\s*\{[^}]*--version-rail-top:/u,
	'Excalidraw must not move the rail vertically when the open version changes format',
);
assert.match(
	versionCss,
	/\.version-view-container > \.version-view-content\s*\{[^}]*width:\s*calc\(100% - var\(--version-visual-rail-lane-width\)\);/u,
	'Every supported public content host must reserve the same seam-free outer-edge lane',
);
assert.match(
	viewDecorator,
	/controls\.contentEl\.removeClass\('version-view-content'\)[\s\S]*?view\.containerEl\.removeClass\('version-view-container'\)[\s\S]*?view\.containerEl\.removeClass\(\.\.\.VERSION_VIEW_TYPE_CLASSES\)/u,
	'Rail teardown must remove both the saved content hook and stable container hooks',
);
assert.doesNotMatch(
	versionCss,
	/\.version-view-content\.version-view-type-(?:canvas|excalidraw)\s*>\s*:not\(/u,
	'Version must not resize direct Canvas or Excalidraw content children',
);
assert.doesNotMatch(
	versionCss,
	/\.(?:canvas-wrapper|canvas-controls|excalidraw-wrapper|FixedSideContainer)/u,
	'Version layout CSS must not target Canvas or Excalidraw private descendants',
);
assert.match(
	viewDecorator,
	/applyViewTypeClass[\s\S]*?toLocaleLowerCase\(\)[\s\S]*?includes\('excalidraw'\)[\s\S]*?version-view-type-excalidraw/u,
	'Every accepted Excalidraw-compatible view type must receive the visual-editor safety classes',
);
assert.match(
	versionCss,
	/\.version-view-container\s*\{[\s\S]*?--version-tab-face-width:\s*2rem;[\s\S]*?--version-tab-height:\s*6rem;[\s\S]*?--version-tab-hit-width:\s*var\(--version-tab-face-width\);/u,
	'The fixed 32px rail button must remain narrow while its 96px height keeps each version easy to target',
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
	/\.version-management-new-format\.is-pointer-focused:focus\s*\{[^}]*border-color:\s*var\(--background-modifier-border\);[^}]*box-shadow:\s*none;[^}]*outline:\s*none;/u,
	'Pointer-selected formats must drop the stale ring without overriding keyboard focus-visible styles',
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
	/\.version-view-container \.version-tabs > button\.version-tab::before,[\s\S]*?clip-path:\s*polygon\(0 11%, 100% 0, 100% 100%, 0 89%\);/u,
	'The tab face must use the sketch\'s vertically oriented, symmetric outward trapezoid',
);
assert.match(
	versionCss,
	/\.version-view-container \.version-tabs > button\.version-tab\s*\{[\s\S]*?padding-inline-end:\s*var\(--version-tab-label-padding-inline-end\);[\s\S]*?padding-inline-start:\s*var\(--version-tab-label-padding-inline-start\);/u,
	'The version label must stay centered in the shared painted face and hit target',
);
assert.match(
	versionCss,
	/button\.version-tab::before\s*\{[\s\S]*?inset-inline-end:\s*var\(--version-tab-face-inline-end\);[\s\S]*?inset-inline-start:\s*var\(--version-tab-face-inline-start\);[\s\S]*?button\.version-tab::after\s*\{[\s\S]*?inset-inline-end:\s*calc\(var\(--version-tab-face-inline-end\) \+ 1px\);[\s\S]*?inset-inline-start:\s*calc\(var\(--version-tab-face-inline-start\) \+ 1px\);/u,
	'Both trapezoid layers must use the shared logical face offsets',
);
assert.match(
	versionCss,
	/\.version-view-container \.version-tabs > button\.version-tab\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?background:\s*transparent;[\s\S]*?background-image:\s*none;[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;/u,
	'Community themes must not expose the rectangular accessible hit target around a trapezoid',
);
assert.match(
	versionCss,
	/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.version-hover-preview\.popover[\s\S]*?animation:\s*none/u,
	'Hover previews must respect reduced-motion preferences',
);

const versionFileCreation = readPlugin('src/version-file-creation.ts');
const versionFileCreationMessage = readPlugin(
	'src/version-file-creation-message.ts',
);
const versionFileCreationTransaction = readPlugin(
	'src/version-file-creation-transaction.ts',
);
const managementCreation = readPlugin('src/ui/version-management-modal.ts');
assert.match(
	versionFileCreation,
	/type VersionFileFormat = 'markdown' \| 'canvas' \| 'excalidraw'/u,
	'Every creation entry point must share the same closed format union',
);
assert.match(
	versionFileCreation,
	/VERSION_FILE_SUFFIXES[\s\S]*?markdown: '\.md'[\s\S]*?canvas: '\.canvas'[\s\S]*?excalidraw: '\.excalidraw\.md'/u,
	'The shared service must own canonical suffixes instead of duplicating them in UI code',
);
assert.match(
	versionFileCreation,
	/getBlankCanvasContent\(\)[\s\S]*?nodes: \[\], edges: \[\]/u,
	'Canvas creation must write a valid empty Canvas document',
);
assert.match(
	versionFileCreation,
	/switch \(format\)[\s\S]*?case 'markdown':[\s\S]*?case 'canvas':[\s\S]*?case 'excalidraw':[\s\S]*?prepareExcalidrawContent\(app\)/u,
	'The shared preparation service must handle all three formats explicitly',
);
assert.match(
	versionFileCreation,
	/prepareExcalidrawContent\(app: App\)[\s\S]*?getEnabledExcalidrawPlugin\(app\)[\s\S]*?plugin\.getBlankDrawing\(\)[\s\S]*?isValidExcalidrawMarkdown\(content\)[\s\S]*?isValidLegacyExcalidrawJson\(content\)/u,
	'Excalidraw creation must obtain and validate a real blank payload before writing',
);
assert.match(
	versionFileCreation,
	/getEnabledExcalidrawPlugin\(app: App\)[\s\S]*?enabledPlugins\?\.has\(EXCALIDRAW_PLUGIN_ID\)[\s\S]*?isExcalidrawPluginApi\(plugin\)/u,
	'Excalidraw creation must require an enabled plugin exposing the expected API',
);
assert.match(
	versionFileCreationTransaction,
	/prepareVersionFile\(app, options\)[\s\S]*?createPreparedVersionFile\(app, prepared\)[\s\S]*?await register\(file\)[\s\S]*?rollbackCreatedFilesIfUnchanged[\s\S]*?expectedContent: prepared\.content[\s\S]*?openError/u,
	'Creation must have explicit prepare, create, register, content-safe rollback, and non-destructive open-failure boundaries',
);
assert.match(
	versionFileCreationMessage,
	/ExcalidrawPluginUnavailable[\s\S]*?ExcalidrawApiUnavailable[\s\S]*?create\.excalidrawUnavailable[\s\S]*?InvalidExcalidrawContent[\s\S]*?create\.excalidrawPreparationFailed/u,
	'Excalidraw dependency and payload failures must use localized user-facing messages',
);
assert.match(
	createVersionModal,
	/addOption\('markdown'[\s\S]*?addOption\('canvas'[\s\S]*?addOption\('excalidraw'[\s\S]*?onCreate\(filename, this\.format\)/u,
	'The editor creation modal must expose all formats before invoking its shared callback',
);
assert.match(
	viewDecorator,
	/const sourceFile = view\.file && current\.versions\.some[\s\S]*?\? view\.file[\s\S]*?: v1\.file;[\s\S]*?detectVersionFileFormat\(sourceFile\) \?\? 'markdown'[\s\S]*?\(filename, format\) => this\.createSpecificVersion[\s\S]*?createAndRegisterVersionFile/u,
	'Editor maximum and gap creation must freeze the current member format and use the shared transaction',
);
assert.match(
	managementCreation,
	/VERSION_FILE_FORMAT_OPTIONS[\s\S]*?value: 'markdown'[\s\S]*?value: 'canvas'[\s\S]*?value: 'excalidraw'/u,
	'Version management must expose the same three creation formats',
);
assert.match(
	managementCreation,
	/this\.defaultNewFormat = currentFile[\s\S]*?detectVersionFileFormat\(currentFile\) \?\? 'markdown'[\s\S]*?slot\.assignment = \{[\s\S]*?format: this\.defaultNewFormat,[\s\S]*?kind: 'new'/u,
	'New management assignments must remain staged and inherit the current member format by default',
);
assert.match(
	managementCreation,
	/private async submit\(\)[\s\S]*?prepareVersionFile\(this\.app[\s\S]*?createPreparedVersionFile[\s\S]*?saveSeriesSlots[\s\S]*?rollbackCreatedFilesIfUnchanged/u,
	'Management Done must use the shared service and retain compensation for failures before relationship commit',
);
assert.doesNotMatch(
	managementCreation,
	/\.vault\.create\(/u,
	'Version management must not bypass the shared creation service with direct vault writes',
);

const main = readPlugin('src/main.ts');
const seriesMoveTransactionSource = readPlugin('src/series-move-transaction.ts');
const versionIndexSource = readPlugin('src/version-index.ts');
const versionRegistrySource = readPlugin('src/version-registry.ts');
const versionFileMenuState = readPlugin('src/version-file-menu-state.ts');
const settingsSource = readPlugin('src/settings.ts');
assert.match(
	versionRegistrySource,
	/async createSeries\(v1: TFile, v2: TFile\)[\s\S]*?return this\.enqueue[\s\S]*?this\.assertFilesAreLive\(\[v1, v2\]\)[\s\S]*?this\.assertFilesAreUnmanaged\(\[v1, v2\]\)[\s\S]*?await this\.commit\(next\)/u,
	'Initial V1/V2 registration must serialize and re-check live unmanaged files before committing',
);
assert.match(
	viewDecorator,
	/if \(!group\) \{[\s\S]*?this\.removeControls\(view\);[\s\S]*?this\.ensureStandaloneAction\(view, false\);[\s\S]*?if \(group\.status !== 'healthy'\)[\s\S]*?this\.ensureStandaloneAction\(view, true\);[\s\S]*?this\.removeStandaloneAction\(view\);[\s\S]*?this\.renderControls\(view, group\)/u,
	'Unmanaged notes must show only quick-create, damaged relationships repair, and healthy relationships the full controls',
);
assert.match(
	viewDecorator,
	/const actionEl = view\.addAction\([\s\S]*?'plus'[\s\S]*?handleAddVersion[\s\S]*?const manageEl = view\.addAction\([\s\S]*?'list-tree'/u,
	'Healthy relationships must render both the persistent plus action and Version management',
);
assert.match(
	viewDecorator,
	/private renderControls[\s\S]*?classList\.remove\('is-disabled'\)[\s\S]*?removeAttribute\('aria-disabled'\)/u,
	'The plus action must remain enabled for every healthy exact or compatible relationship',
);
assert.match(
	viewDecorator,
	/private handleAddVersion[\s\S]*?group\.status !== 'healthy'[\s\S]*?private openCreateVersionModal[\s\S]*?captureAppendExpectation\(current\.id\)[\s\S]*?appendMemberToResolvedSeries/u,
	'Healthy compatible groups must enter the dedicated append-only creation path',
);
const captureAppendExpectation = versionRegistrySource.match(
	/captureAppendExpectation\(seriesId: string\): VersionAppendExpectation \| null \{[\s\S]*?\n\t\}/u,
)?.[0] ?? '';
assert.match(
	captureAppendExpectation,
	/captureResolvedSeriesExpectation[\s\S]*?this\.appendExpectations\.add\(expectation\)/u,
	'Append authorization must be tracked as a one-shot resolved-series expectation',
);
const captureResolvedSeriesExpectation = versionRegistrySource.match(
	/private captureResolvedSeriesExpectation\([\s\S]*?\n\t\}/u,
)?.[0] ?? '';
assert.match(
	captureResolvedSeriesExpectation,
	/this\.index\.rebuild\(this\.records\)[\s\S]*?group\.status !== 'healthy'[\s\S]*?memberResolvesToFile\(slot\.member, file\)[\s\S]*?members\.length !== group\.versions\.length/u,
	'Resolved-series authorization must use a fresh index and require every exact or precision-compatible member',
);
const appendResolvedMember = versionRegistrySource.match(
	/async appendMemberToResolvedSeries\([\s\S]*?\n\t\}/u,
)?.[0] ?? '';
assert.match(
	appendResolvedMember,
	/captureFile\(file\)[\s\S]*?memberRecordFromFile\(file\)[\s\S]*?this\.appendExpectations\.delete\(expectation\)[\s\S]*?assertExpectedRevision[\s\S]*?assertExpectedSeries[\s\S]*?group\.status !== 'healthy'[\s\S]*?assertResolvedSeriesExpectation[\s\S]*?isCapturedFile\(liveFile, fileCapture\)[\s\S]*?assertPathsAreUnmanaged\(\[member\.path\]\)[\s\S]*?slots\.push\([\s\S]*?member,[\s\S]*?version,[\s\S]*?await this\.commit\(next\)/u,
	'Append-only registration must freeze the new file, consume one CAS token, recheck every old member, and append exactly once',
);
assert.doesNotMatch(
	appendResolvedMember,
	/slot\.member\s*=|\.slots\.sort|\b(?:rename|move|trash)\w*\(/u,
	'Append-only registration must never rewrite old slots or move, rename, or trash a real member',
);
assert.match(
	versionRegistrySource,
	/private assertFilesAreLive[\s\S]*?current !== file[\s\S]*?memberMatchesFile/u,
	'General registry mutations must reject a stale same-path TFile replacement',
);
assert.match(
	versionFileMenuState,
	/group\?\.status === 'healthy'[\s\S]*?resolvedVersion !== null[\s\S]*?resolvedVersion\.version === 1 \? 'manage' : 'locate'[\s\S]*?group !== null \|\| registeredSeriesCount > 0 \? 'repair' : 'create'/u,
	'Visible file-menu state must treat exact and precision-compatible healthy members as managed while reserving repair for damaged or unresolved registrations',
);
assert.match(
	main,
	/getVersionFileMenuState\([\s\S]*?menuState\.action === 'repair'[\s\S]*?fileExplorer\.manageVersions[\s\S]*?registeredSeriesIds\.length > 0[\s\S]*?: 'plus'[\s\S]*?else \{\s*this\.versionViews\.openInitialVersionModalForFile\(file\);\s*\}/u,
	'An entirely unmanaged file-menu item must keep its familiar label and plus icon while routing to the shared quick-create flow',
);
assert.doesNotMatch(
	main,
	/else \{\s*this\.openVersionManager\(file\);\s*\}/u,
	'An entirely unmanaged file-menu item must never regress to opening Version management',
);
const externalSettingsReload = main.match(
	/async onExternalSettingsChange\(\): Promise<void> \{[\s\S]*?\n\t\}/u,
)?.[0] ?? '';
assert.match(
	externalSettingsReload,
	/this\.loadData\(\)[\s\S]*?normalizeExternalPluginData\(raw\)[\s\S]*?this\.registry\.reload[\s\S]*?this\.dataStore\.reconcile[\s\S]*?mergeExternalPluginData[\s\S]*?this\.scheduleUiRefresh\(\)/u,
	'Externally synchronized plugin data must reload the serialized store, registry, and visible UI',
);
assert.doesNotMatch(
	externalSettingsReload,
	/saveData|persistSeries|updatePluginData/u,
	'External settings reload must not write the synchronized snapshot straight back',
);
assert.match(
	main,
	/private externalSettingsBase: VersionSettings \| null = null;[\s\S]*?private externalRegistryBase: VersionSeriesRecord\[\] = \[\];[\s\S]*?private externalRegistryBaseTrusted = false;[\s\S]*?private async loadSettings\(\)[\s\S]*?this\.externalSettingsBase = normalizePluginData\(this\.settings\);[\s\S]*?this\.externalRegistryBase = cloneSeriesRecords\(this\.settings\.series\);[\s\S]*?this\.externalRegistryBaseTrusted = false/u,
	'The plugin must initialize separate scalar and registry external merge bases from startup data',
);
assert.match(
	externalSettingsReload,
	/const capturedRegistryBase = this\.externalRegistryBaseTrusted[\s\S]*?\? cloneSeriesRecords\(this\.externalRegistryBase\)[\s\S]*?: \[\];[\s\S]*?const rawSnapshot = this\.loadData\(\)\.then\([\s\S]*?ok: true as const[\s\S]*?ok: false as const[\s\S]*?const operation = async \(\): Promise<void> =>/u,
	'Each external callback must capture its registry base and a settled raw-data read before waiting in the reload queue',
);
assert.match(
	externalSettingsReload,
	/const latestBase = normalizePluginData\([\s\S]*?this\.externalSettingsBase \?\? this\.dataStore\.get\(\)[\s\S]*?const mergeBase = normalizePluginData\(\{[\s\S]*?\.\.\.latestBase,[\s\S]*?series: capturedRegistryBase,[\s\S]*?this\.dataStore\.reconcile\([\s\S]*?mergeBase,[\s\S]*?incoming,[\s\S]*?reconciled = normalizePluginData\(next\)/u,
	'The queued reload must combine its captured registry base with the freshest scalar base',
);
assert.match(
	externalSettingsReload,
	/if \(!protectedReplay\) \{[\s\S]*?this\.externalSettingsBase = normalizePluginData\(reconciled\);[\s\S]*?this\.externalRegistryBase = cloneSeriesRecords\(incoming\.series\);[\s\S]*?this\.externalRegistryBaseTrusted = true;[\s\S]*?\}/u,
	'Only an ordinary reconciliation may advance scalar state and its registry base must advance to incoming.series rather than the merged write-back',
);
assert.match(
	externalSettingsReload,
	/const protectedReplay = this\.protectedExternalSnapshots\.some[\s\S]*?return protectedReplay[\s\S]*?\? normalizePluginData\(current\)[\s\S]*?: mergeExternalPluginData\([\s\S]*?!versionPluginDataEqual\(reconciled, incoming\)[\s\S]*?if \(!protectedReplay\)[\s\S]*?this\.protectedExternalSnapshots\.push\([\s\S]*?normalizePluginData\(incoming\)/u,
	'An incoming snapshot that loses reconciliation must be protected against destructive replay',
);
assert.match(
	versionIndexSource,
	/memberResolvesToFile\(slot\.member, file\)/u,
	'Cross-device coarse-time compatibility must resolve the non-destructive index',
);
assert.match(
	versionRegistrySource,
	/async addMember\([\s\S]*?assertSeriesExactlyResolved\(seriesId\)[\s\S]*?assertMembersResolve\(series\.slots\)/u,
	'General member mutation must remain exact even though the isolated append-only path accepts compatibility',
);
assert.match(
	versionIndexSource,
	/identityStatus: VersionIdentityStatus[\s\S]*?!memberMatchesFile\(slot\.member, file\)[\s\S]*?identityStatus = 'compatible'/u,
	'Compatible display resolution must remain distinguishable from exact mutation identity',
);
assert.match(
	main,
	/resolveExactGroup\(group\.id\)[\s\S]*?releaseVersionMembers\([\s\S]*?expectedSeries[\s\S]*?resolveExactGroup\(group\.id\)[\s\S]*?new MoveThemeModal/u,
	'Destructive dialogs must re-resolve exact identities and capture the current series snapshot',
);
assert.match(
	main,
	/private resolveExactGroup\(seriesId: string\): VersionGroup \| null \{[\s\S]*?registry\.resolveExactlyMatchedGroup\(seriesId\)[\s\S]*?isCurrentExactVersionMember[\s\S]*?memberMatchesFile\(registeredMember, file\)[\s\S]*?captureMergeFileExpectation[\s\S]*?memberMatchesFile\(registeredMember, file\)/u,
	'Rename, single-file move, native actions, and both merge endpoints must use a fresh raw-member exact identity gate',
);
assert.match(
	versionRegistrySource,
	/resolveExactlyMatchedGroup\(seriesId: string\): VersionGroup \| null \{[\s\S]*?index\.rebuild\(this\.records\)[\s\S]*?getRecordById\(seriesId\)[\s\S]*?memberMatchesFile\(slot\.member, file\)[\s\S]*?return group/u,
	'External file mutations must not trust an exact status cached before an in-place TFile ctime change',
);
assert.match(
	managementCreation,
	/initialSeriesRecord[\s\S]*?preflightSeriesSlots\([\s\S]*?this\.initialSeriesRecord[\s\S]*?saveSeriesSlots\([\s\S]*?this\.initialSeriesRecord/u,
	'An open Version management editor must compare-and-swap its original series snapshot',
);
assert.match(
	managementCreation,
	/dissolveSeries\([\s\S]*?this\.initialSeriesRecord/u,
	'An open Version management editor must compare-and-swap before dissolving a series',
);
assert.match(
	managementCreation,
	/this\.initialRegistryRevision = registry\.getRevision\(\)[\s\S]*?preflightSeriesSlots\([\s\S]*?this\.initialRegistryRevision[\s\S]*?saveSeriesSlots\([\s\S]*?this\.initialRegistryRevision[\s\S]*?dissolveSeries\([\s\S]*?this\.initialRegistryRevision/u,
	'Version management must pass one captured registry revision through preflight, save, and explicit dissolve',
);
assert.match(
	main,
	/const expectedRevision = this\.registry\.getRevision\(\);[\s\S]*?this\.moveEnvironment\(seriesId, record, expectedRevision\)[\s\S]*?private moveEnvironment\([\s\S]*?expectedRevision\?: number[\s\S]*?saveSeriesSlots\([\s\S]*?expectedSeries,[\s\S]*?expectedRevision/u,
	'Whole-series movement must carry one captured registry revision into its final slot commit',
);
assert.match(
	seriesMoveTransactionSource,
	/export interface SeriesMoveEnvironment \{[\s\S]*?canRollback\?: \(plan: SeriesMovePlan\) => boolean;[\s\S]*?rollbackSeriesMoves\([\s\S]*?environment\.canRollback && !environment\.canRollback\(plan\)/u,
	'Whole-series rollback must support a production ownership and revision veto',
);
assert.match(
	seriesMoveTransactionSource,
	/export interface SeriesMoveEnvironment \{[\s\S]*?isPathRegistered\?: \(path: string\) => boolean;[\s\S]*?collisionCount = plans\.filter\([\s\S]*?environment\.isPathRegistered\?\.\(plan\.to\)[\s\S]*?for \(const plan of plans\)[\s\S]*?if \(environment\.isPathRegistered\?\.\(plan\.to\)\)[\s\S]*?await environment\.renameFile/u,
	'Whole-series forward preflight must treat registry-only destinations as collisions both before and during the move loop',
);
assert.match(
	main,
	/canRollback: \(plan: SeriesMovePlan\) =>[\s\S]*?this\.registry\.getRevision\(\) === expectedRevision[\s\S]*?this\.registry\.getRecords\(\)\.some[\s\S]*?slot\.member\?\.path === plan\.to/u,
	'Production whole-series rollback must reject changed revisions and newly registered destinations',
);
assert.match(
	main,
	/isPathRegistered: \(path: string\) =>[\s\S]*?this\.registry\.getRecords\(\)\.some[\s\S]*?slot\.member\?\.path === path/u,
	'Production whole-series movement must expose registry-only path ownership to transaction preflight',
);
assert.match(
	managementCreation,
	/private planReleasedMoves\([\s\S]*?this\.app\.vault\.getAbstractFileByPath\(plan\.to\) \|\|[\s\S]*?this\.isRegisteredPath\(plan\.to\)/u,
	'Released-file planning must reject a destination reserved only by registry data',
);
assert.match(
	settingsSource,
	/getSettingDefinitions\(\): SettingDefinitionItem<VersionSettingKey>\[\][\s\S]*?type: 'group'[\s\S]*?cls: 'version-settings-section'/u,
	'Obsidian 1.13 declarative settings must expose the localized grouped layout on first open',
);
assert.match(
	settingsSource,
	/getSettingDefinitions\(\): SettingDefinitionItem<VersionSettingKey>\[\][\s\S]*?const definitions = this\.getVersionSettingDefinitions\(\)[\s\S]*?items: definitions/u,
	'The single declarative group renderer must consume the internal setting definitions',
);
assert.match(
	settingsSource,
	/private getVersionSettingDefinitions\(\): VersionSettingDefinitionItem<[\s\S]*?return \[/u,
	'Setting row definitions must remain private to the grouped renderer',
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
	/every version managed by Multi-Version Notes is an independent, ordinary vault file[\s\S]*?Disabling or uninstalling the plugin does not change the contents/u,
	'English documentation must preserve ordinary-file readability when Version is unavailable',
);
assert.match(
	readme,
	/每一个版本，本质上都是一篇单独的仓库文件[\s\S]*?停用或卸载插件，也不会影响这些文件的内容/u,
	'Chinese documentation must preserve ordinary-file readability when Version is unavailable',
);
assert.match(
	readme,
	/does not infer relationships from filenames[\s\S]*?or rewrite note contents[\s\S]*?fails open/u,
	'English documentation must preserve explicit membership and fail-open semantics',
);
assert.match(
	readme,
	/不会根据文件名猜测关系[\s\S]*?不会改写笔记正文[\s\S]*?优先恢复文件的可见性/u,
	'Chinese documentation must preserve explicit membership and fail-open semantics',
);
assert.match(
	readme,
	/Use the \*\*\+\*\* action to open the quick-create dialog[\s\S]*?The \*\*\+\*\* action remains available/u,
	'English basic use must preserve persistent quick-create semantics',
);
assert.match(
	readme,
	/点击“\+”[\s\S]*?“\+”会一直保留/u,
	'Chinese basic use must preserve persistent quick-create semantics',
);
assert.match(
	readme,
	/Install Multi-Version Notes from \*\*Settings → Community plugins\*\*[\s\S]*?https:\/\/github\.com\/mizhidaili\/version\/issues/u,
	'English publication documentation must contain the current install route and support URL',
);
assert.match(
	readme,
	/前往“设置 → 第三方插件”[\s\S]*?https:\/\/github\.com\/mizhidaili\/version\/issues/u,
	'Chinese publication documentation must contain the current install route and support URL',
);
const acceptanceMatrix = readPlugin('docs/acceptance-matrix.md');
assert.match(
	acceptanceMatrix,
	/Supported members are Markdown[\s\S]*?Canvas[\s\S]*?legacy `\.excalidraw`/u,
	'Acceptance evidence must cover every currently supported member type',
);
assert.match(
	acceptanceMatrix,
	/226 typed keys have exact key and placeholder parity across all four locales/u,
	'Acceptance evidence must retain the actual current locale key count',
);
assert.match(
	acceptanceMatrix,
	/Current `npm test` passes its model\/registry suite and verifies 226 keys across four locales[\s\S]*?exact model assertion total is emitted by the runner rather than duplicated here/u,
	'Acceptance evidence must not duplicate a fast-changing model assertion total',
);
assert.match(
	acceptanceMatrix,
	/Current follow-up candidate runtime UI \| partial[\s\S]*?physical-iPad canary was accepted[\s\S]*?remain bounded residual gates/u,
	'Bounded physical-device acceptance must retain unrelated UI residual gates',
);
assert.match(
	acceptanceMatrix,
	/File Explorer folding, virtualization, and failure visibility \| partial[\s\S]*?physical-iPad drawer grouping was accepted[\s\S]*?exhaustive folder folding[\s\S]*?remain pending/u,
	'Accepted iPad grouping must retain the wider folding and row-reuse stress gate',
);
assert.match(
	acceptanceMatrix,
	/Theme-level backlink calculation \| partial[\s\S]*?registry-mapped target versions[\s\S]*?modal rendering\/click acceptance remains pending/u,
	'Backlink target attribution must remain separate from modal UI acceptance',
);
assert.match(
	acceptanceMatrix,
	/Physical touch\/mobile management workflow \| partial[\s\S]*?Physical iPad acceptance passed[\s\S]*?remain separate open gates/u,
	'Physical mobile acceptance must remain scoped to the flows actually exercised',
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
assert.match(
	acceptanceMatrix,
	/Reveal a hidden V2\+ row in the native File Explorer \| public API limitation[\s\S]*?Fallback: \*\*Show Vn in Version management…\*\*/u,
	'The native reveal limitation must retain an exact Version-owned fallback',
);
assert.match(
	acceptanceMatrix,
	/Add pending blank version \| partial[\s\S]*?Markdown\/Canvas\/Excalidraw format[\s\S]*?live mixed-format management acceptance remains pending/u,
	'Mixed-format staging evidence must retain its live management acceptance gate',
);
assert.match(
	acceptanceMatrix,
	/Markdown, Canvas, and Excalidraw rails grow from the top \| partial[\s\S]*?32px face-and-hit width[\s\S]*?reserves? `face width - 1px overlap`[\s\S]*?No private drawing descendant is selected or restyled[\s\S]*?all occupied screenshot x=1040\.\.1066[\s\S]*?active tops normalize to y=93\.\.94[\s\S]*?x=1039 was light antialias rather than a dark seam[\s\S]*?outer antialias at x=1067 directly met the divider\/sidebar beginning at x=1068[\s\S]*?library control was opened and closed successfully[\s\S]*?narrower horizontal hit width especially needs touch acceptance/u,
	'Rail evidence must retain both the targeted live geometry result and the wider acceptance gate',
);
const notePreview = readPlugin('src/ui/note-preview.ts');
assert.match(
	notePreview,
	/isExcalidrawPreviewSource\(file, source\)[\s\S]*?createExcalidrawPreviewSvg\(this\.app, file, hostWindow\)/u,
	'Explicit and content-identified Excalidraw previews must use the plugin\'s public SVG export API instead of exposing drawing Markdown',
);
assert.match(
	notePreview,
	/file\.extension\.toLocaleLowerCase\(\) === 'canvas'[\s\S]*?generateMarkdownLink\(file, ''\)[\s\S]*?renderMarkdown\(file, `!\$\{link\}`, ''\)/u,
	'Canvas previews must retain their real Obsidian embed renderer',
);
const excalidrawPreview = readPlugin('src/excalidraw-preview.ts');
assert.match(
	excalidrawPreview,
	/isExcalidrawVersionFile\(file\)[\s\S]*?isMarkdownVersionFile\(file\) && hasExcalidrawFrontmatter\(source\)/u,
	'An ordinary .md may enter Excalidraw preview only through the official root frontmatter marker',
);
assert.match(
	excalidrawPreview,
	/EXCALIDRAW_FRONTMATTER[\s\S]*?excalidraw-plugin/u,
	'Content classification must pin the official root Excalidraw frontmatter key',
);
assert.doesNotMatch(
	excalidrawPreview,
	/hasExcalidrawDataBlock|EXCALIDRAW_DATA_HEADING|compressed-json/u,
	'Serialized drawing headings or payloads alone must never promote ordinary Markdown',
);
assert.match(
	excalidrawPreview,
	/enabledPlugins\?\.has\(EXCALIDRAW_PLUGIN_ID\)/u,
	'Excalidraw SVG preview must require the enabled plugin',
);
assert.match(
	excalidrawPreview,
	/factory\.getAPI\(\)[\s\S]*?automate\.createSVG\(file\.path, false\)/u,
	'Excalidraw SVG preview must use a disposable Automate API instance',
);
assert.match(
	excalidrawPreview,
	/finally\s*\{[\s\S]*?automate\?\.destroy\(\)/u,
	'Excalidraw preview must release its temporary Automate API instance on every outcome',
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
assert.match(
	fileExplorer,
	/const FILE_TITLE_SELECTOR = '\.nav-file-title';[\s\S]*?getFileExplorerTitlePath[\s\S]*?titleEl\.dataset\.path[\s\S]*?closest<HTMLElement>\('\.nav-file\[data-path\]'\)/u,
	'File Explorer mapping must accept desktop and mobile path placement without reading the visible filename',
);
assert.match(
	fileExplorer,
	/buildFileExplorerVisibilityPlan[\s\S]*?group\.status !== 'healthy'[\s\S]*?getOverallVersion\(group\)[\s\S]*?hiddenPaths: group\.versions/u,
	'File Explorer visibility may use a healthy precision-compatible registry mapping without authorizing mutation',
);
assert.match(
	fileExplorer,
	/for \(const hiddenPath of visibility\.hiddenPaths\)[\s\S]*?row\.addClass\('version-file-hidden'\)[\s\S]*?const v1Title = titlesByPath\.get\(visibility\.representativePath\)[\s\S]*?if \(!v1Title\) \{\s*return;/u,
	'Mounted non-V1 rows must be hidden before the optional V1 DOM decoration is attempted',
);
assert.match(
	fileExplorer,
	/getLeavesOfType\('file-explorer'\)[\s\S]*?workspace\.containerEl[\s\S]*?querySelectorAll<HTMLElement>\([\s\S]*?FILE_EXPLORER_CONTAINER_SELECTOR[\s\S]*?root\.contains\(container\)[\s\S]*?roots\.add\(container\)/u,
	'The mobile drawer must have a narrowly scoped native-container fallback when no File Explorer leaf root owns it',
);
assert.match(
	fileExplorer,
	/observeWorkspaceForExplorerRoots[\s\S]*?record\.addedNodes[\s\S]*?record\.removedNodes[\s\S]*?containsFileExplorerMarkup\(node\)[\s\S]*?childList: true,[\s\S]*?subtree: true/u,
	'Late mobile drawer mounts must trigger a filtered File Explorer refresh',
);
assert.match(
	fileExplorer,
	/observer\.observe\(root, \{[\s\S]*?attributeFilter: \['data-path'\],[\s\S]*?attributes: true,[\s\S]*?childList: true,[\s\S]*?subtree: true/u,
	'File Explorer refreshes must observe virtualized data-path reuse as well as mount changes',
);
assert.match(
	fileExplorer,
	/activeGroup\?\.key === group\.key[\s\S]*?v1Title\.addClass\('is-active', 'version-theme-active'\)/u,
	'An active hidden member must mirror Obsidian active feedback onto the visible V1 representative',
);
assert.match(
	fileExplorer,
	/getFileExplorerTitlePath\(title\) !== activePath[\s\S]*?title\.removeClass\('is-active'\)/u,
	'Mirrored active feedback must use desktop or mobile paths without stripping native V1 state',
);
assert.match(
	readPlugin('src/main.ts'),
	/resolvedVersion[\s\S]*?fileExplorer\.locateVersion[\s\S]*?openVersionManager\(file, group\.id\)/u,
	'Hidden members must expose a visible Version-owned route into their healthy relationship slot',
);
assert.match(
	readPlugin('src/ui/version-management-modal.ts'),
	/initialMemberPath[\s\S]*?versionMemberPath[\s\S]*?scrollIntoView[\s\S]*?focus\(\{ preventScroll: true \}\)/u,
	'Version management must visibly locate the exact real member supplied by a menu action',
);
const versionManagementModal = readPlugin('src/ui/version-management-modal.ts');
assert.match(
	versionManagementModal,
	/registry\.rebuild\(\)[\s\S]*?captureManagementExpectation\(record\.id\)[\s\S]*?buildDraftSlots\([\s\S]*?record\.slots,[\s\S]*?this\.registeredMembersByFile/u,
	'Version management must refresh live ctimes before capturing a full-management authorization and building slots',
);
assert.match(
	versionManagementModal,
	/function buildDraftSlots\([\s\S]*?memberResolvesToFile\(member, file\)[\s\S]*?kind: 'existing'[\s\S]*?kind: 'identity-conflict'[\s\S]*?kind: 'missing'/u,
	'Every compatible path must render as existing, while a present conflicting path remains distinct from a truly missing file',
);
assert.doesNotMatch(
	versionManagementModal,
	/compatibleReadOnly|is-compatible-read-only/u,
	'Precision compatibility must not disable the normal management controls',
);
assert.match(
	versionManagementModal,
	/this\.managementExpectation[\s\S]*?saveResolvedSeriesManagement\([\s\S]*?this\.managementExpectation,[\s\S]*?assignments/u,
	'Healthy exact and compatible management must commit through the guarded mapping-only transaction',
);
const resolvedManagementSave = versionRegistrySource.match(
	/async saveResolvedSeriesManagement\([\s\S]*?\n\t\}/u,
)?.[0] ?? '';
assert.match(
	resolvedManagementSave,
	/captureFile\(assignment\.file\)[\s\S]*?managementExpectations\.delete\(expectation\)[\s\S]*?assertExpectedRevision[\s\S]*?assertExpectedSeries[\s\S]*?originalByFile[\s\S]*?isCapturedFile/u,
	'Compatible management must consume a one-shot CAS expectation and capture every retained assignment',
);
assert.match(
	resolvedManagementSave,
	/expected\.file\.stat\.ctime !== expected\.ctime[\s\S]*?memberRecordsEqual\(assignment\.member, originalMember\)[\s\S]*?memberResolvesToFile\(originalMember, assignment\.capture\.file\)[\s\S]*?originalByPath\.has\(assignment\.member\.path\)[\s\S]*?memberRecordFromFile\(assignment\.capture\.file\)[\s\S]*?memberMatchesFile/u,
	'Retained old members must keep their stored path and ctime and exact captured object, while new files require exact live identity and cannot replace an old path',
);
const resolvedManagementDissolve = versionRegistrySource.match(
	/async dissolveResolvedSeriesManagement\([\s\S]*?\n\t\}/u,
)?.[0] ?? '';
assert.match(
	resolvedManagementDissolve,
	/managementExpectations\.delete\(expectation\)[\s\S]*?assertExpectedRevision[\s\S]*?assertExpectedSeries[\s\S]*?index\.rebuild[\s\S]*?assertResolvedSeriesExpectation\(series, expectation\)[\s\S]*?next\.splice\(seriesIndex, 1\)[\s\S]*?await this\.commit\(next\)/u,
	'Compatible dissolve must consume its one-shot CAS authorization and revalidate every captured member before forgetting the mapping',
);
assert.match(
	main,
	/if \(group && isVersionGroupExactlyResolved\(group\)\) \{[\s\S]*?openVersionFileActions[\s\S]*?openMoveTheme[\s\S]*?openDeleteVersions/u,
	'File actions, movement, and deletion must remain behind the exact-identity gate',
);
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
assert.equal(keyCount, 226);
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
		'manage.dissolveConfirmTitle': /^Stop managing this version series\?$/u,
		'manage.dissolveConfirmDescription': /No files.*deleted.*contents modified.*released files may be moved/iu,
		'manage.missingPreview': /could not be found.*repair/iu,
		'manage.keyboardPicked': /Enter or Space.*Escape/iu,
	},
	'zh-CN': {
		'delete.description': /真实文件.*废纸篓/u,
		'manage.deleteSlot': /保留文件/u,
		'manage.dissolveConfirmTitle': /^要停止管理这个版本系列吗？$/u,
		'manage.dissolveConfirmDescription': /不会删除任何文件.*不会修改文件内容.*可能.*移动/u,
		'manage.missingPreview': /无法.*找到.*修复/u,
		'manage.keyboardPicked': /Enter.*空格.*Escape/u,
	},
	da: {
		'delete.description': /faktiske fil.*papirkurv/iu,
		'manage.deleteSlot': /behold filen/iu,
		'manage.dissolveConfirmTitle': /^Stop versionsstyringen for denne serie\?$/u,
		'manage.dissolveConfirmDescription': /Ingen filer slettes.*filindholdet ændres ikke.*kan blive flyttet/iu,
		'manage.missingPreview': /ikke fundet.*reparere/iu,
		'manage.keyboardPicked': /Enter.*mellemrum.*Escape/iu,
	},
	ja: {
		'delete.description': /実ファイル.*ゴミ箱/u,
		'manage.deleteSlot': /ファイルは保持/u,
		'manage.dissolveConfirmTitle': /^このシリーズのバージョン管理を停止しますか？$/u,
		'manage.dissolveConfirmDescription': /ファイル.*削除.*内容.*変更.*ありません.*移動される場合/u,
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
