/**
 * 多模態工具集的單測：不碰網路、不碰憑據，只驗證純邏輯與工具形狀。
 *
 * 執行：`node --test test/`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.js";
import {
  DEFAULT_VOICE_ID,
  IMAGE_MODELS,
  SEARCH_MODEL,
  SPEECH_MODELS,
  VIDEO_MODELS,
  createMediaTools,
  createMiniMaxSearchProvider,
  sanitizeFileName,
  withoutUndefined,
} from "../lib/media.js";

/** 建一組假的依賴，不做任何真實呼叫。 */
function fakeTools() {
  return createMediaTools({
    resolveActiveKey: async () => undefined,
    resolveWorkingDirectory: async () => process.cwd(),
    log: () => {},
  });
}

/**
 * 建一組會攔截 fetch 的依賴，讓測試能驗證「工具實際輸出的形狀」而不打網路。
 *
 * @param {object} response - 假的 Anthropic 回應內容。
 * @returns {{ tools: object[], calls: object[] }} 工具組與已攔截的請求。
 */
function fakeToolsWithFetch(response) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(response);
      },
    };
  };
  const tools = createMediaTools({
    resolveActiveKey: async () => ({
      region: "cn",
      key: "sk-test",
      apiRoot: "https://api.test",
      anthropicBase: "https://api.test/anthropic",
    }),
    resolveWorkingDirectory: async () => process.cwd(),
    log: () => {},
  });
  return {
    tools,
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/** 一個帶著各種缺失欄位的搜尋回應（title / page_age 都可能沒有）。 */
const SEARCH_RESPONSE = {
  content: [
    { type: "text", text: "搜尋到的答案。" },
    {
      type: "server_tool_use",
      id: "call_1",
      name: "web_search",
      input: { query: "測試查詢" },
    },
    {
      type: "web_search_tool_result",
      tool_use_id: "call_1",
      content: [
        // 沒有 title、沒有 page_age 的來源 —— 正是造成 undefined 的那種情況
        { type: "web_search_result", url: "https://example.com/a", content: "片段 A" },
        { type: "web_search_result", url: "https://example.com/b", title: "有標題", content: "片段 B", page_age: "2026/11/26" },
      ],
    },
  ],
  stop_reason: "end_turn",
};

test("sanitizeFileName 去掉路徑成分與 Windows 非法字元", () => {
  assert.equal(sanitizeFileName("a/b/c.txt", "fallback"), "c.txt");
  assert.equal(sanitizeFileName('bad:name*?.png', "fallback"), "badname.png");
  assert.equal(sanitizeFileName("  spaced  ", "fallback"), "spaced");
  assert.equal(sanitizeFileName("", "fallback"), "fallback");
  assert.equal(sanitizeFileName(undefined, "fallback"), "fallback");
});

test("sanitizeFileName 避開 Windows 保留裝置名", () => {
  assert.equal(sanitizeFileName("CON", "fallback"), "_CON");
  assert.equal(sanitizeFileName("lpt1", "fallback"), "_lpt1");
});

test("sanitizeFileName 去掉尾端空白與句點", () => {
  assert.equal(sanitizeFileName("name...", "fallback"), "name");
  assert.equal(sanitizeFileName("name. .", "fallback"), "name");
});

test("回歸：搜尋輸出不能含 undefined（否則 DSH 拒收整個結果）", () => {
  // 這條守的是一個真的壞過的 bug：搜尋結果的來源物件用 `title: undefined` 這類寫法
  // 表示「沒有這個欄位」，而 undefined 不是合法 JSON 值 —— DSH 直接拒收整個工具輸出，
  // 回報 "value is not lossless JSON"，工具等於完全不能用。
  const source = {
    url: "https://example.com/a",
    title: undefined,
    snippet: "內容",
    publishedAt: undefined,
  };
  const cleaned = withoutUndefined(source);
  assert.deepEqual(Object.keys(cleaned).sort(), ["snippet", "url"]);
  // JSON 序列化後必須與原物件完全一致（無損）。
  assert.equal(JSON.stringify(cleaned), JSON.stringify({ url: "https://example.com/a", snippet: "內容" }));
  // 而且序列化/反序列化不能改變內容。
  assert.deepEqual(JSON.parse(JSON.stringify(cleaned)), cleaned);
});

test("回歸：原生 web_search provider 的來源也要清掉 undefined", () => {
  const provider = harness().searchProviders[0];
  assert.equal(provider.id, "minimax");
  // provider 的 search() 內部組出 sources 時同樣會帶 undefined 欄位；
  // 這裡確認清理函式對「整個來源缺欄位」的情況也成立。
  const noTitle = withoutUndefined({ url: "https://example.com/b", title: undefined });
  assert.equal("title" in noTitle, false);
});

test("回歸：minimax_search 的實際輸出是 lossless JSON", async () => {
  const { tools, restore } = fakeToolsWithFetch(SEARCH_RESPONSE);
  try {
    const search = tools.find((t) => t.name === "minimax_search");
    const result = await search.execute({ query: "測試查詢", maxUses: 2 }, { signal: undefined });

    // 遞迴檢查有沒有任何 undefined 值 —— 這是 DSH 拒收的真正條件。
    const findUndefined = (value, path = "$") => {
      if (value === undefined) return [path];
      if (value === null || typeof value !== "object") return [];
      const out = [];
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) out.push(`${path}.${key}`);
        else out.push(...findUndefined(child, `${path}.${key}`));
      }
      return out;
    };
    assert.deepEqual(findUndefined(result), [], "輸出不得含 undefined 值");
    // JSON round-trip 必須無損。
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    // 內容也確認正確。
    assert.equal(result.answer, "搜尋到的答案。");
    assert.deepEqual(result.searches, ["測試查詢"]);
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].url, "https://example.com/a");
    assert.equal("title" in result.sources[0], false, "沒有 title 時不應出現該欄位");
    assert.equal(result.sources[1].title, "有標題");
    assert.equal(result.sources[1].publishedAt, "2026/11/26");
  } finally {
    restore();
  }
});

test("回歸：原生 web_search provider 的輸出也是 lossless JSON", async () => {
  const { tools, restore } = fakeToolsWithFetch(SEARCH_RESPONSE);
  try {
    const provider = createMiniMaxSearchProvider({
      resolveActiveKey: async () => ({
        region: "cn",
        key: "sk-test",
        apiRoot: "https://api.test",
        anthropicBase: "https://api.test/anthropic",
      }),
    });
    const result = await provider.search({ query: "測試查詢" });
    const json = JSON.stringify(result);
    assert.equal(json.includes("undefined"), false, "序列化後不得出現 undefined");
    assert.deepEqual(JSON.parse(json), result);
    assert.equal(result.sources.length, 2);
    assert.equal("title" in result.sources[0], false);
    assert.ok(tools.length > 0);
  } finally {
    restore();
  }
});

test("工具集提供六個工具，名稱符合預期", () => {
  const tools = fakeTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "minimax_search",
      "minimax_generate_image",
      "minimax_generate_video",
      "minimax_video_status",
      "minimax_speak",
      "minimax_voices",
    ],
  );
});
test("每個工具都有描述、參數與 execute", () => {
  for (const tool of fakeTools()) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.description.length > 20, `${tool.name} 的描述太短`);
    assert.equal(typeof tool.parameters, "object");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output?.render, "function");
    assert.ok(typeof tool.timeoutMs === "number" && tool.timeoutMs > 0);
  }
});

test("必填參數都標了 required", () => {
  const byName = new Map(fakeTools().map((tool) => [tool.name, tool]));
  assert.equal(byName.get("minimax_search").parameters.query.required, true);
  assert.equal(byName.get("minimax_generate_image").parameters.prompt.required, true);
  assert.equal(byName.get("minimax_generate_video").parameters.prompt.required, true);
  assert.equal(byName.get("minimax_video_status").parameters.taskId.required, true);
  assert.equal(byName.get("minimax_speak").parameters.text.required, true);
});

test("模型清單與官方一致", () => {
  assert.deepEqual(IMAGE_MODELS, ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"]);
  assert.ok(VIDEO_MODELS.includes("MiniMax-H3"));
  assert.ok(SPEECH_MODELS.includes("speech-2.8-hd"));
  assert.equal(SEARCH_MODEL, "MiniMax-M3.1-Flash");
  assert.equal(DEFAULT_VOICE_ID, "male-qn-qingse");
});

test("沒有 Key 時工具仍然可以被建立（開放與否交給註冊時的 when 判斷）", async () => {
  const tools = fakeTools();
  const search = tools.find((tool) => tool.name === "minimax_search");
  await assert.rejects(
    () => search.execute({ query: "test" }, { signal: undefined }),
    /尚未設定可用的 API Key/,
  );
});

test("宿主啟動時把多模態工具註冊進 tools 服務", () => {
  const host = harness();
  const names = host.registeredTools.map((entry) => entry.definition.name);
  for (const expected of [
    "minimax_search",
    "minimax_generate_image",
    "minimax_generate_video",
    "minimax_video_status",
    "minimax_speak",
    "minimax_voices",
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  }
});

test("每個工具都帶 when 條件（沒有 Key 就不開放給模型）", () => {
  const host = harness();
  for (const entry of host.registeredTools) {
    assert.equal(typeof entry.options?.when, "function");
  }
});

test("聯網搜尋 provider 被註冊進 web 服務，id 是 minimax", () => {
  const host = harness();
  assert.equal(host.searchProviders.length, 1);
  assert.equal(host.searchProviders[0].id, "minimax");
  assert.equal(typeof host.searchProviders[0].search, "function");
  assert.equal(typeof host.searchProviders[0].available, "function");
});

test("回歸：provider 註冊必須發生在插件掛載當下，不是靠 runtime ctx.inject", () => {
  // 這條守的是一個真的壞過的 bug：先前用 ctx.inject(["web"], ...) 註冊搜尋 provider，
  // 那個 API 的語義與 plugin-level `export const inject` 不同，註冊從未發生，
  // 原生 web_search 一直走 DeepSeek（餘額不足 → 402），而離線測試全綠。
  // 測試替身現在把服務掛在 ctx 上，與真實 Loader 的行為一致。
  const host = harness();
  assert.ok(
    host.searchProviders.length > 0,
    "搜尋 provider 必須在掛載當下就註冊到 web 服務",
  );
  assert.equal(host.searchProviders[0].id, "minimax");
});

test("原生 web_search 被指向 MiniMax（使用者沒指定過 provider 時）", async () => {
  const host = harness({ envKeys: { MINIMAX_CN_API_KEY: "sk-cp-fake-key-for-test" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const writes = host.settings.writes ?? [];
  assert.ok(writes.length > 0, "應該有寫入 web.searchProvider");
  assert.deepEqual(writes[0].ns, "include:web");
  assert.deepEqual(writes[0].ops, [{ op: "set", path: ["searchProvider"], value: "minimax" }]);
});

test("使用者自己指定過 provider 時不接管", async () => {
  const host = harness({
    envKeys: { MINIMAX_CN_API_KEY: "sk-cp-fake-key-for-test" },
    webSearchProvider: "some-other-provider",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((host.settings.writes ?? []).length, 0, "不應該覆寫使用者的選擇");
});

test("關掉接管時完全不動原生搜尋（opt-out 開關）", async () => {
  const host = harness({
    envKeys: { MINIMAX_CN_API_KEY: "sk-cp-fake-key-for-test" },
    config: { disableWebSearchTakeover: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((host.settings.writes ?? []).length, 0);
});

test("設定為空物件時預設接管（不受 Loader 預設值解析方式影響）", async () => {
  const host = harness({
    envKeys: { MINIMAX_CN_API_KEY: "sk-cp-fake-key-for-test" },
    config: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((host.settings.writes ?? []).length > 0, "預設應該接管");
});
