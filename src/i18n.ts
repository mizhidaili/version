import { DA } from './locales/da';
import { JA } from './locales/ja';

export const SUPPORTED_LANGUAGES = ['en', 'zh-CN', 'da', 'ja'] as const;
export type VersionLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isVersionLanguage(value: unknown): value is VersionLanguage {
	return SUPPORTED_LANGUAGES.includes(value as VersionLanguage);
}

const EN = {
	'common.cancel': 'Cancel',
	'common.version': 'version',
	'common.versions': 'versions',
	'settings.generalHeading': 'General',
	'settings.versionFilesHeading': 'Version files',
	'settings.language': 'Language',
	'settings.languageDescription':
		'Language used throughout Version, including this settings page.',
	'settings.english': 'English',
	'settings.chinese': '简体中文',
	'settings.danish': 'Dansk',
	'settings.japanese': '日本語',
	'settings.releasedVersionDestination': 'File location after deleting a version',
	'settings.releasedVersionDestinationDescription':
		'Choose where a released file is moved automatically after its version slot is deleted in Version management. When removing only the file, you can choose its location.',
	'settings.releasedVersionSeriesFolder': 'Current topic folder',
	'settings.releasedVersionVaultRoot': 'Vault root',
	'settings.filenameTemplate': 'New version filename',
	'settings.filenameTemplateDescription':
		'Default filename for versions created by Version. Use {{name}} for the V1 filename and {{version}} for the version number.',
	'settings.filenameTemplateInvalid':
		'Use a valid filename template containing {{version}} and no path separators.',
	'command.verifyInstallation': 'Verify installation',
	'command.insertLink': 'Insert link',
	'command.importRecovered':
		'Import recovered Markdown copy to vault root',
	'command.showBacklinks': 'Show backlinks for this topic',
	'command.manageVersions': 'Manage or create versions',
	'command.renameTheme': 'Rename topic',
	'notice.running': 'Version is running.',
	'fileExplorer.countLabel': '{{count}} {{unit}}',
	'fileExplorer.countAria': '{{count}} {{unit}}',
	'fileExplorer.openTheme': 'Open topic',
	'fileExplorer.openNewTab': 'Open topic in new tab',
	'fileExplorer.openNewGroup': 'Open topic in new tab group',
	'fileExplorer.openNewWindow': 'Open topic in new window',
	'fileExplorer.chooseVersion': 'Choose a version…',
	'fileExplorer.manageVersions': 'Manage versions…',
	'fileExplorer.locateVersion': 'Show V{{version}} in Version management…',
	'fileExplorer.createVersions': 'Create versions for this note…',
	'fileExplorer.moveTheme': 'Move topic to…',
	'fileExplorer.fileActions': 'Choose a version for file actions…',
	'fileExplorer.fileActionsPlaceholder':
		'Choose the one version this file action should affect',
	'fileExplorer.importRecovered': 'Import recovered Markdown copy…',
	'fileExplorer.deleteVersions': 'Choose version files to move to trash…',
	'fileExplorer.openFailed': 'Could not open version: {{message}}',
	'fileExplorer.versionNotFound':
		'Could not find this version in the file explorer.',
	'delete.title': 'Move files from {{topic}} to trash',
	'delete.description':
		"Nothing is selected by default. Select only the versions you intend to remove. Each selected version's real file will be moved to the trash location configured in Obsidian.",
	'delete.descriptionExact':
		'V{{version}} is selected from the version action you opened. Review it before moving its real file to the trash location configured in Obsidian.',
	'delete.selectAll': 'Select all removable versions',
	'delete.selectAllDescription':
		'V1 remains as the series representative.',
	'delete.v1RequiresAll':
		'V1 represents the series. Replace it in Version management before removing its file.',
	'delete.moveSelected': 'Move selected files to trash',
	'delete.moveCount': 'Move files for {{count}} {{unit}} to trash',
	'delete.versionLabel': 'Version {{version}}',
	'delete.selectedMissing': 'The files for the selected versions no longer exist.',
	'delete.selectedChanged':
		'{{count}} selected file(s) changed after this dialog opened. Nothing was moved to trash. Reopen the dialog and review the current files.',
	'delete.releaseFailed':
		'The version relationship could not be updated, so no files were moved to trash: {{message}}',
	'delete.moved': '{{count}} {{subject}} moved to trash.',
	'delete.failed':
		'Could not move the real files for {{count}} {{unit}} to trash. Review the files that remain in the vault.',
	'delete.subjectOne': 'file was',
	'delete.subjectMany': 'files were',
	'move.placeholder': 'Move {{topic}} to a folder',
	'move.noFolders': 'No matching folders',
	'move.vaultRoot': 'Vault root',
	'move.alreadyThere': 'This topic is already in that folder.',
	'move.collision':
		'Move cancelled: {{count}} {{subject}} at the destination. No versions were moved.',
	'move.collisionOne': 'file already exists',
	'move.collisionMany': 'files already exist',
	'move.success': 'Moved {{count}} {{unit}} to {{destination}}.',
	'move.rootDestination': 'the vault root',
	'move.failed': 'Could not move topic. Details: {{message}}',
	'move.rollback':
		'{{count}} moved {{subject}} manual attention.',
	'move.rollbackOne': 'file needs',
	'move.rollbackMany': 'files need',
	'import.chooseMarkdown': 'Choose a Markdown file to import.',
	'import.success': 'Imported a recovered copy as {{path}}.',
	'import.failed': 'Could not import recovered Markdown: {{message}}',
	'link.chooseTheme': 'Choose a topic',
	'link.chooseVersion': 'Choose a version of {{topic}}',
	'link.noVersions': 'No matching versions',
	'link.overall': 'Whole topic',
	'link.version': 'Version {{version}}',
	'link.versionAlias': '{{topic}} (V{{version}})',
	'link.emptyVersion': 'Empty note',
	'preview.loading': 'Loading preview…',
	'preview.open': 'Open file',
	'preview.openFailed': 'Could not open file: {{message}}',
	'preview.openVisual': 'Open this visual note to view its full canvas.',
	'manage.title': 'Manage versions',
	'manage.description':
		'Changes are staged here. Files and Version relationships change only after you choose Done.',
	'manage.dragDescription':
		'Drag files into version slots or onto another version to swap. Changes are saved only when you choose Done.',
	'manage.library': 'Available files',
	'manage.libraryDrop': 'Drop here to remove a file from this series',
	'manage.available': 'Available files',
	'manage.search': 'Search files…',
	'manage.noFiles': 'No available files',
	'manage.versions': 'Versions',
	'manage.addBlank': 'Add a blank version',
	'manage.addVersion': 'Add new version',
	'manage.boardHelp':
		'Drop into a slot; drop onto another version to swap.',
	'manage.dropHere': 'Drop a file here',
	'manage.deleteSlot':
		'Remove version {{version}} from the series (keep its file)',
	'manage.restoreSlot': 'Create a blank note for Version {{version}}',
	'manage.unassignedVersion':
		'Version {{version}} does not have a file. Assign a file or remove this version before choosing Done.',
	'manage.releaseCollision':
		'Cannot remove {{name}} from the series: a file with the same name already exists in {{destination}}.',
	'manage.releaseMoveFailed':
		'The Version relationship was saved, but {{count}} files removed from the series could not be moved. They remain readable in their previous locations.',
	'manage.rollbackFailed':
		'After the save failed, newly created blank notes could not be removed ({{count}} total). They remain visible and readable.',
	'manage.slotAria': 'Version {{version}} slot',
	'manage.dragVersion': 'Drag to change this version relationship',
	'manage.missing': 'Missing: {{name}}',
	'manage.createdOnDone': 'Created only after you choose Done',
	'manage.remove': 'Remove from this series',
	'manage.move': 'Change version position',
	'manage.keyboardPicked':
		'Picked up {{label}}. Move to a Version drag handle and press Enter or Space to drop. Press Escape to cancel.',
	'manage.keyboardDropTarget':
		'Drop on {{version}}; press Enter or Space.',
	'manage.keyboardMoved': 'Moved {{label}} to {{version}}.',
	'manage.keyboardCancelled': 'Cancelled moving {{label}}.',
	'manage.done': 'Done',
	'manage.dissolve': 'Dissolve series',
	'manage.dissolveConfirmTitle': 'Dissolve this version series?',
	'manage.dissolveConfirmDescription':
		'Only V1 remains. This removes the Version relationship, but does not delete or modify any member files.',
	'manage.keepSeries': 'Keep series',
	'manage.dissolved':
		'Version relationship dissolved. No files were changed.',
	'manage.v1Required': 'Choose an existing file for V1.',
	'manage.twoVersionsRequired':
		'Add at least two files before creating a Version series.',
	'manage.v1MoveRequired':
		'Drag another file onto V1 before moving the current V1 out of the series.',
	'manage.emptyPreview': 'This version slot does not have a file.',
	'manage.pendingPreview':
		'This blank Markdown file has not been created yet. It will be created only after you choose Done.',
	'manage.missingPreview':
		'The registered file could not be found at {{path}}. Drag the correct file into this slot to repair it.',
	'manage.invalidName': 'The new Markdown filename is not valid.',
	'manage.nameExists': '{{path}} already exists.',
	'manage.saved': 'Version relationship saved.',
	'manage.saveFailed': 'Could not save Version relationship: {{message}}',
	'series.search': 'Search version series…',
	'series.empty': 'No matching version series',
	'series.create': 'Create a version series',
	'series.createFrom': 'Start with {{name}} as V1',
	'series.createEmpty': 'Assign V1 in version management',
	'series.createPreview':
		'Drag an existing file into V1, then add or assign more versions.',
	'series.summary': '{{count}} files found · {{status}}',
	'series.noResolvedFiles':
		'No registered files for this series can be found. Open version management and assign the correct files to repair the relationship.',
	'series.status.healthy': 'Ready',
	'series.status.incomplete': 'Needs repair',
	'series.status.invalid': 'Invalid relationship',
	'actions.title': 'Choose a version of {{topic}}',
	'actions.versions': 'Versions',
	'actions.actions': 'File actions',
	'actions.open': 'Open',
	'actions.openNewTab': 'Open in new tab',
	'actions.openSplit': 'Open in new tab group',
	'actions.openWindow': 'Open in new window',
	'actions.duplicate': 'Create an ordinary file copy',
	'actions.move': 'Move this version’s file…',
	'actions.moveSeries': 'Move all version files…',
	'actions.rename': 'Rename this version’s file…',
	'actions.copyPath': 'Copy path',
	'actions.defaultApp': 'Open in default app',
	'actions.reveal': 'Show in system file manager',
	'actions.versionHistory': 'Open version history',
	'actions.versionHistoryUnavailable': 'File Recovery is not available.',
	'actions.manage': 'Manage version relationship…',
	'actions.delete': 'Choose version files to move to trash…',
	'actions.duplicated': 'Created an ordinary file copy at {{path}}.',
	'actions.pathCopied': 'Path copied.',
	'actions.failed': 'File action failed: {{message}}',
	'actions.renameTitle': 'Rename version file',
	'actions.filename': 'Filename',
	'actions.movePlaceholder': 'Move {{name}} to a folder',
	'merge.action': 'Merge this note into…',
	'merge.chooseTarget': 'Choose a note',
	'merge.v1Blocked':
		'Replace V1 in Version management before merging its file.',
	'merge.unavailable': 'Note Composer is not available.',
	'merge.failed': 'Could not merge note: {{message}}',
	'editor.navigate': 'navigate',
	'editor.select': 'select',
	'editor.dismiss': 'dismiss',
	'backlinks.title': 'Backlinks to {{topic}}',
	'backlinks.empty': 'No backlinks found.',
	'backlinks.openFailed': 'Could not open backlink: {{message}}',
	'reuse.title': 'Create V{{version}}?',
	'reuse.warning':
		'V{{version}} may still exist in Trash, File recovery, or Sync history.',
	'reuse.description':
		'Creating {{topic}} (V{{version}}).md reuses the same path. The system Put Back action may be blocked by the new file, while restoring a snapshot may replace its contents.',
	'reuse.create': 'Create V{{version}}',
	'create.title': 'Create V{{version}}',
	'create.description':
		'This creates one new, empty Markdown file. No content is copied from another version.',
	'create.gapWarning':
		'V{{version}} may still exist in Trash, File recovery, or Sync history. Use a different filename if you want both copies to remain easy to distinguish.',
	'create.filename': 'Markdown filename',
	'create.filenameDescription':
		'Version membership is stored explicitly and does not depend on this filename.',
	'create.confirm': 'Create V{{version}}',
	'create.invalidFilename': 'Enter a valid Markdown filename without folder separators.',
	'view.openAnotherFailed':
		'Could not open another version: {{message}}',
	'view.openVersionAria': 'Open {{topic}} version {{version}}',
	'view.versionActions': 'Right-click for version actions',
	'view.fileActionsForVersion': 'File actions for V{{version}}…',
	'view.versionsAria': 'Versions',
	'view.addEmpty': 'Add empty version',
	'view.renameTheme': 'Rename topic',
	'view.createSecond': 'Create an empty second version',
	'view.repairVersions': 'Repair version relationship',
	'view.deleteVersion': 'Delete V{{version}}',
	'view.openFailed': 'Could not open version: {{message}}',
	'view.renameFailed': 'Could not rename topic: {{message}}',
	'view.setupExists': 'Cannot create versions: {{path}} already exists.',
	'view.rollbackAttention':
		'Version setup rollback needs attention: {{path}}',
	'view.setupFailed': 'Could not create the first versions: {{message}}',
	'view.limitReached': 'Version limit reached: V{{version}}.',
	'view.createVersion': 'Create V{{version}}',
	'view.maximumVersion': 'Maximum version is V{{version}}',
	'view.fillMissing': 'Fill a missing version',
	'view.range': 'Version numbers must be between V1 and V{{version}}.',
	'view.alreadyExists': 'V{{version}} already exists.',
	'view.createExists': 'Cannot create version: {{path}} already exists.',
	'view.createManagedExists':
		'Cannot create {{path}}: it already belongs to {{topic}} as V{{version}}.',
	'view.createFailed': 'Could not create version: {{message}}',
	'view.rollbackFailed':
		'Could not remove the newly created blank note at {{path}} after registration failed. It remains visible and readable.',
	'view.registryUpdateFailed':
		'The Version relationship could not be updated after the file moved or was renamed. All affected files remain visible. {{message}}',
	'view.identityMigrationFailed':
		'Version could not verify older member identities. Affected files remain visible; open Version management to repair the relationship. {{message}}',
	'view.seriesIncompleteAfterDelete':
		'A version file was removed outside the Version safety dialog. The remaining files are visible. Restore the missing file or open Version management to repair the relationship.',
	'view.deleteV1Warning':
		'Deleting version 1 can leave existing overall links unresolved.',
	'view.deleteFailed': 'Could not delete version: {{message}}',
} as const;

export type TranslationKey = keyof typeof EN;

const ZH: Record<TranslationKey, string> = {
	'common.cancel': '取消',
	'common.version': '个版本',
	'common.versions': '个版本',
	'settings.generalHeading': '常规',
	'settings.versionFilesHeading': '版本文件',
	'settings.language': '语言',
	'settings.languageDescription':
		'Version 全部界面使用的语言，包括此设置页。',
	'settings.english': 'English',
	'settings.chinese': '简体中文',
	'settings.danish': 'Dansk',
	'settings.japanese': '日本語',
	'settings.releasedVersionDestination': '删除版本后的文件位置',
	'settings.releasedVersionDestinationDescription':
		'选择在版本管理中删除版本槽位后，被释放文件自动移动的位置。仅移出文件时，可自行选择位置。',
	'settings.releasedVersionSeriesFolder': '当前主题所在文件夹',
	'settings.releasedVersionVaultRoot': '仓库根目录',
	'settings.filenameTemplate': '新版本文件名',
	'settings.filenameTemplateDescription':
		'Version 新建版本时使用的默认文件名。{{name}} 表示 V1 的文件名，{{version}} 表示版本号。',
	'settings.filenameTemplateInvalid':
		'请输入包含 {{version}} 且不含路径分隔符的有效文件名模板。',
	'command.verifyInstallation': '验证安装',
	'command.insertLink': '插入链接',
	'command.importRecovered': '将恢复的 Markdown 副本导入仓库根目录',
	'command.showBacklinks': '显示当前主题的反向链接',
	'command.manageVersions': '管理或创建版本',
	'command.renameTheme': '重命名主题',
	'notice.running': 'Version 正在运行。',
	'fileExplorer.countLabel': '{{count}}{{unit}}',
	'fileExplorer.countAria': '{{count}}{{unit}}',
	'fileExplorer.openTheme': '打开主题',
	'fileExplorer.openNewTab': '在新标签页中打开主题',
	'fileExplorer.openNewGroup': '在新标签组中打开主题',
	'fileExplorer.openNewWindow': '在新窗口中打开主题',
	'fileExplorer.chooseVersion': '选择版本…',
	'fileExplorer.manageVersions': '管理版本…',
	'fileExplorer.locateVersion': '在版本管理中显示 V{{version}}…',
	'fileExplorer.createVersions': '为该笔记创建版本…',
	'fileExplorer.moveTheme': '将整个主题移动到…',
	'fileExplorer.fileActions': '选择版本进行操作…',
	'fileExplorer.fileActionsPlaceholder':
		'选择本次文件操作要影响的一个版本',
	'fileExplorer.importRecovered': '导入恢复的 Markdown 副本…',
	'fileExplorer.deleteVersions': '选择版本文件移入废纸篓…',
	'fileExplorer.openFailed': '无法打开版本：{{message}}',
	'fileExplorer.versionNotFound': '无法在文件列表中找到这个版本。',
	'delete.title': '将“{{topic}}”中的文件移入废纸篓',
	'delete.description':
		'默认不选择任何版本。请只选择确实要移除的版本；每个所选版本对应的真实文件都会进入 Obsidian 当前设置的废纸篓。',
	'delete.descriptionExact':
		'已根据你刚才打开的版本操作选中 V{{version}}。请确认无误后，再将它的真实文件移入 Obsidian 当前设置的废纸篓。',
	'delete.selectAll': '选择全部可移除版本',
	'delete.selectAllDescription':
		'V1 会作为系列代表保留。',
	'delete.v1RequiresAll': 'V1 代表整个系列。请先在版本管理中更换 V1，再移除它的文件。',
	'delete.moveSelected': '将所选文件移入废纸篓',
	'delete.moveCount': '将 {{count}}{{unit}}对应的文件移入废纸篓',
	'delete.versionLabel': '版本 {{version}}',
	'delete.selectedMissing': '所选版本对应的文件已经不存在。',
	'delete.selectedChanged':
		'此窗口打开后，有 {{count}} 个所选文件发生了变化。没有文件被移入废纸篓；请重新打开窗口并确认当前文件。',
	'delete.releaseFailed':
		'无法更新版本关系，因此没有文件被移入废纸篓：{{message}}',
	'delete.moved': '已将 {{count}}{{subject}}移入废纸篓。',
	'delete.failed':
		'有 {{count}}{{unit}}对应的真实文件无法移入废纸篓；请检查仍留在仓库中的文件。',
	'delete.subjectOne': '个文件',
	'delete.subjectMany': '个文件',
	'move.placeholder': '将“{{topic}}”移动到文件夹',
	'move.noFolders': '没有匹配的文件夹',
	'move.vaultRoot': '仓库根目录',
	'move.alreadyThere': '这个主题已经在该文件夹中。',
	'move.collision':
		'移动已取消：目标位置存在 {{count}}{{subject}}。没有移动任何版本。',
	'move.collisionOne': '个同名文件',
	'move.collisionMany': '个同名文件',
	'move.success': '已将 {{count}}{{unit}}移动到{{destination}}。',
	'move.rootDestination': '仓库根目录',
	'move.failed': '无法移动主题。详细信息：{{message}}',
	'move.rollback': '有 {{count}}{{subject}}需要手动处理。',
	'move.rollbackOne': '个已移动文件',
	'move.rollbackMany': '个已移动文件',
	'import.chooseMarkdown': '请选择要导入的 Markdown 文件。',
	'import.success': '恢复副本已导入为 {{path}}。',
	'import.failed': '无法导入恢复的 Markdown：{{message}}',
	'link.chooseTheme': '选择主题',
	'link.chooseVersion': '选择“{{topic}}”的版本',
	'link.noVersions': '没有匹配的版本',
	'link.overall': '整体',
	'link.version': '版本 {{version}}',
	'link.versionAlias': '{{topic}}（V{{version}}）',
	'link.emptyVersion': '空笔记',
	'preview.loading': '正在加载预览…',
	'preview.open': '打开文件',
	'preview.openFailed': '无法打开文件：{{message}}',
	'preview.openVisual': '请打开这篇可视化笔记以查看完整画布。',
	'manage.title': '版本管理',
	'manage.description':
		'这里的调整会先暂存；只有点击“完成”后，才会创建文件或修改版本关系。',
	'manage.dragDescription':
		'把文件拖入版本槽位，或拖到另一版本上交换位置。只有点击“完成”后才会保存。',
	'manage.library': '可接纳的文件',
	'manage.libraryDrop': '拖到这里，将文件从当前系列中移出',
	'manage.available': '可接纳的文件',
	'manage.search': '搜索文件…',
	'manage.noFiles': '没有可接纳的文件',
	'manage.versions': '版本',
	'manage.addBlank': '添加空白版本',
	'manage.addVersion': '增添新版本',
	'manage.boardHelp': '拖入槽位；拖到另一版本上可交换。',
	'manage.dropHere': '将一个文件拖到这里',
	'manage.deleteSlot': '从系列中移除版本 {{version}}（保留文件）',
	'manage.restoreSlot': '用空白笔记重新插入版本 {{version}}',
	'manage.unassignedVersion':
		'版本 {{version}} 还没有对应文件。请先放入一个文件，或移除这个版本，再点击“完成”。',
	'manage.releaseCollision':
		'无法将“{{name}}”移至{{destination}}：那里已经存在同名文件。',
	'manage.releaseMoveFailed':
		'版本关系已经保存，但有 {{count}} 个移出的文件未能移动；它们仍可在原位置正常读取。',
	'manage.rollbackFailed':
		'保存失败后，有 {{count}} 篇新建的空白笔记未能移除；它们仍然可见且可以正常读取。',
	'manage.slotAria': '版本 {{version}} 槽位',
	'manage.dragVersion': '拖动以调整版本关系',
	'manage.missing': '缺失：{{name}}',
	'manage.createdOnDone': '点击“完成”后才会创建',
	'manage.remove': '从这个系列中移出',
	'manage.move': '调整版本位置',
	'manage.keyboardPicked':
		'已拿起 {{label}}。请移动到目标版本的拖动控制点，按 Enter 或空格放下；按 Escape 取消。',
	'manage.keyboardDropTarget':
		'放到 {{version}}；按 Enter 或空格确认。',
	'manage.keyboardMoved': '已将 {{label}} 放到 {{version}}。',
	'manage.keyboardCancelled': '已取消移动 {{label}}。',
	'manage.done': '完成',
	'manage.dissolve': '解散版本系列',
	'manage.dissolveConfirmTitle': '要解散这个版本系列吗？',
	'manage.dissolveConfirmDescription':
		'当前只剩 V1。继续将移除 Version 关系，但不会删除或修改任何成员文件。',
	'manage.keepSeries': '保留版本系列',
	'manage.dissolved': '版本关系已解散；没有修改任何文件。',
	'manage.v1Required': '必须为 V1 选择一个现有文件。',
	'manage.twoVersionsRequired': '至少放入两个文件后才能创建版本系列。',
	'manage.v1MoveRequired': '请先把另一个文件拖到 V1，再将原来的 V1 移出系列。',
	'manage.emptyPreview': '这个版本槽位目前没有对应文件。',
	'manage.pendingPreview': '这篇空白 Markdown 尚未创建；只有点击“完成”后才会真正写入仓库。',
	'manage.missingPreview':
		'无法在 {{path}} 找到登记的文件。请把正确的文件拖到这个槽位进行修复。',
	'manage.invalidName': '新 Markdown 的文件名无效。',
	'manage.nameExists': '{{path}} 已经存在。',
	'manage.saved': '版本关系已保存。',
	'manage.saveFailed': '无法保存版本关系：{{message}}',
	'series.search': '搜索版本系列…',
	'series.empty': '没有匹配的版本系列',
	'series.create': '创建版本系列',
	'series.createFrom': '以“{{name}}”作为 V1 开始',
	'series.createEmpty': '在版本管理中放入 V1',
	'series.createPreview': '把一个现有文件拖入 V1，然后继续新增或接纳其他版本。',
	'series.summary': '找到 {{count}} 个文件 · {{status}}',
	'series.noResolvedFiles': '目前找不到这个系列登记的文件。请打开版本管理，放入正确文件以修复关系。',
	'series.status.healthy': '正常',
	'series.status.incomplete': '需要修复',
	'series.status.invalid': '关系无效',
	'actions.title': '选择“{{topic}}”的版本进行操作',
	'actions.versions': '版本',
	'actions.actions': '文件操作',
	'actions.open': '打开',
	'actions.openNewTab': '在新标签页中打开',
	'actions.openSplit': '在新标签组中打开',
	'actions.openWindow': '在新窗口中打开',
	'actions.duplicate': '创建普通文件副本',
	'actions.move': '移动这个版本的文件…',
	'actions.moveSeries': '移动全部版本文件…',
	'actions.rename': '重命名这个版本的文件…',
	'actions.copyPath': '复制路径',
	'actions.defaultApp': '使用默认应用打开',
	'actions.reveal': '在系统文件管理器中显示',
	'actions.versionHistory': '打开版本历史',
	'actions.versionHistoryUnavailable': '文件恢复功能当前不可用。',
	'actions.manage': '管理版本关系…',
	'actions.delete': '选择版本文件移入废纸篓…',
	'actions.duplicated': '已在 {{path}} 创建普通文件副本。',
	'actions.pathCopied': '路径已复制。',
	'actions.failed': '文件操作失败：{{message}}',
	'actions.renameTitle': '重命名版本文件',
	'actions.filename': '文件名',
	'actions.movePlaceholder': '将“{{name}}”移动到文件夹',
	'merge.action': '将这篇笔记合并到…',
	'merge.chooseTarget': '选择目标笔记',
	'merge.v1Blocked': '请先在版本管理中更换 V1，再合并它的文件。',
	'merge.unavailable': '笔记重组功能当前不可用。',
	'merge.failed': '无法合并笔记：{{message}}',
	'editor.navigate': '移动选择',
	'editor.select': '选择',
	'editor.dismiss': '关闭',
	'backlinks.title': '指向“{{topic}}”的反向链接',
	'backlinks.empty': '没有找到反向链接。',
	'backlinks.openFailed': '无法打开反向链接：{{message}}',
	'reuse.title': '创建 V{{version}}？',
	'reuse.warning':
		'废纸篓、文件恢复或同步历史中可能仍然存在 V{{version}}。',
	'reuse.description':
		'创建 {{topic}} (V{{version}}).md 会重新占用同一路径。系统的“放回原处”可能因此被阻止，而恢复快照可能替换新文件内容。',
	'reuse.create': '创建 V{{version}}',
	'create.title': '创建 V{{version}}',
	'create.description': '这只会创建一篇新的空白 Markdown，不会复制其他版本的正文。',
	'create.gapWarning':
		'废纸篓、文件恢复或同步历史中可能仍有 V{{version}}。如果希望两份内容容易区分，可以在这里使用不同文件名。',
	'create.filename': 'Markdown 文件名',
	'create.filenameDescription': '版本归属由插件明确登记，不依赖这里的文件名。',
	'create.confirm': '创建 V{{version}}',
	'create.invalidFilename': '请输入不含文件夹分隔符的有效 Markdown 文件名。',
	'view.openAnotherFailed': '无法打开其他版本：{{message}}',
	'view.openVersionAria': '打开“{{topic}}”的版本 {{version}}',
	'view.versionActions': '右键打开版本操作',
	'view.fileActionsForVersion': '对 V{{version}} 执行文件操作…',
	'view.versionsAria': '版本',
	'view.addEmpty': '新增空白版本',
	'view.renameTheme': '重命名主题',
	'view.createSecond': '创建第二个空白版本',
	'view.repairVersions': '修复版本关系',
	'view.deleteVersion': '删除 V{{version}}',
	'view.openFailed': '无法打开版本：{{message}}',
	'view.renameFailed': '无法重命名主题：{{message}}',
	'view.setupExists': '无法创建版本：{{path}} 已经存在。',
	'view.rollbackAttention': '版本初始化回滚需要处理：{{path}}',
	'view.setupFailed': '无法创建最初两个版本：{{message}}',
	'view.limitReached': '已达到版本上限 V{{version}}。',
	'view.createVersion': '创建 V{{version}}',
	'view.maximumVersion': '最大版本号为 V{{version}}',
	'view.fillMissing': '填补空缺版本',
	'view.range': '版本号必须介于 V1 与 V{{version}} 之间。',
	'view.alreadyExists': 'V{{version}} 已经存在。',
	'view.createExists': '无法创建版本：{{path}} 已经存在。',
	'view.createManagedExists': '无法创建 {{path}}：它已经是“{{topic}}”的 V{{version}}。',
	'view.createFailed': '无法创建版本：{{message}}',
	'view.rollbackFailed':
		'版本登记失败后，无法移除新建的空白笔记 {{path}}；它仍然可见且可以正常读取。',
	'view.registryUpdateFailed':
		'文件移动或重命名后，Version 关系无法保存；受影响的文件将保持可见。{{message}}',
	'view.identityMigrationFailed':
		'Version 无法核验旧版成员身份；受影响的文件将保持可见。请打开版本管理修复关系。{{message}}',
	'view.seriesIncompleteAfterDelete':
		'有一个版本文件绕过 Version 的安全选择界面被移除。剩余文件已恢复为可见；请恢复缺失文件，或打开版本管理修复关系。',
	'view.deleteV1Warning': '删除 V1 可能使已有的整体链接失效。',
	'view.deleteFailed': '无法删除版本：{{message}}',
};

export class VersionI18n {
	constructor(private language: VersionLanguage) {}

	setLanguage(language: VersionLanguage): void {
		this.language = language;
	}

	getLanguage(): VersionLanguage {
		return this.language;
	}

	t(
		key: TranslationKey,
		variables: Record<string, string | number> = {},
	): string {
		const catalogs: Record<
			VersionLanguage,
			Readonly<Record<TranslationKey, string>>
		> = {
			da: DA,
			en: EN,
			ja: JA,
			'zh-CN': ZH,
		};
		const template = catalogs[this.language][key];
		return template.replace(
			/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu,
			(_match: string, name: string) => {
				const value = variables[name];
				return value === undefined ? '' : String(value);
			},
		);
	}
}
