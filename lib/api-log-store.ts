// lib/api-log-store.ts
// 底层模型调用日志存储（独立模块，避免 chat-engine ↔ api-helpers 循环依赖）。
// 聊天引擎（整段/流式/原生工具）与 simpleLLMCall（记忆总结、朋友圈、日历等
// 通用 LLM 调用）共用这份日志，统一在「底层调用大模型日志」面板查看。

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

export type DebugInfo = {
    id: string;
    characterName?: string;
    model?: string;
    messages: { role: string; content: string; marker?: string }[];
    rawResponse: string;
    timestamp: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    /** 兼容已有调用方；写入诊断日志时丢弃。 */
    reasoning?: string;
    httpStatus?: number;
    failureKind?: "access" | "auth" | "proxy" | "upstream" | "http" | "format";
    /** 调用来源：chat=聊天引擎、background=simpleLLMCall 后台功能（具体功能名看 characterName 标签）、qa=工坊答疑引擎 */
    source?: "chat" | "background" | "qa";
    /** 归属通道：qa 进工坊专用环，其余进底层调用日志环。分流只认这个显式字段，不看角色名 */
    channel?: "chat" | "qa";
};

const MAX_API_LOGS = 150;
const MAX_QA_API_LOGS = 50;

const API_LOGS_KEY = "ai_phone_api_logs_v1";
// 工坊（QA 助手）专用调用记录：与聊天/记忆等底层调用日志彻底隔离，
// 只在工坊界面右上角「调用记录」里查看，绝不混进聊天页的「底层调用大模型日志」。
const QA_LOGS_KEY = "ai_phone_qa_api_logs_v1";
registerKvMigration(API_LOGS_KEY);
registerKvMigration(QA_LOGS_KEY);

function _loadLogs(key: string): DebugInfo[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(key) : null;
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as DebugInfo[]).map(summarizeLog) : [];
    } catch { return []; }
}
function _saveLogs(key: string, logs: DebugInfo[]): void {
    try { kvSet(key, JSON.stringify(logs)); } catch { /* 日志失败不影响主流程 */ }
}

const FAILURE_KINDS = new Set(["access", "auth", "proxy", "upstream", "http", "format"]);
const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool", "developer"]);

function summarizeLog(entry: DebugInfo): DebugInfo {
    const summarized = entry.rawResponse.startsWith("响应 ")
        && /^响应 \d+ 字符$/.test(entry.rawResponse);
    return {
        id: entry.id,
        timestamp: entry.timestamp,
        source: entry.source,
        channel: entry.channel,
        httpStatus: Number.isInteger(entry.httpStatus) ? entry.httpStatus : undefined,
        failureKind: entry.failureKind && FAILURE_KINDS.has(entry.failureKind) ? entry.failureKind : undefined,
        messages: entry.messages.slice(-100).map(message => ({
            role: MESSAGE_ROLES.has(message.role) ? message.role : "其他",
            content: /^消息 \d+ 字符$/.test(message.content) && summarized
                ? message.content : "消息 " + message.content.length + " 字符",
        })),
        rawResponse: summarized ? entry.rawResponse : "响应 " + entry.rawResponse.length + " 字符",
        usage: entry.usage && {
            prompt_tokens: Number.isFinite(entry.usage.prompt_tokens) ? entry.usage.prompt_tokens : undefined,
            completion_tokens: Number.isFinite(entry.usage.completion_tokens) ? entry.usage.completion_tokens : undefined,
            total_tokens: Number.isFinite(entry.usage.total_tokens) ? entry.usage.total_tokens : undefined,
        },
    };
}

export function getApiLogs(): DebugInfo[] { return _loadLogs(API_LOGS_KEY); }
export function clearApiLogs(): void { try { kvRemove(API_LOGS_KEY); } catch { } }

/** 工坊专用调用记录（仅工坊 UI 读取，与底层日志完全隔离）。 */
export function getQaApiLogs(): DebugInfo[] { return _loadLogs(QA_LOGS_KEY); }
export function clearQaApiLogs(): void { try { kvRemove(QA_LOGS_KEY); } catch { } }

/** 追加一条只含元数据的调用日志，超出数量上限时裁掉最旧的记录。 */
export function pushApiLog(entry: Omit<DebugInfo, "id" | "timestamp">): void {
    // 工坊（QA 助手）的调用单独归档，不进聊天页的底层调用日志。
    // 分流只认显式 channel 字段：角色名恰好叫「工坊」的聊天不会被误扔进工坊记录。
    const isQa = entry.channel === "qa";
    const key = isQa ? QA_LOGS_KEY : API_LOGS_KEY;
    const maxCount = isQa ? MAX_QA_API_LOGS : MAX_API_LOGS;
    try {
        const logs = _loadLogs(key);
        logs.push(summarizeLog({
            ...entry,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
        }));
        _saveLogs(key, logs.slice(-maxCount));
    } catch { /* 日志写入失败不影响主流程 */ }
}
