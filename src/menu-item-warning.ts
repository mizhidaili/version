/**
 * `MenuItem.setWarning` is public, but older Obsidian SDK declarations omitted
 * it. Keep the visual warning when supported and retain the explicit text,
 * icon, and confirmation flow as the compatibility fallback.
 */
export function setMenuItemWarning(item: object): void {
	const candidate = item as {
		setWarning?: (warning: boolean) => unknown;
	};
	candidate.setWarning?.(true);
}
