export function filterAllowedSeries<T extends { id: string }>(
	groups: T[],
	allowedSeriesIds: ReadonlySet<string> | null,
): T[] {
	return allowedSeriesIds
		? groups.filter((group) => allowedSeriesIds.has(group.id))
		: groups;
}
