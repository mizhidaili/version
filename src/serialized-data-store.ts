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
		const operation = async (): Promise<void> => {
			const next = transform(this.current);
			await this.persist(next);
			this.current = next;
			this.onCommitted(next);
		};
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
