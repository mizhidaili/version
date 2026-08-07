import tsparser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
	{
		ignores: [
			'.github/',
			'.workflow/',
			'esbuild.config.mjs',
			'eslint.config.mts',
			'main.js',
			'node_modules/',
			'release/',
			'scripts/',
			'tests/',
			'version-bump.mjs',
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				project: './tsconfig.json',
			},
		},
	},
]);
