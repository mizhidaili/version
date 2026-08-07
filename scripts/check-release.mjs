import { readFileSync, statSync } from 'node:fs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const manifest = readJson('manifest.json');
const packageJson = readJson('package.json');
const versions = readJson('versions.json');

const errors = [];
const semver = /^\d+\.\d+\.\d+$/;

if (manifest.id !== 'version') errors.push('manifest id must be "version".');
if (manifest.name !== 'Multi-Version Notes') errors.push('manifest name must be "Multi-Version Notes".');
if (!semver.test(manifest.version)) errors.push('manifest version must use x.y.z format.');
if (packageJson.version !== manifest.version) errors.push('package.json and manifest.json versions differ.');
if (versions[manifest.version] !== manifest.minAppVersion) {
	errors.push('versions.json does not map the current version to minAppVersion.');
}
if (manifest.author !== 'Ikue') errors.push('manifest author must be "Ikue".');
if (manifest.isDesktopOnly !== false) errors.push('isDesktopOnly must remain false for the tested iPad build.');

for (const file of ['README.md', 'LICENSE', 'main.js', 'manifest.json', 'styles.css']) {
	try {
		if (statSync(file).size === 0) errors.push(`${file} is empty.`);
	} catch {
		errors.push(`${file} is missing.`);
	}
}

if (errors.length > 0) {
	console.error('Release check failed:');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log(`Release check passed for Multi-Version Notes ${manifest.version}.`);
console.log('GitHub release assets: main.js, manifest.json, styles.css');
