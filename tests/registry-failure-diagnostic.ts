import assert from 'node:assert/strict';
import { TFile, Vault } from 'obsidian';
import { memberRecordFromFile } from '../src/version-data';
import { VersionRegistry } from '../src/version-registry';

async function run(): Promise<void> {
	const vault = new Vault([
		'Topic.md',
		'Parallel.md',
	]) as unknown as Vault;
	const topic = vault.getFileByPath('Topic.md') as unknown as TFile;
	const parallel = vault.getFileByPath('Parallel.md') as unknown as TFile;
	const registry = new VersionRegistry(vault, [{
		id: 'same-path-replacement',
		slots: [
			{ member: memberRecordFromFile(topic), version: 1 },
			{ member: memberRecordFromFile(parallel), version: 2 },
		],
	}], async () => {
		throw new Error('injected persistence failure');
	});

	const original = (vault as unknown as InstanceType<typeof Vault>)
		.rename('Parallel.md', 'Moved/Parallel.md') as unknown as TFile;
	const replacement = (vault as unknown as InstanceType<typeof Vault>)
		.add('Parallel.md', 'unrelated external replacement') as unknown as TFile;

	await assert.rejects(
		() => registry.updateMemberPath('Parallel.md', original),
		/injected persistence failure/u,
	);

	const group = registry.index.getGroupById('same-path-replacement');
	const resolvedV2 = group?.versions.find((member) => member.version === 2);
	assert.equal(group?.status, 'incomplete');
	assert.equal(resolvedV2, undefined);
	assert.equal(registry.index.getGroupForFile(original), null);
	assert.equal(registry.index.getGroupForFile(replacement), null);

	console.log(JSON.stringify({
		finding: 'same-path replacement is rejected after failed path persistence',
		groupStatus: group?.status,
		originalPath: original.path,
		replacementPath: replacement.path,
		replacementWasAdopted: false,
		severity: 'PASS',
	}, null, 2));
}

void run();
