import type { PresetConfig, WorldBookConfig, WorldBookEntry } from "./settings-types";
import type { ChatSession } from "./chat-storage";

export type WorldBookMarkerState = "missing" | "disabled" | "enabled";
export type WorldBookMarker = "worldInfoBefore" | "worldInfoAfter";
type InjectionRole = "system" | "user" | "assistant";
type Placement = { location: "before" | "after" | "depth" | "member-before" | "member-after" | "shared-before" | "shared-after"; role: InjectionRole; depth: number };
type EntryResult = {
    bookId: string;
    uid: string;
    title: string;
    state: "disabled" | "inactive" | "active";
    placement?: Placement;
    reason?: string;
};

export type WorldBookReport = {
    sessionId: string;
    character: string;
    preset: string;
    mode: string;
    timestamp: number;
    boundIds: string[];
    missingBookIds: string[];
    worldBooksDisabled: boolean;
    books: { id: string; name: string; enabled: boolean }[];
    markers: Record<WorldBookMarker, WorldBookMarkerState>;
    entries: EntryResult[];
};

export class WorldBookTrace {
    readonly report: WorldBookReport;
    private readonly results = new Map<WorldBookEntry, EntryResult>();
    private readonly blocks = new Map<object, { entry: WorldBookEntry; text: string }[]>();

    constructor(
        sessionId: string, character: string, preset: PresetConfig | null, mode: string,
        boundIds: string[], books: WorldBookConfig[], worldBooksDisabled = false,
    ) {
        const ids = [...new Set(boundIds)];
        const unique = [...new Map(books.map(book => [book.id, book])).values()];
        this.report = {
            sessionId, character, preset: preset?.name ?? "无预设", mode, timestamp: Date.now(),
            boundIds: ids, missingBookIds: ids.filter(id => !unique.some(book => book.id === id)),
            worldBooksDisabled,
            books: unique.map(book => ({ id: book.id, name: book.name, enabled: book.entries.some(entry => !entry.disable) })),
            markers: { worldInfoBefore: "missing", worldInfoAfter: "missing" }, entries: [],
        };
        for (const book of unique) {
            for (const [index, entry] of book.entries.entries()) {
                const result: EntryResult = {
                    bookId: book.id, uid: entry.uid, title: entry.comment || `条目 ${index + 1}`,
                    state: entry.disable ? "disabled" : "inactive",
                    reason: entry.disable ? "条目已停用" : worldBooksDisabled ? "本次会话配置关闭了世界书"
                        : !entry.constant && !entry.key.split(",").some(key => key.trim()) ? "未设置触发关键词"
                        : "本次未通过关键词或概率激活",
                };
                this.results.set(entry, result);
                this.report.entries.push(result);
            }
        }
    }

    activate(entry: WorldBookEntry): void {
        const result = this.results.get(entry);
        if (result) {
            result.state = "active";
            result.reason = "内容未生成可确认的注入文本";
        }
    }

    exclude(entry: WorldBookEntry, reason: string): void {
        const result = this.results.get(entry);
        if (result?.state === "active" && !result.placement) result.reason = reason;
    }

    track(block: object, entries: { entry: WorldBookEntry; text: string }[]): void {
        const existing = this.blocks.get(block);
        this.blocks.set(block, existing ? [...existing, ...entries] : entries);
    }

    checkBlock(block: object, text: string, location: string, role: string, depth: number): void {
        const entries = this.blocks.get(block);
        if (!entries) return;
        this.blocks.delete(block);
        for (const item of entries) {
            const result = this.results.get(item.entry);
            if (!result || result.placement || (role !== "system" && role !== "user" && role !== "assistant")) continue;
            const fragment = item.text.trim();
            if (fragment && text.includes(fragment)) {
                const before = item.entry.position === 0 || item.entry.position === "before_char";
                result.placement = {
                    location: item.entry.position === 4 ? "depth"
                        : location.startsWith("member:") ? (before ? "member-before" : "member-after")
                        : location.startsWith("sharedWorldInfo(") ? (before ? "shared-before" : "shared-after")
                        : before ? "before" : "after",
                    role, depth,
                };
                delete result.reason;
            } else {
                result.reason = "正文为空，或经宏与正则处理后无法确认原条目文本";
            }
        }
    }
}

// Only the summary is retained. Reading it never invokes the request builder.
const reports = new Map<string, WorldBookReport>();
let lastSession: Pick<ChatSession, "id" | "contactId" | "isGroup" | "participantIds"> | undefined;

export function recordWorldBookReport(trace: WorldBookTrace | undefined): void {
    if (!trace || typeof window === "undefined") return;
    const { sessionId } = trace.report;
    reports.delete(sessionId);
    reports.set(sessionId, trace.report);
    if (reports.size > 12) {
        const oldest = reports.keys().next();
        if (!oldest.done) reports.delete(oldest.value);
    }
}

export function noteWorldBookSession({ id, contactId, isGroup, participantIds }: ChatSession): void {
    lastSession = { id, contactId, isGroup, participantIds: participantIds && [...participantIds] };
}

export function readLastWorldBookSession() {
    return lastSession;
}

export function readWorldBookReport(sessionId = lastSession?.id): WorldBookReport | undefined {
    return sessionId ? reports.get(sessionId) : undefined;
}
