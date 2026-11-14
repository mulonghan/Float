"use client";

import { useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import { getWorldBookMarkerStates } from "@/lib/llm-prompt-assembler";
import { loadBindingConfig, loadPresets, loadWorldBooks, resolveBinding } from "@/lib/settings-storage";
import { readLastWorldBookSession, readWorldBookReport } from "@/lib/worldbook-diagnostics";

const markerLabels = { missing: "缺失", disabled: "已关闭", enabled: "已启用" };
const roleLabels = { system: "System", user: "User", assistant: "Assistant" };
const locationLabels = {
    before: "角色设定前", after: "角色设定后",
    "member-before": "群聊成员设定区（角色设定前）",
    "member-after": "群聊成员设定区（角色设定后）",
    "shared-before": "群聊共享世界书（成员设定前）",
    "shared-after": "群聊共享世界书（成员设定后）",
};

function readConfiguration() {
    const session = readLastWorldBookSession();
    if (!session) return;
    const bindings = loadBindingConfig({ persist: false });
    const chars = loadCharacters({ persist: false });
    const app = session.isGroup ? "group_chat" : "chat";
    const ids = session.isGroup ? session.participantIds ?? [] : [session.contactId];
    const boundIds = [...new Set(ids.flatMap(id => resolveBinding(bindings, id, app).worldBookIds ?? []))];
    const slot = resolveBinding(bindings, session.isGroup ? undefined : session.contactId, app);
    const presets = loadPresets({ persist: false });
    const preset = presets.find(item => item.id === slot.presetId) ?? presets.find(item => item.builtIn) ?? null;
    const books = loadWorldBooks().filter(book => boundIds.includes(book.id));
    const markers = getWorldBookMarkerStates(preset);
    const requiresUnavailableMarker = !session.isGroup && books.some(book => book.entries.some(entry => {
        if (entry.disable || entry.position === 4) return false;
        const marker = entry.position === 0 || entry.position === "before_char" ? "worldInfoBefore" : "worldInfoAfter";
        return markers[marker] !== "enabled";
    }));
    return {
        character: ids.map(id => chars.find(char => char.id === id)?.name ?? "角色不存在").join("、"),
        preset: preset?.name ?? "无预设",
        boundIds,
        boundCount: boundIds.length,
        enabledCount: books.filter(book => book.entries.some(entry => !entry.disable)).length,
        missingCount: boundIds.length - books.length,
        markers,
        requiresUnavailableMarker,
    };
}

export function WorldBookDiagnosticsPanel({ selectedBookId }: { selectedBookId?: string }) {
    const [configuration] = useState(readConfiguration);
    const [report] = useState(() => readWorldBookReport());
    if (!configuration) return <p>请先打开要检查的聊天，再回到世界书管理。</p>;

    const active = report?.entries.filter(entry => entry.state === "active") ?? [];
    const included = active.filter(entry => entry.placement);
    const unconfirmed = active.length - included.length;
    const unbound = selectedBookId && !configuration.boundIds.includes(selectedBookId);

    return (
        <div className="flex flex-col gap-3 text-left break-words">
            <div>
                <p>最近打开的会话 · {configuration.character || "无可用角色"}</p>
                <p>当前预设 · {configuration.preset}</p>
                <p>绑定 {configuration.boundCount} 本，{configuration.enabledCount} 本有启用条目{configuration.missingCount > 0 && `，${configuration.missingCount} 本绑定已失效`}。</p>
                <p>预设标记 · 角色设定前 {markerLabels[configuration.markers.worldInfoBefore]} · 角色设定后 {markerLabels[configuration.markers.worldInfoAfter]}</p>
                {configuration.boundCount === 0 && <p role="status">此会话未绑定世界书。</p>}
                {unbound && configuration.boundCount > 0 && <p role="status">当前编辑的世界书未绑定此会话。</p>}
                {configuration.requiresUnavailableMarker && <p role="status">当前预设缺少或关闭了已启用条目所需的标记。</p>}
            </div>
            {!report ? <p role="status">本次打开应用后还没有此会话的聊天组装记录。以上仅检查设置，无法确认激活或注入。</p> : (
                <>
                    <div>
                        <p>上次组装 · {report.mode} · {new Date(report.timestamp).toLocaleTimeString()}</p>
                        <p>{report.character} · {report.preset}</p>
                        <p>绑定 {report.boundIds.length} 本，{report.books.filter(book => book.enabled).length} 本有启用条目。</p>
                        <p>角色设定前 {markerLabels[report.markers.worldInfoBefore]} · 角色设定后 {markerLabels[report.markers.worldInfoAfter]}</p>
                        <p>激活 {active.length} 条，确认进入本地提示词 {included.length} 条。</p>
                        {report.worldBooksDisabled && <p role="status">这次聊天配置关闭了世界书。</p>}
                        {!!unconfirmed && <p role="status" className="font-semibold">有 {unconfirmed} 条已激活，但未在组装结果中确认注入。展开世界书查看原因。</p>}
                        <p className="menu-desc">统计来自真实聊天的本地组装。之后的插件、协议转换和工具续轮可能改变请求。修改设置后，上次组装记录仍显示当时的结果。</p>
                    </div>
                    {report.books.map(book => (
                        <details key={book.id} open={selectedBookId === book.id || undefined}>
                            <summary className="menu-label">{book.name}{book.enabled ? "" : "（无启用条目）"}</summary>
                            <ul className="flex flex-col gap-1 pl-4">
                                {report.entries.filter(entry => entry.bookId === book.id).map(entry => (
                                    <li key={entry.uid}>
                                        {entry.title} · {entry.placement
                                            ? `${entry.placement.location === "depth" ? `按深度插入（${entry.placement.depth}）`
                                                : locationLabels[entry.placement.location] + (entry.placement.depth === 0 ? "标记（位于历史区之后）" : "")} · ${roleLabels[entry.placement.role]}`
                                            : entry.reason}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ))}
                </>
            )}
        </div>
    );
}
