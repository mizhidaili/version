import esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const directory = path.dirname(fileURLToPath(import.meta.url));
verifyI18nCatalogs(path.resolve(directory, '..'));

const result = await esbuild.build({
	bundle: true,
	entryPoints: [path.join(directory, 'version-model.test.ts')],
	external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
	format: 'cjs',
	logLevel: 'silent',
	platform: 'node',
	plugins: [{
		name: 'obsidian-test-mock',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({
				path: path.join(directory, 'obsidian-mock.ts'),
			}));
		},
	}],
	target: 'node20',
	write: false,
});

const code = result.outputFiles[0].text;
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', code)(
	require,
	module,
	module.exports,
);

function verifyI18nCatalogs(root) {
	const catalogs = {
		en: readCatalog(path.join(root, 'src/i18n.ts'), 'EN'),
		'zh-CN': readCatalog(path.join(root, 'src/i18n.ts'), 'ZH'),
		da: readCatalog(path.join(root, 'src/locales/da.ts'), 'DA'),
		ja: readCatalog(path.join(root, 'src/locales/ja.ts'), 'JA'),
	};
	const expectedKeyCount = 217;
	const referenceKeys = Object.keys(catalogs.en).sort();
	assert.equal(
		referenceKeys.length,
		expectedKeyCount,
		`English catalog must contain ${expectedKeyCount} keys`,
	);

	for (const [language, catalog] of Object.entries(catalogs)) {
		const keys = Object.keys(catalog).sort();
		assert.equal(
			keys.length,
			expectedKeyCount,
			`${language} catalog must contain ${expectedKeyCount} keys`,
		);
		assert.deepEqual(
			keys,
			referenceKeys,
			`${language} catalog keys must exactly match English`,
		);
		for (const key of referenceKeys) {
			assert.deepEqual(
				extractPlaceholders(catalog[key]),
				extractPlaceholders(catalogs.en[key]),
				`${language} placeholders must match English for ${key}`,
			);
		}
	}

	const selfNamedLanguageOptions = [
		'English',
		'简体中文',
		'Dansk',
		'日本語',
	];
	const settingsHeadings = {
		en: ['General', 'Version files', 'Language'],
		'zh-CN': ['常规', '版本文件', '语言'],
		da: ['Generelt', 'Versionsfiler', 'Sprog'],
		ja: ['一般', 'バージョンファイル', '言語'],
	};
	for (const [language, catalog] of Object.entries(catalogs)) {
		assert.deepEqual(
			[
				catalog['settings.english'],
				catalog['settings.chinese'],
				catalog['settings.danish'],
				catalog['settings.japanese'],
			],
			selfNamedLanguageOptions,
			`${language} language choices must remain recognizable in their own language`,
		);
		assert.deepEqual(
			[
				catalog['settings.generalHeading'],
				catalog['settings.versionFilesHeading'],
				catalog['settings.language'],
			],
			settingsHeadings[language],
			`${language} settings groups and Language label must be localized`,
		);
	}

	const destructiveSemantics = {
		en: {
			'actions.move': /version.*file/iu,
			'actions.moveSeries': /version files/iu,
			'delete.description': /real file.*trash/iu,
			'delete.selectAllDescription': /V1.*representative/iu,
			'fileExplorer.deleteVersions': /choose version files.*trash/iu,
			'actions.delete': /choose version files.*trash/iu,
			'manage.deleteSlot': /keep its file/iu,
			'view.seriesIncompleteAfterDelete': /version file.*remaining files.*visible.*repair/iu,
			'view.identityMigrationFailed': /files remain visible.*repair/iu,
		},
		'zh-CN': {
			'actions.move': /版本的文件/u,
			'actions.moveSeries': /版本文件/u,
			'delete.description': /真实文件.*废纸篓/u,
			'delete.selectAllDescription': /V1.*系列代表/u,
			'fileExplorer.deleteVersions': /选择版本文件.*废纸篓/u,
			'actions.delete': /选择版本文件.*废纸篓/u,
			'manage.deleteSlot': /保留文件/u,
			'view.seriesIncompleteAfterDelete': /版本文件.*剩余文件.*可见.*修复/u,
			'view.identityMigrationFailed': /文件将保持可见.*修复/u,
		},
		da: {
			'actions.move': /filen.*version/iu,
			'actions.moveSeries': /versionsfiler/iu,
			'delete.description': /faktiske fil.*papirkurv/iu,
			'delete.selectAllDescription': /V1.*repræsentant/iu,
			'fileExplorer.deleteVersions': /vælg versionsfiler.*papirkurv/iu,
			'actions.delete': /vælg versionsfiler.*papirkurv/iu,
			'manage.deleteSlot': /behold filen/iu,
			'view.seriesIncompleteAfterDelete': /versionsfil.*resterende filer.*synlige.*reparere/iu,
			'view.identityMigrationFailed': /filer forbliver synlige.*reparere/iu,
		},
		ja: {
			'actions.move': /バージョンのファイル/u,
			'actions.moveSeries': /バージョンファイル/u,
			'delete.description': /実ファイル.*ゴミ箱/u,
			'delete.selectAllDescription': /V1.*代表/u,
			'fileExplorer.deleteVersions': /ゴミ箱.*バージョンファイル.*選択/u,
			'actions.delete': /ゴミ箱.*バージョンファイル.*選択/u,
			'manage.deleteSlot': /ファイルは保持/u,
			'view.seriesIncompleteAfterDelete': /バージョンファイル.*残りのファイル.*表示.*修復/u,
			'view.identityMigrationFailed': /ファイルは表示されたまま.*修復/u,
		},
	};
	for (const [language, assertions] of Object.entries(destructiveSemantics)) {
		for (const [key, pattern] of Object.entries(assertions)) {
			assert.match(
				catalogs[language][key],
				pattern,
				`${language} must preserve the safety semantics of ${key}`,
			);
		}
	}
	for (const [language, catalog] of Object.entries(catalogs)) {
		assert.equal(
			catalog['actions.delete'], catalog['fileExplorer.deleteVersions'],
			`${language} must use one explicit trash-selection entry label`,
		);
	}

	const releasedVersionDestinationSemantics = {
		en: {
			description: /moved automatically.*version slot is deleted.*removing only the file.*choose its location/iu,
			emptyNote: 'Empty note',
		},
		'zh-CN': {
			description: /删除版本槽位.*自动移动.*仅移出文件.*自行选择位置/u,
			emptyNote: '空笔记',
		},
		da: {
			description: /automatisk flyttes.*versionsplads slettes.*kun filen fjernes.*vælges frit/iu,
			emptyNote: 'Tom note',
		},
		ja: {
			description: /バージョンスロットを削除.*自動的に移動.*ファイルだけを外す.*自由に選べ/u,
			emptyNote: '空のノート',
		},
	};
	for (const [language, expected] of Object.entries(releasedVersionDestinationSemantics)) {
		assert.match(
			catalogs[language]['settings.releasedVersionDestinationDescription'],
			expected.description,
			`${language} must distinguish deleting a version slot from removing only its file`,
		);
		assert.equal(
			catalogs[language]['link.emptyVersion'],
			expected.emptyNote,
			`${language} empty-file preview must describe an empty note`,
		);
	}

	for (const [key, value] of Object.entries(catalogs.en)) {
		assert.doesNotMatch(value, /\btheme\b/iu, `${key} must use topic, not theme`);
	}
	for (const [key, value] of Object.entries(catalogs.ja)) {
		assert.doesNotMatch(value, /テーマ/u, `${key} must use トピック, not テーマ`);
	}

	const typeNeutralKeys = [
		'settings.releasedVersionDestination',
		'settings.releasedVersionDestinationDescription',
		'delete.title',
		'delete.description',
		'delete.selectAllDescription',
		'preview.open',
		'preview.openFailed',
		'manage.dragDescription',
		'manage.library',
		'manage.libraryDrop',
		'manage.available',
		'manage.search',
		'manage.noFiles',
		'manage.dropHere',
		'manage.unassignedVersion',
		'manage.releaseMoveFailed',
		'manage.dissolveConfirmDescription',
		'manage.dissolved',
		'manage.v1Required',
		'manage.twoVersionsRequired',
		'manage.v1MoveRequired',
		'manage.emptyPreview',
		'manage.missingPreview',
		'series.createPreview',
		'series.summary',
		'series.noResolvedFiles',
		'view.seriesIncompleteAfterDelete',
	];
	const typeSpecificTerms = {
		en: /\b(?:Markdown|note|notes)\b/iu,
		'zh-CN': /Markdown|笔记/u,
		da: /Markdown|note|noter|notefil/iu,
		ja: /Markdown|ノート/u,
	};
	for (const [language, pattern] of Object.entries(typeSpecificTerms)) {
		for (const key of typeNeutralKeys) {
			assert.doesNotMatch(
				catalogs[language][key],
				pattern,
				`${language} ${key} must describe supported files generically`,
			);
		}
	}

	console.log(
		`i18n catalog audit passed: ${expectedKeyCount} keys across ${Object.keys(catalogs).length} locales`,
	);
}

function readCatalog(filePath, variableName) {
	const sourceText = readFileSync(filePath, 'utf8');
	const sourceFile = ts.createSourceFile(
		filePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) continue;
			if (declaration.name.text !== variableName || !declaration.initializer) continue;
			const object = unwrapExpression(declaration.initializer);
			assert.ok(
				ts.isObjectLiteralExpression(object),
				`${variableName} must be an object literal`,
			);
			const catalog = {};
			for (const property of object.properties) {
				assert.ok(
					ts.isPropertyAssignment(property),
					`${variableName} must contain only property assignments`,
				);
				const key = readPropertyName(property.name);
				const value = unwrapExpression(property.initializer);
				assert.ok(
					ts.isStringLiteralLike(value),
					`${variableName}.${key} must be a static string`,
				);
				assert.equal(catalog[key], undefined, `${variableName}.${key} is duplicated`);
				catalog[key] = value.text;
			}
			return catalog;
		}
	}
	assert.fail(`Could not find ${variableName} in ${filePath}`);
}

function readPropertyName(name) {
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
	assert.fail('Translation keys must use static property names');
}

function unwrapExpression(expression) {
	let current = expression;
	while (
		ts.isAsExpression(current)
		|| ts.isSatisfiesExpression(current)
		|| ts.isParenthesizedExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function extractPlaceholders(value) {
	return [...value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/gu)]
		.map((match) => match[1])
		.sort();
}
