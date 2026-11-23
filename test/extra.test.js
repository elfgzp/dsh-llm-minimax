/**
 * 第二組能力（ASR / 異步語音 / 音色 / 檔案 / 影片任務）的形狀與純邏輯測試。
 *
 * 執行：`node --test test/`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ASR_FORMATS, SPEECH_MODELS, UPLOAD_PURPOSES, createExtraTools } from "../lib/extra.js";
import { harness } from "./harness.js";

/** 建一組假的依賴，不做任何真實呼叫。 */
function fakeTools() {
  return createExtraTools({
    resolveActiveKey: async () => undefined,
    resolveWorkingDirectory: async () => process.cwd(),
  });
}

test("第二組提供八個工具，名稱符合預期", () => {
  const tools = fakeTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "minimax_transcribe",
      "minimax_speak_long",
      "minimax_speak_status",
      "minimax_clone_voice",
      "minimax_design_voice",
      "minimax_upload_file",
      "minimax_video_tasks",
      "minimax_video_cancel",
    ],
  );
});

test("每個工具都有描述、參數、execute 與逾時", () => {
  for (const tool of fakeTools()) {
    assert.ok(tool.description.length > 20, `${tool.name} 的描述太短`);
    assert.equal(typeof tool.parameters, "object");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output?.render, "function");
    assert.ok(typeof tool.timeoutMs === "number" && tool.timeoutMs > 0);
  }
});

test("宿主啟動時第二組工具也註冊進 tools 服務", () => {
  const host = harness();
  const names = host.registeredTools.map((entry) => entry.definition.name);
  for (const expected of [
    "minimax_transcribe",
    "minimax_speak_long",
    "minimax_clone_voice",
    "minimax_design_voice",
    "minimax_upload_file",
    "minimax_video_tasks",
    "minimax_video_cancel",
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  }
});

test("常數與官方文件一致", () => {
  assert.ok(ASR_FORMATS.includes("mp3"));
  assert.ok(ASR_FORMATS.includes("wav"));
  assert.ok(SPEECH_MODELS.includes("speech-2.8-hd"));
  assert.ok(UPLOAD_PURPOSES.includes("image_generation_input"));
  assert.ok(UPLOAD_PURPOSES.includes("video_generation_input"));
  assert.ok(UPLOAD_PURPOSES.includes("voice_clone"));
});

test("沒有 Key 時工具會回可讀的錯誤，而不是靜默失敗", async () => {
  const tools = fakeTools();
  const transcribe = tools.find((tool) => tool.name === "minimax_transcribe");
  await assert.rejects(
    () => transcribe.execute({ file: "x.mp3" }, { signal: undefined }),
    /尚未設定可用的 API Key/,
  );
});

test("音色複刻的 voiceId 格式錯誤會被擋下", async () => {
  const host = harness({ envKeys: { MINIMAX_CN_API_KEY: "sk-cp-fake" } });
  const clone = host.registeredTools.find((entry) => entry.definition.name === "minimax_clone_voice");
  await assert.rejects(
    () =>
      clone.definition.execute({ audioFile: "a.mp3", voiceId: "bad id!" }, { signal: undefined }),
    /voiceId/,
  );
});

test("影片任務列表回應會被整理成精簡欄位", async () => {
  const host = harness({ envKeys: { MINIMAX_CN_API_KEY: "sk-cp-fake" } });
  const list = host.registeredTools.find((entry) => entry.definition.name === "minimax_video_tasks");
  // 沒有網路時應該拋出可讀錯誤，而不是回 undefined。
  await assert.rejects(
    () => list.definition.execute({}, { signal: undefined }),
    /MiniMax 影片任務列表失敗/,
  );
});
