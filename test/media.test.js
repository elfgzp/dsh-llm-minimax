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
  sanitizeFileName,
} from "../lib/media.js";

/** 建一組假的依賴，不做任何真實呼叫。 */
function fakeTools() {
  return createMediaTools({
    resolveActiveKey: async () => undefined,
    resolveWorkingDirectory: async () => process.cwd(),
    log: () => {},
  });
}

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
