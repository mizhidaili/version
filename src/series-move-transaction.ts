import { TFile } from 'obsidian';
import {
	memberMatchesFile,
	memberRecordFromFile,
	VersionSeriesRecord,
	VersionSlotRecord,
} from './version-data';
import { MovePlan } from './move-theme-plans';

export interface SeriesMovePlan extends MovePlan {
	alreadyMoved?: boolean;
}

export interface PlannedSeriesDestination {
	file?: TFile;
	to: string;
}

export interface SeriesMoveEnvironment {
	getAbstractFileByPath: (path: string) => unknown;
	renameFile: (
		file: TFile,
		from: string,
		to: string,
		rollback: boolean,
	) => Promise<void>;
	saveSlots: (slots: VersionSlotRecord[]) => Promise<void>;
}

export class SeriesMoveError extends Error {
	constructor(
		message: string,
		readonly kind: 'collision' | 'manual-repair',
		readonly collisionCount = 0,
		readonly rollbackFailures = 0,
	) {
		super(message);
		this.name = 'SeriesMoveError';
	}
}

/**
 * Move every registered member as one best-effort transaction. Relationship
 * data is persisted only after a final barrier proves every exact captured
 * TFile is still at its planned destination.
 */
export async function executeSeriesMove(
	record: VersionSeriesRecord,
	plans: SeriesMovePlan[],
	environment: SeriesMoveEnvironment,
): Promise<void> {
	const plansByPath = new Map(plans.map((plan) => [plan.from, plan]));
	const completed = plans.filter((plan) => plan.alreadyMoved);
	try {
		validateMoveStart(record, plansByPath);
		const collisionCount = countSeriesMoveCollisions(
			plans,
			environment.getAbstractFileByPath,
		);
		if (collisionCount > 0) {
			throw new SeriesMoveError(
				`${collisionCount} destination file(s) already exist.`,
				'collision',
				collisionCount,
			);
		}

		for (const plan of plans) {
			if (plan.alreadyMoved || plan.from === plan.to) {
				continue;
			}
			await environment.renameFile(plan.file, plan.from, plan.to, false);
			completed.push(plan);
		}

		// Another plugin or sync process can move a previously completed TFile
		// during a later await. Never turn that unrelated path into Version data.
		const slots = record.slots.map((slot): VersionSlotRecord => {
			if (!slot.member) {
				throw new Error(`V${slot.version} does not have a file.`);
			}
			const plan = plansByPath.get(slot.member.path);
			if (
				!plan ||
				plan.file.path !== plan.to ||
				environment.getAbstractFileByPath(plan.to) !== plan.file ||
				!memberMatchesFile(slot.member, plan.file)
			) {
				throw new Error(`V${slot.version} changed before the move was committed.`);
			}
			return {
				member: memberRecordFromFile(plan.file),
				version: slot.version,
			};
		});
		await environment.saveSlots(slots);
	} catch (error) {
		const rollbackFailures = await rollbackSeriesMoves(
			completed,
			environment,
		);
		if (rollbackFailures > 0) {
			throw new SeriesMoveError(
				`Move failed and ${rollbackFailures} file(s) require manual repair.`,
				'manual-repair',
				error instanceof SeriesMoveError ? error.collisionCount : 0,
				rollbackFailures,
			);
		}
		throw error;
	}
}

export function countSeriesMoveCollisions(
	plans: SeriesMovePlan[],
	getAbstractFileByPath: (path: string) => unknown,
): number {
	return countPlannedSeriesDestinationCollisions(
		plans,
		getAbstractFileByPath,
	);
}

/**
 * Preflight destinations before pending blank files exist. Omitting `file`
 * deliberately treats any occupant as a collision, while existing members may
 * keep their exact current path.
 */
export function countPlannedSeriesDestinationCollisions(
	plans: PlannedSeriesDestination[],
	getAbstractFileByPath: (path: string) => unknown,
): number {
	const destinationCounts = new Map<string, number>();
	for (const plan of plans) {
		destinationCounts.set(plan.to, (destinationCounts.get(plan.to) ?? 0) + 1);
	}
	return plans.filter((plan) => {
		const existing = getAbstractFileByPath(plan.to);
		return (
			(existing !== null && existing !== undefined && existing !== plan.file) ||
			(destinationCounts.get(plan.to) ?? 0) > 1
		);
	}).length;
}

export async function rollbackSeriesMoves(
	plans: SeriesMovePlan[],
	environment: Pick<
		SeriesMoveEnvironment,
		'getAbstractFileByPath' | 'renameFile'
	>,
): Promise<number> {
	let failures = 0;
	for (const plan of plans.slice().reverse()) {
		if (plan.from === plan.to) {
			continue;
		}
		if (
			plan.file.path !== plan.to ||
			environment.getAbstractFileByPath(plan.from)
		) {
			failures += 1;
			continue;
		}
		try {
			await environment.renameFile(plan.file, plan.to, plan.from, true);
		} catch {
			failures += 1;
		}
	}
	return failures;
}

function validateMoveStart(
	record: VersionSeriesRecord,
	plansByPath: Map<string, SeriesMovePlan>,
): void {
	if (plansByPath.size !== record.slots.length) {
		throw new Error('Version move does not cover every registered member.');
	}
	for (const slot of record.slots) {
		if (!slot.member) {
			throw new Error(`V${slot.version} does not have a file.`);
		}
		const plan = plansByPath.get(slot.member.path);
		const expectedPath = plan?.alreadyMoved ? plan.to : plan?.from;
		if (
			!plan ||
			plan.file.path !== expectedPath ||
			!memberMatchesFile(slot.member, plan.file)
		) {
			throw new Error(`V${slot.version} changed before the move began.`);
		}
	}
}
