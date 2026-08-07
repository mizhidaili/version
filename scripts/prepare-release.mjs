import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const outputDirectory = `release/${manifest.version}`;
const assets = ['main.js', 'manifest.json', 'styles.css'];

mkdirSync(outputDirectory, { recursive: true });

for (const asset of assets) {
	copyFileSync(asset, `${outputDirectory}/${asset}`);
}

console.log(`Prepared ${outputDirectory}`);
console.log(`Release tag: ${manifest.version}`);
