import esbuild from 'esbuild';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const result = await esbuild.build({
	bundle: true,
	entryPoints: [path.join(directory, 'registry-failure-diagnostic.ts')],
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
