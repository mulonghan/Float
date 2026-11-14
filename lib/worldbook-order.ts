import type { WorldBookEntry } from "./settings-types";

export function worldBookOrderForDisplay(entry: WorldBookEntry): number {
    const order = entry.insertion_order ?? 50;
    return entry.orderSource === "lorebook" && order !== 0 ? -order : order;
}

export function worldBookOrderFromDisplay(entry: WorldBookEntry, value: number): number {
    return entry.orderSource === "lorebook" && value !== 0 ? -value : value;
}
