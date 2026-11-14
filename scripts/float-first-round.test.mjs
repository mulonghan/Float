import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

// Load real modules with only browser persistence and networking replaced.
function makeLoader(globals = {}, stubs = {}) {
    const modules = new Map();
    const context = vm.createContext({
        AbortController, Blob, DOMException, FormData, Request, Response, URL, TextDecoder,
        atob, setTimeout, clearTimeout, console, ...globals,
    });
    function load(file) {
        if (modules.has(file)) return modules.get(file).exports;
        const module = { exports: {} };
        modules.set(file, module);
        const source = readFileSync(file, "utf8");
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        });
        const execute = vm.runInContext("(function (require, module, exports) {" + outputText + "\n})", context, { filename: file });
        execute(id => {
            if (Object.hasOwn(stubs, id)) return stubs[id];
            return id.startsWith("./") ? load(resolve(file, "..", id + ".ts")) : require(id);
        }, module, module.exports);
        return module.exports;
    }
    return file => load(resolve(file));
}

test("each image mode selects one POST and a post-send disconnect reports possible billing", async () => {
    const cases = [
        ["direct", "", "https://image.example/v1", "https://image.example/v1/images/generations"],
        ["server", "", "https://image.example/v1", "/api/image-generation"],
        ["server", "https://worker.example/v1", "https://image.example/v1", "https://worker.example/v1/images/generations"],
        ["server", "", "/lmu/v1", "/lmu/v1/images/generations"],
    ];
    for (const [requestMode, proxy, baseUrl, expectedUrl] of cases) {
        const posts = [];
        const load = makeLoader({
            window: { location: new URL("https://float.example/") },
            process: { env: { NEXT_PUBLIC_IMAGE_GEN_PROXY_URL: proxy } },
            fetch: async (url, init) => {
                posts.push([url, init.method, init.redirect]);
                throw new TypeError("connection lost after upstream accepted the request");
            },
        }, { "./settings-storage": {}, "./chat-asset-storage": {}, "./media-cache-storage": {} });
        const { generateImageFromConfiguredApi } = load("lib/image-generation-service.ts");
        await assert.rejects(generateImageFromConfiguredApi({
            description: "fixture",
            settings: { enabled: true, requestMode, baseUrl, apiKey: "fixture", model: "test", extraPrompt: "", characterReferences: {} },
        }), /生成结果未知，可能已经计费/);
        assert.deepEqual(posts, [[expectedUrl, "POST", "error"]]);
    }
});

test("successful image is saved once, while a 504 or an incomplete heartbeat stream never resubmits", async () => {
    const cases = [
        [Response.json({ data: [{ b64_json: "AQID" }] }), true, "direct"],
        [new Response("timeout", { status: 504 }), false, "server"],
        [new Response("   ", { headers: { "content-type": "text/plain" } }), false, "server"],
    ];
    for (const [response, success, requestMode] of cases) {
        let posts = 0;
        let saves = 0;
        const load = makeLoader({
            process: { env: {} },
            fetch: async () => { posts++; return response; },
        }, {
            "./settings-storage": {}, "./chat-asset-storage": {},
            "./media-cache-storage": { storeMediaBlob: async () => { saves++; return "image-fixture"; } },
        });
        const result = load("lib/image-generation-service.ts").generateImageFromConfiguredApi({
            description: "fixture",
            settings: { enabled: true, requestMode, baseUrl: "https://image.example/v1", apiKey: "fixture", model: "test", extraPrompt: "", characterReferences: {} },
        });
        if (success) assert.equal((await result).mediaRef, "image-fixture");
        else await assert.rejects(result, /生成结果未知，可能已经计费/);
        assert.equal(saves, success ? 1 : 0);
        assert.equal(posts, 1);
    }
});

test("a reference image still uses a single multipart edit request and saves the result", async () => {
    const requests = [];
    const load = makeLoader({
        process: { env: {} },
        fetch: async (url, init) => {
            requests.push([url, init.body]);
            return Response.json({ data: [{ b64_json: "AQID" }] });
        },
    }, {
        "./settings-storage": {},
        "./chat-asset-storage": { getChatImageFromIndexedDB: async () => "data:image/png;base64,AQID" },
        "./media-cache-storage": { storeMediaBlob: async () => "reference-fixture" },
    });
    const { generateImageFromConfiguredApi } = load("lib/image-generation-service.ts");
    const image = await generateImageFromConfiguredApi({
        description: "fixture", characterId: "character", useReferenceImage: true,
        settings: {
            enabled: true, requestMode: "direct", baseUrl: "https://image.example/v1", apiKey: "fixture",
            model: "test", extraPrompt: "", characterReferences: { character: { assetId: "asset" } },
        },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], "https://image.example/v1/images/edits");
    assert.ok(requests[0][1].get("image") instanceof Blob);
    assert.equal(image.usedReferenceImage, true);
    assert.equal(image.mediaRef, "reference-fixture");
});

test("worldbook import and replacement share field normalization, preserving identity and text", () => {
    const load = makeLoader({}, {
        "./kv-db": { registerKvMigration() {} },
        "./settings-db": {},
        "./builtin-preset": {},
    });
    const { parseWorldBookFromJson, parseWorldBookEntry } = load("lib/settings-storage.ts");
    const entry = { uid: 0, name: "灯塔", content: "  设定\r\n第二行\n", keywords: ["灯塔", "北岸"], constantActive: true, probability: 0, order: 0, position: "4", depth: 0, role: "user" };
    const imported = parseWorldBookFromJson(JSON.stringify({ id: "book", name: "北岸", description: "港口", createdAt: 0, updatedAt: 1, entries: { first: entry } }));
    assert.equal(imported.id, "book");
    assert.equal(imported.createdAt, 0);
    assert.equal(imported.description, "港口");
    assert.deepEqual(JSON.parse(JSON.stringify(imported.entries[0])), {
        uid: "0", key: "灯塔,北岸", content: entry.content, comment: "灯塔", use_regex: false,
        disable: false, constant: true, position: 4, depth: 0, probability: 0, useProbability: true, role: 1, insertion_order: 0,
    });
    assert.deepEqual(parseWorldBookEntry(entry), imported.entries[0]);
    assert.deepEqual({ ...parseWorldBookEntry(entry, { replaceUid: "existing" }) }, { ...imported.entries[0], uid: "existing" });
    imported.entries[0].comment = "编辑后的条目";
    imported.entries[0].content += "追加";
    assert.deepEqual(parseWorldBookFromJson(JSON.stringify(imported)), imported);
    assert.equal(parseWorldBookFromJson('{"name":"invalid"}'), null);
    assert.equal(parseWorldBookFromJson(JSON.stringify({ entries: [entry, entry] })), null);
    assert.equal(parseWorldBookFromJson(JSON.stringify({ entries: [{ content: { invalid: true } }] })), null);
});

test("OpenAI and Anthropic resolve existing and base endpoints with the matching payload", () => {
    const load = makeLoader({}, { "./api-log-store": {} });
    const { buildChatCompletionsUrl, buildSimpleLLMRequest } = load("lib/api-helpers.ts");
    const { buildProviderRequest } = load("lib/llm-provider-adapter.ts");
    assert.equal(buildChatCompletionsUrl(" /lmu/v1/chat/completions///?route=1 "), "/lmu/v1/chat/completions?route=1");
    const messages = [{ role: "system", content: "fixture system" }, { role: "user", content: "fixture question" }];
    for (const [provider, baseUrl, url, kind] of [
        ["Custom", "/lmu/v1/", "/lmu/v1/chat/completions", "openai-compatible"],
        ["Anthropic", "/lmu", "/lmu/v1/messages", "anthropic"],
        ["Anthropic", "https://api.lmuai.ai/v1/messages/", "https://api.lmuai.ai/v1/messages", "anthropic"],
        ["Anthropic", "https://relay.example/v1", "https://relay.example/v1/chat/completions", "openai-compatible"],
    ]) {
        const config = { provider, baseUrl, defaultModel: "test", apiKey: "fixture" };
        const requests = [buildSimpleLLMRequest(config, messages), buildProviderRequest(config, null, messages)];
        for (const request of requests) {
            assert.equal(request.url, url);
            assert.equal(request.providerKind, kind);
            const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
            if (kind === "anthropic") {
                assert.equal(request.headers["anthropic-version"], "2023-06-01");
                assert.equal(request.headers["x-api-key"], "fixture");
                assert.equal(body.system, "fixture system");
                assert.equal(body.messages[0].role, "user");
                assert.ok(body.max_tokens > 0);
            } else {
                assert.equal(request.headers.Authorization, "Bearer fixture");
                assert.equal(body.messages[0].role, "system");
            }
        }
    }
});

test("response classification preserves upstream status and safe error detail", async () => {
    const { assertLlmHttpResponse, assertLlmStreamChunk, readLlmJson } = makeLoader()("lib/llm-http.ts");
    const fixtures = [
        [new Response("<html><title>Netlify Edge Access Login Redirect</title></html>", { status: 401 }), "access", 401, /重新登录/],
        [Response.json({ error: { message: "invalid fixture-secret" } }, { status: 401 }), "auth", 401, /invalid \[已隐藏\]/],
        [new Response("<html>Gateway</html>", { status: 502 }), "proxy", 502, /上游状态未知/],
        [Response.json({ error: { message: "model overloaded" } }, { status: 500 }), "upstream", 500, /model overloaded/],
    ];
    for (const [response, kind, status, expected] of fixtures) {
        await assert.rejects(assertLlmHttpResponse(response, "/lmu/v1/chat/completions", "fixture-secret"), error => {
            assert.equal(error.kind, kind);
            assert.equal(error.status, status);
            assert.match(error.message, expected);
            assert.doesNotMatch(error.message, /fixture-secret/);
            return true;
        });
    }
    await assert.rejects(readLlmJson(new Response("invalid JSON"), "/lmu/v1/chat/completions", ""), /响应格式错误/);
    assert.throws(() => assertLlmStreamChunk({ error: { message: "upstream refused" } }, ""), /upstream refused/);
});

test("API diagnostic storage excludes message text, responses, keys and reasoning", () => {
    const persisted = new Map();
    const log = makeLoader({ window: {} }, { "./kv-db": {
        registerKvMigration() {}, kvGet: key => persisted.get(key), kvSet: (key, value) => persisted.set(key, value),
    } })("lib/api-log-store.ts");
    log.pushApiLog({
        characterName: "private-name", model: "fixture-secret", messages: [{ role: "user", content: "private-message", marker: "fixture-secret" }],
        rawResponse: "private-response", reasoning: "private-reasoning", usage: { total_tokens: 18 },
    });
    const stored = [...persisted.values()][0];
    assert.doesNotMatch(stored, /private-|fixture-secret|reasoning/);
    assert.equal(log.getApiLogs()[0].usage.total_tokens, 18);
    assert.equal(log.getApiLogs()[0].messages[0].content, "消息 15 字符");
});

test("service worker removes only old Float caches and ignores both API paths even on navigation", async () => {
    const handlers = new Map();
    const deleted = [];
    const origin = "https://float.example";
    const self = {
        location: { origin },
        addEventListener: (name, handler) => handlers.set(name, handler),
        clients: { claim() {} },
    };
    vm.runInNewContext(readFileSync("public/sw.js", "utf8"), {
        self, URL, Request: class {},
        caches: {
            keys: async () => ["other-app", "ai-phone-pwa-v12-static", "ai-phone-pwa-v12-runtime", "ai-phone-pwa-v13-static", "ai-phone-pwa-v13-runtime", "ai-phone-pwa-v12-unrelated"],
            delete: async key => deleted.push(key),
            open: async () => ({ add: async () => {} }),
        },
    });
    let activation;
    handlers.get("activate")({ waitUntil: promise => { activation = promise; } });
    await activation;
    assert.deepEqual(deleted, ["ai-phone-pwa-v12-static", "ai-phone-pwa-v12-runtime"]);
    for (const path of ["/api", "/api/image-generation", "/lmu", "/lmu/v1/models"]) {
        for (const mode of ["navigate", "cors"]) {
            handlers.get("fetch")({
                request: { url: origin + path, mode, method: "GET", destination: "image" },
                respondWith: () => assert.fail("API was intercepted"),
            });
        }
    }
});
