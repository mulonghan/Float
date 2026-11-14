// lib/llm-http.ts
// LLM 请求的统一 fetch 出口。所有走 buildProviderRequest 的调用点统一经它发请求：
//  - 普通 provider：浏览器直连（现状不变）；
//  - serverProxy 标记（OpenCode 网关）：改发本站 /api/llm-proxy，由服务端转发，
//    绕过 opencode.ai 未开放浏览器 CORS 的问题。

import type { LlmRequestPayload } from "./llm-provider-adapter";

export type FetchLlmPayloadOptions = {
    signal?: AbortSignal;
};

export function fetchLlmPayload(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions = {},
): Promise<Response> {
    const bodyText = JSON.stringify(payload.body);
    if (payload.serverProxy) {
        return fetch("/api/llm-proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: payload.url,
                headers: payload.headers,
                body: bodyText,
            }),
            signal: options.signal,
        });
    }
    return fetch(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: bodyText,
        signal: options.signal,
    });
}

type LlmFailureKind = "access" | "auth" | "proxy" | "upstream" | "http" | "format";

export class LlmHttpError extends Error {
    constructor(readonly kind: LlmFailureKind, readonly status: number, message: string) {
        super(message);
        this.name = "LlmHttpError";
    }
}

function redactApiKey(message: string, apiKey: string): string {
    const key = apiKey.trim();
    return key ? message.replaceAll(key, "[已隐藏]").replaceAll(encodeURIComponent(key), "[已隐藏]") : message;
}

export function describeLlmFailure(error: unknown, apiKey: string, signal?: AbortSignal): string {
    if (error instanceof LlmHttpError) return error.message;
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "API 请求已取消或超时。";
    if (error instanceof TypeError) return "API 连接失败。请检查网络、请求地址和浏览器跨域限制。";
    return error instanceof Error ? redactApiKey(error.message, apiKey) : "API 请求失败。";
}

function isProxyUrl(url: string): boolean {
    return /^(?:https?:\/\/[^/]+)?\/(?:lmu\/|api\/llm-proxy(?:[/?#]|$))/i.test(url);
}

function isAccessPage(body: string): boolean {
    return /<(?:!doctype|html|head|title|meta)\b/i.test(body)
        && /netlify edge access|netlify access|login redirect/i.test(body);
}

function formatFailure(response: Response, url: string, apiKey: string, body: string): LlmHttpError {
    const status = response.status;
    if (isAccessPage(body)) return new LlmHttpError("access", status, "Netlify 站点要求登录 (HTTP " + status + ")。请重新登录站点。");

    let detail = "";
    let structuredError = false;
    try {
        const data = JSON.parse(body);
        const error = data?.error ?? data;
        detail = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
        structuredError = Boolean(detail);
    } catch {
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("html") && !/^\s*</.test(body)) detail = body.trim();
    }

    const suffix = detail ? " · " + redactApiKey(detail, apiKey).replace(/\s+/g, " ").slice(0, 300) : "";
    const http = " (HTTP " + status + ")";
    if (status === 401 || status === 403) return new LlmHttpError("auth", status, "API 认证或访问权限错误" + http + suffix);
    if (isProxyUrl(url) && !structuredError && (status >= 500 || status === 404)) {
        return new LlmHttpError("proxy", status, "代理请求失败" + http + "，上游状态未知。" + suffix);
    }
    if (status >= 500 || structuredError) return new LlmHttpError("upstream", status, "上游 API 错误" + http + suffix);
    return new LlmHttpError("http", status, "API 请求失败" + http + suffix);
}

export async function assertLlmHttpResponse(response: Response, url: string, apiKey: string): Promise<void> {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok) throw formatFailure(response, url, apiKey, await response.text().catch(() => ""));
    if (contentType.includes("text/html")) {
        const body = await response.text();
        if (isAccessPage(body)) throw formatFailure(response, url, apiKey, body);
        throw new LlmHttpError("format", response.status, "API 返回了 HTML 页面，请检查请求地址。");
    }
}

export async function readLlmJson(response: Response, url: string, apiKey: string): Promise<Record<string, unknown>> {
    const body = await response.text();
    try {
        const data: unknown = JSON.parse(body);
        if (data !== null && typeof data === "object" && !Array.isArray(data)) {
            if ("error" in data && data.error) throw formatFailure(response, url, apiKey, body);
            return data as Record<string, unknown>;
        }
    } catch (error) {
        if (error instanceof LlmHttpError) throw error;
    }
    if (isAccessPage(body)) throw formatFailure(response, url, apiKey, body);
    throw new LlmHttpError("format", response.status, "API 响应格式错误，预期 JSON 对象。");
}

export function assertLlmStreamChunk(data: unknown, apiKey: string): void {
    if (data === null || typeof data !== "object" || !("error" in data) || !data.error) return;
    const error = data.error;
    const detail = typeof error === "string"
        ? error
        : typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
    const suffix = detail ? " · " + redactApiKey(detail, apiKey).replace(/\s+/g, " ").slice(0, 300) : "";
    throw new LlmHttpError("upstream", 200, "上游 API 在响应流中返回错误" + suffix);
}
