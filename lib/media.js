/**
 * MiniMax 多模態能力工具集（圖像 / 視頻 / 語音 / 聯網搜尋）。
 *
 * 為什麼放在這個插件裡，而不是另裝一個第三方插件：
 *
 *   - 這些能力**必須用 MiniMax 的 Key**。本插件已經把 Key 管在憑據庫裡
 *     （`MINIMAX_CN_API_KEY` / `MINIMAX_API_KEY`），而且知道「哪一把正在生效」
 *     以及「它屬於哪個區域」。另起一個插件等於要再維護一份 Key 管理。
 *   - 底層 `pi-ai` 的聊天協定**不可能**產生圖像／視訊／音訊：Anthropic 回應
 *     只認 `text / thinking / redacted_thinking / tool_use` 五種 block，
 *     DSH 端還會對 assistant 側的 image block 直接丟錯。
 *     所以「多模態生成」在本質上只能是**獨立的工具**，不是聊天模型能力。
 *
 * 端點與參數來源（官方 OpenAPI，實測 2026-11-19）：
 *   - 文生圖  POST {apiRoot}/v1/images/generations   模型 MiniMax-H3-Image[-Highspeed]
 *   - 圖生圖  POST {apiRoot}/v1/images/edits           參考圖 1~16 張
 *   - 視頻    POST {apiRoot}/v2/video_generation       模型 MiniMax-H3[-Highspeed|-Lite|-Max]
 *   - 視頻查詢 GET  {apiRoot}/v2/query/video_generation/{task_id}
 *   - 語音    POST {apiRoot}/v1/t2a_v2                 模型 speech-2.8-hd 等
 *   - 音色    POST {apiRoot}/v1/get_voice
 *   - 聯網搜尋 POST {anthropicBase}/v1/messages         tools:[{type:"web_search_20250305"}]
 *
 * ⚠️ 兩條硬約束（官方明寫）：
 *   1. 圖像端點**不支援冪等**：請求送出後就算客戶端逾時，服務端仍會完成生成並計費。
 *      所以這裡**不做自動重試**，逾時就是逾時，如實回報。
 *   2. 圖像端點服務端最多等 600 秒，客戶端逾時必須 ≥600 秒，否則會出現
 *      「已計費但沒拿到圖」。這裡設 660 秒。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { failureOf } from "./catalog.js";
import {
  callJson,
  createOutputPath,
  download,
  errorMessageOf,
  mimeOf,
  sanitizeFileName,
} from "./shared.js";

export { sanitizeFileName };

/** 圖像模型（官方：兩者參數與限制相同）。 */
export const IMAGE_MODELS = ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"];
/** 視頻模型。H3 支援 768P/2K，其餘僅 480P/768P。 */
export const VIDEO_MODELS = ["MiniMax-H3", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite", "MiniMax-H3-Max"];
/** 語音合成模型。 */
export const SPEECH_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
];
/** 聯網搜尋走哪個聊天模型（服務端 web_search 依賴模型的工具能力）。 */
export const SEARCH_MODEL = "MiniMax-M3.1-Flash";
/** 預設音色（官方文件範例中的音色 id）。 */
export const DEFAULT_VOICE_ID = "male-qn-qingse";

/** 圖像端點最長等待（毫秒）。官方建議客戶端逾時 ≥600 秒。 */
const IMAGE_TIMEOUT_MS = 660_000;
/** 視頻任務輪詢間隔（毫秒）。 */
const VIDEO_POLL_INTERVAL_MS = 10_000;
/** 單張參考圖的體積上限（MB）。超過請先自行壓縮。 */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

/**
 * 把本機檔案轉成 MiniMax 接受的 data URI。
 *
 * 超過 20 MB 的參考圖請改用 `minimax_upload_file` 上傳後引用 `mm_file://{file_id}`
 * （官方上限 64 MB），不要在這裡硬塞。
 *
 * @param {string} filePath - 本機路徑。
 * @returns {Promise<string>} data URI。
 */
async function toDataUri(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error(
      `參考圖 ${filePath} 有 ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB，超過 ${MAX_REFERENCE_BYTES / 1024 / 1024} MB 上限。` +
        `請先縮小，或改用 minimax_upload_file 上傳後引用 mm_file://file_id（官方上限 64 MB）。`,
    );
  }
  const mime = mimeOf(filePath);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/**
 * 把使用者給的參考圖輸入轉成 API 需要的 `{ image_url }` 陣列。
 *
 * 接受三種寫法：http(s) 公開網址、`mm_file://{file_id}`、本機路徑。
 *
 * @param {string[]} inputs - 使用者輸入。
 * @returns {Promise<Array<{ image_url: string }>>} API 需要的參考圖陣列。
 */
async function toImageInputs(inputs) {
  const out = [];
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) {
      out.push({ image_url: input });
    } else if (input.startsWith("mm_file://")) {
      out.push({ image_url: input });
    } else {
      out.push({ image_url: await toDataUri(input) });
    }
  }
  return out;
}

/**
 * 數出一次回應裡模型發起了幾次服務端搜尋。
 *
 * 用來把「允許的搜尋次數」當成跨輪的總預算，而不是每輪重設。
 *
 * @param {any} content - Anthropic 回應的 content 陣列。
 * @returns {number} 搜尋次數。
 */
function countToolUses(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => block?.type === "server_tool_use").length;
}

/**
 * 建立 MiniMax 搜尋 provider，供 DSH 原生的 `web_search` 工具使用。
 *
 * 為什麼需要這個：DSH 內建的 `web_search` 走的是 DeepSeek 的 `/v1/tools/search`，
 * 需要另一家的憑證與餘額。MiniMax 的服務端 `web_search` 走的是同一把 MiniMax Key，
 * 註冊成 provider 之後，原生工具就能在 MiniMax 路由上直接用（不用另外發一個
 * `minimax_search` 工具出去）。
 *
 * provider 的 `search()` 每次只處理**一個** query（這是 seam 的契約），
 * `dsh-tool-web` 會並行發多個 query 再合併結果。
 *
 * @param {object} deps - 依賴。
 * @param {() => Promise<{ region: string, key: string, apiRoot: string, anthropicBase: string } | undefined>} deps.resolveActiveKey - 取得當前生效的 Key 與區域端點。
 * @returns {object} WebSearchProvider。
 */
export function createMiniMaxSearchProvider({ resolveActiveKey }) {
  return {
    id: "minimax",
    title: "MiniMax 聯網搜尋",
    available() {
      return true;
    },
    async ready() {
      try {
        return (await resolveActiveKey()) !== undefined;
      } catch {
        return false;
      }
    },
    async search(request, signal) {
      const active = await resolveActiveKey();
      if (active === undefined) {
        throw new Error("MiniMax 尚未設定可用的 API Key，無法聯網搜尋。");
      }
      const { status, body } = await callJson({
        url: `${active.anthropicBase}/v1/messages`,
        body: {
          model: SEARCH_MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: request.query }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        },
        headers: {
          authorization: `Bearer ${active.key}`,
          "x-api-key": active.key,
          "anthropic-version": "2023-06-01",
        },
        timeoutMs: 180_000,
        signal,
      });
      if (status !== 200 || body === undefined) {
        throw new Error(`MiniMax 聯網搜尋失敗：${errorMessageOf(status, body)}`);
      }
      const texts = [];
      const sources = [];
      for (const block of Array.isArray(body.content) ? body.content : []) {
        if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
        if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const item of block.content) {
            if (item?.type !== "web_search_result" || typeof item.url !== "string") continue;
            sources.push({
              url: item.url,
              title: typeof item.title === "string" ? item.title : undefined,
              snippet: typeof item.content === "string" ? item.content.slice(0, 400) : undefined,
              publishedAt: typeof item.page_age === "string" ? item.page_age : undefined,
            });
          }
        }
      }
      const answer = texts.join("\n\n").trim();
      return {
        ...answer.length > 0 ? { content: answer } : {},
        sources,
        truncated: false,
      };
    },
  };
}

/**
 * 建立 MiniMax 媒體工具集。
 *
 * @param {object} deps - 依賴。
 * @param {() => Promise<{ region: string, key: string, apiRoot: string, anthropicBase: string } | undefined>} deps.resolveActiveKey - 取得當前生效的 Key 與區域。
 * @param {(agent: any) => Promise<string>} deps.resolveWorkingDirectory - 取得會話工作目錄。
 * @param {(message: string) => void} [deps.log] - 日誌。
 * @returns {Array<object>} ToolDefinition 陣列。
 */
export function createMediaTools({ resolveActiveKey, resolveWorkingDirectory, log }) {
  /**
   * 取當前生效的 Key；沒有就丟出可讀的錯誤。
   *
   * @returns {Promise<{ region: string, key: string, apiRoot: string, anthropicBase: string }>} 生效的 Key 資訊。
   */
  async function activeKey() {
    const active = await resolveActiveKey();
    if (active === undefined) {
      throw new Error(
        "MiniMax 尚未設定可用的 API Key。請到「設定 → MiniMax」貼上 Key 並選為生效；或在「設定 → 模型」直接設定。",
      );
    }
    return active;
  }

  /**
   * 解析輸出路徑：使用者指定的相對路徑以工作目錄為根，絕對路徑照用。
   *
   * @param {any} agent - 發起呼叫的 agent。
   * @param {string | undefined} requested - 使用者指定的路徑或檔名。
   * @param {string} fallbackBase - 預設檔名（不含副檔名）。
   * @param {string} ext - 副檔名。
   * @returns {Promise<string>} 可寫入的絕對路徑。
   */
  const outputPath = createOutputPath(resolveWorkingDirectory);

  // ---------------------------------------------------------------- 聯網搜尋

  /**
   * MiniMax 服務端 web_search：模型在伺服器端自己檢索並作答。
   *
   * 底層 `pi-ai` 的 Anthropic 協定只會產生 client tool，無法透傳這種服務端工具，
   * 所以這裡直接打 Anthropic 相容端點，把 `server_tool_use` 與
   * `web_search_tool_result` 兩種 block 收斂成「答案 + 來源」。
   *
   * @param {string} query - 查詢。
   * @param {number} maxUses - 允許的搜尋次數。
   * @param {AbortSignal} signal - 取消訊號。
   * @returns {Promise<{ answer: string, sources: Array<object>, searches: string[] }>} 搜尋結果。
   */
  async function runSearch(query, maxUses, signal) {
    const active = await activeKey();
    const budget = Math.min(Math.max(maxUses, 1), 10);
    let used = 0;
    const messages = [{ role: "user", content: query }];
    const sources = [];
    const searches = [];
    let answer = "";

    // 搜尋次數用完時，模型會以 `pause_turn` 收尾（沒有最終答案）。官方流程是：
    // 把這次的 content 原樣當作 assistant 訊息追加回去再問一次。預算用完的那一輪
    // 不再帶工具，模型就會直接用已知的搜尋結果給出答案。
    for (let round = 0; round < 6; round += 1) {
      const remaining = budget - used;
      const withTool = remaining > 0;
      const { status, body } = await callJson({
        url: `${active.anthropicBase}/v1/messages`,
        body: {
          model: SEARCH_MODEL,
          max_tokens: 4096,
          messages,
          ...(withTool
            ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: remaining }] }
            : {}),
        },
        headers: {
          authorization: `Bearer ${active.key}`,
          "x-api-key": active.key,
          "anthropic-version": "2023-06-01",
        },
        timeoutMs: 180_000,
        signal,
      });
      if (status !== 200 || body === undefined) {
        throw new Error(`MiniMax 聯網搜尋失敗：${errorMessageOf(status, body)}`);
      }
      const roundTexts = [];
      for (const block of Array.isArray(body.content) ? body.content : []) {
        if (block?.type === "text" && typeof block.text === "string") roundTexts.push(block.text);
        if (block?.type === "server_tool_use" && typeof block.input?.query === "string") {
          searches.push(block.input.query);
        }
        if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const item of block.content) {
            if (item?.type !== "web_search_result" || typeof item.url !== "string") continue;
            sources.push({
              url: item.url,
              title: typeof item.title === "string" ? item.title : undefined,
              snippet: typeof item.content === "string" ? item.content.slice(0, 600) : undefined,
              publishedAt: typeof item.page_age === "string" ? item.page_age : undefined,
            });
          }
        }
      }
      used += countToolUses(body.content);
      const joined = roundTexts.join("\n\n").trim();
      if (joined.length > 0) answer = answer.length > 0 ? `${answer}\n\n${joined}` : joined;
      if (body.stop_reason !== "pause_turn") break;
      if (!withTool) break;
      // 續問時**不能**把 `web_search_tool_result` 原樣帶回去。
      //
      // MiniMax 對「tool result 的 tool id 找不到」很嚴格：pause_turn 的回應尾端常有一個
      // 還沒配對到結果的 `server_tool_use`，把整段 content 原樣送回去就會觸發 2013。
      // 實測（2026-11-19）：帶著 result 續問 → 400 "tool result's tool id not found"；
      // 濾掉 result 區塊後續問 → 200 end_turn，模型能直接用已知結果作答。
      // 搜尋結果本身已經在上面的迴圈裡收走了，這裡只是不把它 echo 回去。
      messages.push({
        role: "assistant",
        content: body.content.filter((block) => block?.type !== "web_search_tool_result"),
      });
    }

    // 模型沒給出文字時，至少把搜尋到的片段回報出去，而不是回一個空的答案。
    if (answer.length === 0 && sources.length > 0) {
      answer = sources
        .slice(0, 5)
        .map((source) => `- ${source.title ?? source.url}: ${(source.snippet ?? "").slice(0, 240)}`)
        .join("\n");
    }
    return { answer, sources, searches };
  }

  // ---------------------------------------------------------------- 圖像

  /**
   * 生成圖像（無參考圖＝文生圖；有參考圖＝圖生圖／編輯）。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function generateImage(args, exec) {
    const active = await activeKey();
    const model = IMAGE_MODELS.includes(args.model) ? args.model : IMAGE_MODELS[0];
    const references = Array.isArray(args.referenceImages) ? args.referenceImages : [];
    if (references.length > 16) throw new Error("參考圖最多 16 張。");
    const n = Math.min(Math.max(Number(args.count ?? 1) || 1, 1), 10);

    const body = { model, prompt: String(args.prompt ?? ""), n };
    if (typeof args.aspectRatio === "string" && args.aspectRatio.length > 0) body.aspect_ratio = args.aspectRatio;
    if (typeof args.size === "string" && args.size.length > 0) body.size = args.size;
    if (typeof args.area === "string" && args.area.length > 0) body.area = args.area;
    if (typeof args.outputFormat === "string" && args.outputFormat.length > 0) {
      body.output_format = args.outputFormat;
    }
    if (references.length > 0) {
      body.images = await toImageInputs(references);
    }

    const url = references.length > 0
      ? `${active.apiRoot}/v1/images/edits`
      : `${active.apiRoot}/v1/images/generations`;

    const { status, body: response } = await callJson({
      url,
      body,
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: IMAGE_TIMEOUT_MS,
      signal: exec.signal,
    });
    if (status !== 200 || response === undefined) {
      throw new Error(`MiniMax 圖像生成失敗：${errorMessageOf(status, response)}`);
    }

    const ext = body.output_format === "png" ? ".png" : body.output_format === "webp" ? ".webp" : ".jpg";
    const base = sanitizeFileName(args.outputFile, "minimax-image");
    const files = [];
    const failures = [];
    const revised = [];
    const items = Array.isArray(response.data) ? response.data : [];
    for (const [index, item] of items.entries()) {
      if (item?.error) {
        failures.push(`第 ${index + 1} 張：${item.error.message ?? item.error.code}`);
        continue;
      }
      const suffix = items.length > 1 ? `-${index + 1}` : "";
      const target = await outputPath(exec.agent, `${base}${suffix}`, base, ext);
      if (typeof item.b64_json === "string") {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(item.b64_json, "base64"));
      } else if (typeof item.url === "string") {
        await download(item.url, target);
      } else {
        failures.push(`第 ${index + 1} 張：回應缺少圖片資料`);
        continue;
      }
      if (typeof item.revised_prompt === "string") revised.push(item.revised_prompt);
      files.push({ path: target, size: typeof item.size === "string" ? item.size : undefined });
    }
    if (files.length === 0) {
      throw new Error(
        `MiniMax 圖像生成沒有產出任何圖片：${failures.join("；") || "未知原因"}`,
      );
    }
    return {
      files,
      ...(failures.length > 0 ? { failures } : {}),
      ...(revised.length > 0 ? { revisedPrompts: revised } : {}),
      requestId: response.request_id,
      usage: response.usage,
    };
  }

  // ---------------------------------------------------------------- 視頻

  /**
   * 提交視頻生成任務並輪詢到終態（或逾時）。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function generateVideo(args, exec) {
    const active = await activeKey();
    const model = VIDEO_MODELS.includes(args.model) ? args.model : VIDEO_MODELS[0];
    const content = [{ type: "text", text: String(args.prompt ?? "") }];
    const references = [];
    if (typeof args.firstFrame === "string" && args.firstFrame.length > 0) {
      const [item] = await toImageInputs([args.firstFrame]);
      content.push({ type: "image_url", image_url: item, role: "first_frame" });
      references.push("first_frame");
    }
    if (typeof args.lastFrame === "string" && args.lastFrame.length > 0) {
      const [item] = await toImageInputs([args.lastFrame]);
      content.push({ type: "image_url", image_url: item, role: "last_frame" });
      references.push("last_frame");
    }
    const duration = Math.min(Math.max(Number(args.duration ?? 5) || 5, 4), 15);
    const resolution = typeof args.resolution === "string" ? args.resolution : model === "MiniMax-H3" ? "768P" : "768P";
    const ratio = typeof args.ratio === "string" ? args.ratio : "adaptive";

    const body = { model, content, resolution, duration, ratio };
    if (typeof args.generateAudio === "boolean") body.generate_audio = args.generateAudio;

    const created = await callJson({
      url: `${active.apiRoot}/v2/video_generation`,
      body,
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 120_000,
      signal: exec.signal,
    });
    if (created.status !== 200 || created.body === undefined) {
      throw new Error(`MiniMax 視頻生成提交失敗：${errorMessageOf(created.status, created.body)}`);
    }
    const taskId = created.body?.task_id;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("MiniMax 視頻生成沒有回傳 task_id，無法追蹤任務。");
    }
    const waitSeconds = Math.min(Math.max(Number(args.waitSeconds ?? 480) || 480, 30), 1500);
    return pollVideo(active, taskId, args, exec, waitSeconds);
  }

  /**
   * 輪詢視頻任務直到終態。
   *
   * @param {object} active - 生效的 Key 資訊。
   * @param {string} taskId - 任務 id。
   * @param {object} args - 工具參數（取 outputFile）。
   * @param {any} exec - 執行上下文。
   * @param {number} waitSeconds - 最多等待秒數。
   * @returns {Promise<object>} 工具輸出。
   */
  async function pollVideo(active, taskId, args, exec, waitSeconds) {
    const deadline = Date.now() + waitSeconds * 1000;
    let task;
    while (true) {
      const { status, body } = await callJson({
        url: `${active.apiRoot}/v2/query/video_generation/${encodeURIComponent(taskId)}`,
        method: "GET",
        headers: { authorization: `Bearer ${active.key}` },
        timeoutMs: 60_000,
        signal: exec.signal,
      });
      if (status !== 200 || body === undefined) {
        throw new Error(`MiniMax 視頻任務查詢失敗：${errorMessageOf(status, body)}`);
      }
      task = body?.task ?? body;
      const state = task?.status;
      if (state === "succeeded" || state === "failed" || state === "cancelled") break;
      if (Date.now() >= deadline) {
        return {
          taskId,
          status: state ?? "unknown",
          finished: false,
          message: `視頻還在生成中（${state ?? "unknown"}）。稍後用 minimax_video_status 帶 taskId=${taskId} 取回。`,
        };
      }
      await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
    }
    if (task?.status !== "succeeded") {
      return {
        taskId,
        status: task?.status ?? "unknown",
        finished: true,
        error: task?.error?.message ?? "任務失敗",
        code: task?.error?.code,
      };
    }
    const videoUrl = task?.content?.url;
    if (typeof videoUrl !== "string" || videoUrl.length === 0) {
      return { taskId, status: "succeeded", finished: true, message: "任務成功但回應沒有影片網址。" };
    }
    const target = await outputPath(exec.agent, args?.outputFile, "minimax-video", ".mp4");
    const bytes = await download(videoUrl, target);
    return {
      taskId,
      status: "succeeded",
      finished: true,
      file: { path: target, bytes },
      duration: task?.duration,
      resolution: task?.resolution,
      ratio: task?.ratio,
      usage: task?.usage,
    };
  }

  // ---------------------------------------------------------------- 語音

  /**
   * 語音合成（TTS），輸出 mp3 檔。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function speak(args, exec) {
    const active = await activeKey();
    const model = SPEECH_MODELS.includes(args.model) ? args.model : SPEECH_MODELS[0];
    const text = String(args.text ?? "");
    if (text.trim().length === 0) throw new Error("要合成的文字是空的。");
    if (text.length > 10_000) {
      throw new Error(`單次合成上限 10000 字，收到 ${text.length} 字。請分段合成。`);
    }
    const format = ["mp3", "pcm", "flac", "wav"].includes(args.format) ? args.format : "mp3";
    const body = {
      model,
      text,
      stream: false,
      voice_setting: {
        voice_id: typeof args.voiceId === "string" && args.voiceId.length > 0 ? args.voiceId : DEFAULT_VOICE_ID,
        speed: typeof args.speed === "number" ? args.speed : 1,
        vol: typeof args.volume === "number" ? args.volume : 1,
        pitch: typeof args.pitch === "number" ? args.pitch : 0,
        ...(typeof args.emotion === "string" && args.emotion.length > 0 ? { emotion: args.emotion } : {}),
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 },
    };
    const { status, body: response } = await callJson({
      url: `${active.apiRoot}/v1/t2a_v2`,
      body,
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 300_000,
      signal: exec.signal,
    });
    if (status !== 200 || response === undefined) {
      throw new Error(`MiniMax 語音合成失敗：${errorMessageOf(status, response)}`);
    }
    const failure = failureOf(response);
    if (failure !== undefined) {
      throw new Error(`MiniMax 語音合成失敗：${failure.message}`);
    }
    const audio = response?.data?.audio;
    if (typeof audio !== "string" || audio.length === 0) {
      throw new Error("MiniMax 語音合成沒有回傳音訊資料。");
    }
    const ext = format === "mp3" ? ".mp3" : format === "flac" ? ".flac" : format === "wav" ? ".wav" : ".pcm";
    const target = await outputPath(exec.agent, args.outputFile, "minimax-speech", ext);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(audio, "hex"));
    return {
      file: { path: target, bytes: Buffer.from(audio, "hex").byteLength },
      model,
      voiceId: body.voice_setting.voice_id,
      durationMs: response?.extra_info?.audio_length,
      characters: response?.extra_info?.usage_characters,
      format,
    };
  }

  /**
   * 列出可用音色。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function voices(args, exec) {
    const active = await activeKey();
    const { status, body } = await callJson({
      url: `${active.apiRoot}/v1/get_voice`,
      // 官方明寫 `voice_type` 是必填：system / voice_cloning / voice_generation / all。
      body: { voice_type: ["system", "voice_cloning", "voice_generation", "all"].includes(args?.type) ? args.type : "all" },
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 60_000,
      signal: exec.signal,
    });
    if (status !== 200 || body === undefined) {
      throw new Error(`MiniMax 音色查詢失敗：${errorMessageOf(status, body)}`);
    }
    const failure = failureOf(body);
    if (failure !== undefined) throw new Error(`MiniMax 音色查詢失敗：${failure.message}`);
    const pick = (list) =>
      Array.isArray(list)
        ? list.slice(0, 300).map((item) => ({
            voiceId: item?.voice_id,
            name: item?.voice_name ?? (Array.isArray(item?.description) ? item.description[0] : undefined),
          }))
        : [];
    return {
      systemVoices: pick(body?.system_voice),
      clonedVoices: pick(body?.voice_cloning),
      generatedVoices: pick(body?.voice_generation),
    };
  }

  /** 有可用 Key 才開放這組工具。 */
  const when = async () => {
    try {
      return (await resolveActiveKey()) !== undefined;
    } catch {
      return false;
    }
  };

  const text = (value) => [{ type: "text", text: value }];

  return [
    {
      name: "minimax_search",
      description:
        "用 MiniMax 服務端的聯網搜尋回答需要即時資訊的問題（天氣、新聞、股價、文件查詢等）。搜尋在 MiniMax 伺服器端執行，回傳整理好的答案與來源網址。同一把 MiniMax Key 計費。",
      parameters: {
        query: { type: "string", required: true, description: "要搜尋並回答的問題（自然語言即可）。" },
        maxUses: {
          type: "integer",
          description: "允許的搜尋次數，1–10，預設 5。問題需要比對多個來源時才需要調高。",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            sources: { type: "array", items: { type: "object" } },
            searches: { type: "array", items: { type: "string" } },
          },
        },
        render: (_args, value) => {
          const lines = [];
          if (value.answer) lines.push(value.answer);
          if (value.sources?.length > 0) {
            lines.push("Sources:");
            for (const source of value.sources) {
              lines.push(`- [${source.title ?? source.url}](${source.url})`);
            }
          }
          lines.push("Cite the relevant URLs above as markdown links in your answer.");
          return text(lines.join("\n\n"));
        },
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await runSearch(
          String(args.query ?? ""),
          Math.min(Math.max(Number(args.maxUses ?? 5) || 5, 1), 10),
          exec.signal,
        );
        return result;
      },
    },
    {
      name: "minimax_generate_image",
      description:
        "用 MiniMax H3-Image 生成或編輯圖片。給 referenceImages 就是以參考圖為基礎生成／修改（最多 16 張，依序對應圖1、圖2…），不給就是文字生成圖。回傳落地檔案路徑。同步等待，最多約 10 分鐘；逾時不會自動重試（重試會重複計費）。",
      parameters: {
        prompt: { type: "string", required: true, description: "畫面描述；把排除項也寫在同一段裡。" },
        referenceImages: {
          type: "array",
          items: { type: "string" },
          description: "參考圖：公開網址、mm_file://file_id，或本機檔案路徑（最多 16 張）。",
        },
        model: { type: "string", description: `模型：${IMAGE_MODELS.join(" / ")}，預設 ${IMAGE_MODELS[0]}。` },
        count: { type: "integer", description: "生成張數 1–10，預設 1。同一張圖裡的多格排版也算一張。" },
        aspectRatio: { type: "string", description: "寬高比，例如 16:9、3:4、9:16、1:1。不填由服務端決定。" },
        size: { type: "string", description: "直接指定尺寸，例如 2720x1536。給了就不能再給 aspectRatio 或 area。" },
        area: { type: "string", description: "面積檔位 1K / 2K / 4K，預設 4K。" },
        outputFormat: { type: "string", description: "png / jpeg / webp，預設 jpeg。" },
        outputFile: { type: "string", description: "輸出檔名（不含副檔名）。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "object" } },
            failures: { type: "array", items: { type: "string" } },
            revisedPrompts: { type: "array", items: { type: "string" } },
            requestId: { type: "string" },
          },
        },
        render: (_args, value) =>
          text(
            [
              ...(value.files ?? []).map((file) => `- ${file.path}${file.size ? ` (${file.size})` : ""}`),
              ...(value.failures ?? []).map((failure) => `- 失敗：${failure}`),
            ].join("\n") || "沒有產出檔案。",
          ),
      },
      timeoutMs: IMAGE_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await generateImage(args, exec);
      },
    },
    {
      name: "minimax_generate_video",
      description:
        "用 MiniMax H3 視頻模型生成影片。可用 firstFrame / lastFrame 指定首尾幀。任務是異步的，本工具會在內部輪詢直到完成或 waitSeconds 用完；還沒完成時會回傳 taskId，之後用 minimax_video_status 取回。",
      parameters: {
        prompt: { type: "string", required: true, description: "影片描述（鏡頭、動作、光線、氣氛）。" },
        model: { type: "string", description: `模型：${VIDEO_MODELS.join(" / ")}，預設 ${VIDEO_MODELS[0]}。` },
        duration: { type: "integer", description: "時長（秒）4–15，預設 5。MiniMax-H3-Max 最小 5 秒。" },
        resolution: { type: "string", description: "480P / 768P / 2K。只有 MiniMax-H3 支援 2K。" },
        ratio: { type: "string", description: "adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16。文生視頻不能填 adaptive。" },
        firstFrame: { type: "string", description: "首幀圖：公開網址、mm_file://file_id，或本機路徑。" },
        lastFrame: { type: "string", description: "尾幀圖（僅 MiniMax-H3）。" },
        generateAudio: { type: "boolean", description: "是否產生同步音訊，預設 true（服務端預設）。" },
        waitSeconds: { type: "integer", description: "本次最多等待秒數，30–1500，預設 480。" },
        outputFile: { type: "string", description: "輸出 mp4 檔名。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            status: { type: "string" },
            finished: { type: "boolean" },
            file: { type: "object" },
            error: { type: "string" },
            message: { type: "string" },
          },
        },
        render: (_args, value) =>
          text(
            value.finished && value.file
              ? `影片已生成：${value.file.path}`
              : `taskId=${value.taskId} status=${value.status}\n${value.message ?? ""}${value.error ? `\n錯誤：${value.error}` : ""}`,
          ),
      },
      timeoutMs: 1_560_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await generateVideo(args, exec);
      },
    },
    {
      name: "minimax_video_status",
      description:
        "查詢 MiniMax 視頻生成任務的狀態；已完成時直接下載成 mp4。搭配 minimax_generate_video 回傳的 taskId 使用。",
      parameters: {
        taskId: { type: "string", required: true, description: "視頻任務 id。" },
        outputFile: { type: "string", description: "下載後的 mp4 檔名。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            status: { type: "string" },
            finished: { type: "boolean" },
            file: { type: "object" },
            error: { type: "string" },
          },
        },
        render: (_args, value) =>
          text(
            value.file
              ? `影片已下載：${value.file.path}`
              : `taskId=${value.taskId} status=${value.status ?? "unknown"}${value.error ? `\n錯誤：${value.error}` : ""}`,
          ),
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const active = await activeKey();
        const taskId = String(args.taskId ?? "");
        if (taskId.length === 0) throw new Error("缺少 taskId。");
        return await pollVideo(active, taskId, args, exec, 30);
      },
    },
    {
      name: "minimax_speak",
      description:
        "用 MiniMax 語音合成把文字轉成 mp3（speech-2.8 系列，支援 40 種語言與情緒標籤）。回傳落地檔案路徑。",
      parameters: {
        text: { type: "string", required: true, description: "要合成的文字（單次上限 10000 字）。" },
        voiceId: { type: "string", description: `音色 id，預設 ${DEFAULT_VOICE_ID}。先用 minimax_voices 看可用的。` },
        model: { type: "string", description: `模型：${SPEECH_MODELS.join(" / ")}，預設 ${SPEECH_MODELS[0]}。` },
        format: { type: "string", description: "mp3 / pcm / flac / wav，預設 mp3。" },
        speed: { type: "number", description: "語速 0.5–2，預設 1。" },
        volume: { type: "number", description: "音量 0–10，預設 1。" },
        pitch: { type: "integer", description: "語調 -12–12，預設 0。" },
        emotion: {
          type: "string",
          description: "情緒：happy / sad / angry / fearful / disgusted / surprised / calm / fluent / whisper。",
        },
        outputFile: { type: "string", description: "輸出檔名（不含副檔名）。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            file: { type: "object" },
            model: { type: "string" },
            voiceId: { type: "string" },
            durationMs: { type: "integer" },
            characters: { type: "integer" },
          },
        },
        render: (_args, value) =>
          text(
            `語音已合成：${value.file?.path ?? ""}（${value.durationMs ?? "?"} ms，${value.characters ?? "?"} 字）`,
          ),
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await speak(args, exec);
      },
    },
    {
      name: "minimax_voices",
      description: "查詢 MiniMax 帳號可用的音色（系統音色、複刻音色、文生音色），回傳 voice_id 與名稱。",
      parameters: {
        type: {
          type: "string",
          description: "要查哪一類：system（系統音色）/ voice_cloning（複刻）/ voice_generation（文生）/ all，預設 all。",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            systemVoices: { type: "array", items: { type: "object" } },
            clonedVoices: { type: "array", items: { type: "object" } },
            generatedVoices: { type: "array", items: { type: "object" } },
          },
        },
        render: (_args, value) =>
          text(
            (value.systemVoices ?? [])
              .map((voice) => `- ${voice.voiceId}${voice.name ? ` (${voice.name})` : ""}`)
              .join("\n") || "沒有可用的系統音色。",
          ),
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await voices(args, exec);
      },
    },
  ];
}
