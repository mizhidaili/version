export class SerializedDataStore<T> {
	private current: T;
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(
		initial: T,
		private readonly persist: (next: T) => Promise<void>,
		private readonly onCommitted: (next: T) => void,
	) {
		this.current = initial;
	}

	get(): T {
		return this.current;
	}

	update(transform: (current: T) => T): Promise<void> {
		return this.enqueue(async () => {
			const next = transform(this.current);
			await this.persist(next);
			this.current = next;
			this.onCommitted(next);
		});
	}

	/**
	 * Reconcile an already captured external snapshot with local updates that
	 * committed after capture. An uncontended reload is never echoed back. If a
	 * local save raced, persist any merged result that differs from the captured
	 * disk snapshot so memory and data.json cannot diverge after reconciliation.
	 */
	reconcile(
		base: T,
		incoming: T,
		merge: (base: T, current: T, incoming: T) => T,
		equals: (left: T, right: T) => boolean,
	): Promise<T> {
		return this.enqueue(async () => {
			const current = this.current;
			const next = merge(base, current, incoming);
			if (!equals(next, incoming)) {
				await this.persist(next);
			}
			this.current = next;
			this.onCommitted(next);
			return next;
		});
	}

	private enqueue<R>(operation: () => Promise<R>): Promise<R> {
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
