/**
 * MiniMax 的第二組能力：語音識別、異步長文本語音、音色複刻／設計、檔案上傳、影片任務管理。
 *
 * 與 `media.js` 分開的理由：那一組是「輸入是文字、輸出是檔案」的生成型工具，
 * 這一組多了上傳、任務輪詢與帳號權限前置條件（音色複刻要先完成個人／企業認證），
 * 放一起會讓單一檔案超過千行。
 *
 * 端點與限制全部來自官方 OpenAPI（實測 2026-11-19）：
 *   - ASR          POST {apiRoot}/v1/speech_to_text            （multipart，asr-1.0）
 *   - 異步 TTS     POST {apiRoot}/v1/t2a_async_v2
 *   - 查詢 TTS     GET  {apiRoot}/v1/query/t2a_async_query_v2?task_id=
 *   - 檔案資訊     GET  {apiRoot}/v1/files/retrieve?file_id=
 *   - 檔案上傳     POST {apiRoot}/v1/files/upload              （multipart）
 *   - 音色複刻     POST {apiRoot}/v1/voice_clone
 *   - 音色設計     POST {apiRoot}/v1/voice_design
 *   - 影片任務列表 GET  {apiRoot}/v2/query/video_generation
 *   - 影片刪除     DELETE {apiRoot}/v2/video_generation/{task_id}
 *
 * ⚠️ 兩代端點的錯誤形狀不同：
 *   - 語音／檔案這批固定回 HTTP 200，失敗寫在 `base_resp.status_code`。
 *   - ASR 與影片 V2 用真實 HTTP 狀態碼，body 是 OpenAI 風格 `error`。
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { failureOf } from "./catalog.js";
import {
  callJson,
  createOutputPath,
  download,
  errorMessageOf,
  mimeOf,
  postMultipart,
  sanitizeFileName,
} from "./shared.js";

/** ASR 支援的音訊格式。 */
export const ASR_FORMATS = ["wav", "aiff", "flac", "alac(m4a)", "mp3", "aac", "opus", "ogg"];
/** 語音合成模型（同步與非同步共用）。 */
export const SPEECH_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
];
/** 檔案上傳的 `purpose` 合法值（官方 enum）。 */
export const UPLOAD_PURPOSES = [
  "voice_clone",
  "prompt_audio",
  "t2a_async_input",
  "video_understanding",
  "video_generation_input",
  "image_generation_input",
];
/** ASR 單次上限（官方：時長 500 秒、體積 50 MB）。 */
const ASR_MAX_SECONDS = 500;
const ASR_MAX_BYTES = 50 * 1024 * 1024;
/** 音色複刻音訊規格（官方：10 秒 ~ 5 分鐘、≤20 MB）。 */
const CLONE_MAX_BYTES = 20 * 1024 * 1024;
/** 異步 TTS 的輪詢間隔（官方限制：每秒最多 10 次查詢 → 用 5 秒，遠離上限）。 */
const ASYNC_POLL_INTERVAL_MS = 5_000;
/** 異步 TTS 下載 URL 的有效期（官方原文：9 小時）。 */
const ASYNC_DOWNLOAD_TTL_HOURS = 9;

/**
 * 建立第二組 MiniMax 工具。
 *
 * @param {object} deps - 依賴。
 * @param {() => Promise<{ region: string, key: string, apiRoot: string, anthropicBase: string } | undefined>} deps.resolveActiveKey - 取得當前生效的 Key 與區域端點。
 * @param {(agent: any) => Promise<string>} deps.resolveWorkingDirectory - 取得會話工作目錄。
 * @returns {Array<object>} ToolDefinition 陣列。
 */
export function createExtraTools({ resolveActiveKey, resolveWorkingDirectory }) {
  const outputPath = createOutputPath(resolveWorkingDirectory);

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
   * 上傳本機檔案到 MiniMax，拿回 file_id。
   *
   * @param {object} active - 生效的 Key 資訊。
   * @param {string} filePath - 本機路徑。
   * @param {string} purpose - 上傳用途（見 UPLOAD_PURPOSES）。
   * @param {AbortSignal} [signal] - 取消訊號。
   * @returns {Promise<{ fileId: number, filename: string, bytes: number, purpose: string }>} 上傳結果。
   */
  async function uploadFile(active, filePath, purpose, signal) {
    const bytes = await readFile(filePath);
    const { status, body } = await postMultipart({
      url: `${active.apiRoot}/v1/files/upload`,
      key: active.key,
      fields: [
        ["purpose", purpose],
        ["file", new Blob([bytes], { type: mimeOf(filePath) }), basename(filePath)],
      ],
      timeoutMs: 300_000,
      signal,
    });
    if (status !== 200 || body === undefined) {
      throw new Error(`MiniMax 檔案上傳失敗：${errorMessageOf(status, body)}`);
    }
    const failure = failureOf(body);
    if (failure !== undefined) throw new Error(`MiniMax 檔案上傳失敗：${failure.message}`);
    const file = body?.file;
    if (file === null || file === undefined || typeof file.file_id !== "number") {
      throw new Error("MiniMax 檔案上傳沒有回傳 file_id。");
    }
    return {
      fileId: file.file_id,
      filename: typeof file.filename === "string" ? file.filename : basename(filePath),
      bytes: typeof file.bytes === "number" ? file.bytes : bytes.byteLength,
      purpose: typeof file.purpose === "string" ? file.purpose : purpose,
    };
  }

  // ---------------------------------------------------------------- ASR

  /**
   * 語音識別（asr-1.0）。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function transcribe(args, exec) {
    const active = await activeKey();
    const filePath = String(args.file ?? "");
    if (filePath.length === 0) throw new Error("缺少音訊檔案路徑。");
    const bytes = await readFile(filePath);
    if (bytes.byteLength > ASR_MAX_BYTES) {
      throw new Error(
        `音訊有 ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB，超過 ${ASR_MAX_BYTES / 1024 / 1024} MB 上限。`,
      );
    }
    const responseFormat = ["json", "verbose_json", "srt", "vtt"].includes(args.responseFormat)
      ? args.responseFormat
      : "json";
    const timestampLevel = args.timestampLevel === "sentence" ? "sentence" : args.timestampLevel === "word" ? "word" : undefined;
    const fields = [
      ["model", "asr-1.0"],
      ["file", new Blob([bytes], { type: mimeOf(filePath) }), basename(filePath)],
      ["response_format", responseFormat],
    ];
    if (timestampLevel !== undefined) fields.push(["timestamp_level", timestampLevel]);
    const headers = {};
    if (typeof args.language === "string" && args.language.length > 0) headers.language = args.language;
    const { status, body } = await postMultipart({
      url: `${active.apiRoot}/v1/speech_to_text`,
      key: active.key,
      fields,
      headers,
      timeoutMs: 300_000,
      signal: exec.signal,
    });
    if (status !== 200) {
      throw new Error(`MiniMax 語音識別失敗：${errorMessageOf(status, body)}`);
    }
    // srt / vtt 回的是純文字字幕本體，沒有 JSON 包裝。
    if (responseFormat === "srt" || responseFormat === "vtt") {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      const target = await outputPath(exec.agent, args.outputFile, "minimax-transcript", responseFormat === "srt" ? ".srt" : ".vtt");
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
      return { format: responseFormat, file: { path: target }, text };
    }
    if (body === undefined || typeof body !== "object") {
      throw new Error("MiniMax 語音識別回應無法解析。");
    }
    const result = {
      text: typeof body.text === "string" ? body.text : "",
      duration: typeof body.duration === "number" ? body.duration : undefined,
      format: responseFormat,
      traceId: body.trace_id,
    };
    if (Array.isArray(body.segments)) {
      result.speakers = body.n_speakers;
      result.segments = body.segments;
    }
    if (typeof args.outputFile === "string" && args.outputFile.trim().length > 0) {
      const target = await outputPath(exec.agent, args.outputFile, "minimax-transcript", ".txt");
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, result.text, "utf8");
      result.file = { path: target };
    }
    return result;
  }

  // ---------------------------------------------------------------- 異步長文本 TTS

  /**
   * 異步長文本語音合成：建立任務 → 輪詢 → 取檔下載。
   *
   * 單次任務最多 10 萬字，zip 總計 100 萬字；下載 URL 9 小時後失效，所以本工具
   * **一定**會把音檔抓回本機。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function speakLong(args, exec) {
    const active = await activeKey();
    const model = SPEECH_MODELS.includes(args.model) ? args.model : SPEECH_MODELS[0];
    const voiceId = typeof args.voiceId === "string" && args.voiceId.length > 0 ? args.voiceId : "male-qn-qingse";
    const text = typeof args.text === "string" ? args.text : "";
    if (text.trim().length === 0 && typeof args.textFileId !== "number") {
      throw new Error("要合成的文字是空的（也沒給 textFileId）。");
    }
    if (text.length > 100_000) {
      throw new Error(`單次任務上限 100000 字，收到 ${text.length} 字。請分段或改用文字檔。`);
    }
    const body = {
      model,
      voice_setting: {
        voice_id: voiceId,
        speed: typeof args.speed === "number" ? args.speed : 1,
        vol: typeof args.volume === "number" ? args.volume : 1,
        pitch: typeof args.pitch === "number" ? args.pitch : 0,
        ...(typeof args.emotion === "string" && args.emotion.length > 0 ? { emotion: args.emotion } : {}),
      },
      audio_setting: {
        audio_sample_rate: 32000,
        bitrate: 128000,
        format: ["mp3", "pcm", "flac", "wav"].includes(args.format) ? args.format : "mp3",
        channel: 1,
      },
    };
    if (text.trim().length > 0) body.text = text;
    if (typeof args.textFileId === "number") body.text_file_id = args.textFileId;
    if (Array.isArray(args.pronunciation) && args.pronunciation.length > 0) {
      body.pronunciation_dict = { tone: args.pronunciation };
    }

    const created = await callJson({
      url: `${active.apiRoot}/v1/t2a_async_v2`,
      body,
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 120_000,
      signal: exec.signal,
    });
    if (created.status !== 200 || created.body === undefined) {
      throw new Error(`MiniMax 異步語音建立失敗：${errorMessageOf(created.status, created.body)}`);
    }
    const createFailure = failureOf(created.body);
    if (createFailure !== undefined) throw new Error(`MiniMax 異步語音建立失敗：${createFailure.message}`);
    const taskId = created.body?.task_id;
    if (taskId === undefined || taskId === null || String(taskId).length === 0) {
      throw new Error("MiniMax 異步語音沒有回傳 task_id。");
    }

    const waitSeconds = Math.min(Math.max(Number(args.waitSeconds ?? 1800) || 1800, 30), 3000);
    const deadline = Date.now() + waitSeconds * 1000;
    let status = "processing";
    let fileId;
    while (true) {
      const queried = await callJson({
        url: `${active.apiRoot}/v1/query/t2a_async_query_v2?task_id=${encodeURIComponent(taskId)}`,
        method: "GET",
        headers: { authorization: `Bearer ${active.key}` },
        timeoutMs: 60_000,
        signal: exec.signal,
      });
      if (queried.status !== 200 || queried.body === undefined) {
        throw new Error(`MiniMax 異步語音查詢失敗：${errorMessageOf(queried.status, queried.body)}`);
      }
      // 官方文件同一頁裡大小寫不一致（enum 是小寫、範例是 "Processing"）→ 比對時不看大小寫。
      status = String(queried.body?.status ?? "processing").toLowerCase();
      fileId = queried.body?.file_id;
      if (status === "success" || status === "failed" || status === "expired") break;
      if (Date.now() >= deadline) {
        return {
          taskId,
          status: queried.body?.status ?? status,
          finished: false,
          message: `語音還在合成中。稍後用 minimax_speak_status 帶 taskId=${taskId} 取回（下載 URL 只在 ${ASYNC_DOWNLOAD_TTL_HOURS} 小時內有效）。`,
        };
      }
      await new Promise((r) => setTimeout(r, ASYNC_POLL_INTERVAL_MS));
    }
    if (status !== "success") {
      return { taskId, status, finished: true, error: `任務 ${status}` };
    }
    if (fileId === undefined || fileId === null) {
      return { taskId, status, finished: true, message: "任務成功但沒有回傳 file_id。" };
    }

    // file_id → 下載 URL → 落地
    const info = await callJson({
      url: `${active.apiRoot}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
      method: "GET",
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 60_000,
      signal: exec.signal,
    });
    const downloadUrl = info.body?.file?.download_url;
    if (typeof downloadUrl !== "string" || downloadUrl.length === 0) {
      return { taskId, status, finished: true, fileId, message: "拿不到下載網址。" };
    }
    const ext = args.format === "flac" ? ".flac" : args.format === "wav" ? ".wav" : args.format === "pcm" ? ".pcm" : ".mp3";
    const target = await outputPath(exec.agent, args.outputFile, "minimax-speech-long", ext);
    const bytes = await download(downloadUrl, target, exec.signal);
    return {
      taskId,
      status,
      finished: true,
      fileId,
      file: { path: target, bytes },
      characters: created.body?.usage_characters,
      downloadUrlExpiresInHours: ASYNC_DOWNLOAD_TTL_HOURS,
    };
  }

  /**
   * 查詢異步語音任務狀態。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function speakStatus(args, exec) {
    const active = await activeKey();
    const taskId = String(args.taskId ?? "");
    if (taskId.length === 0) throw new Error("缺少 taskId。");
    const { status: httpStatus, body } = await callJson({
      url: `${active.apiRoot}/v1/query/t2a_async_query_v2?task_id=${encodeURIComponent(taskId)}`,
      method: "GET",
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 60_000,
      signal: exec.signal,
    });
    if (httpStatus !== 200 || body === undefined) {
      throw new Error(`MiniMax 異步語音查詢失敗：${errorMessageOf(httpStatus, body)}`);
    }
    const state = String(body?.status ?? "unknown");
    if (state.toLowerCase() !== "success" || body?.file_id === undefined) {
      return { taskId, status: state, fileId: body?.file_id };
    }
    const info = await callJson({
      url: `${active.apiRoot}/v1/files/retrieve?file_id=${encodeURIComponent(body.file_id)}`,
      method: "GET",
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 60_000,
      signal: exec.signal,
    });
    const downloadUrl = info.body?.file?.download_url;
    if (typeof downloadUrl !== "string" || downloadUrl.length === 0) {
      return { taskId, status: state, fileId: body.file_id, message: "拿不到下載網址。" };
    }
    const target = await outputPath(exec.agent, args.outputFile, "minimax-speech-long", ".mp3");
    const bytes = await download(downloadUrl, target, exec.signal);
    return { taskId, status: state, fileId: body.file_id, file: { path: target, bytes } };
  }

  // ---------------------------------------------------------------- 音色複刻 / 設計

  /**
   * 音色複刻：上傳音訊 → 複刻。
   *
   * 官方前置條件：需先完成個人或企業認證（否則回 2038）；複刻出的音色 7 天內
   * 沒被正式使用會被刪除。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function cloneVoice(args, exec) {
    const active = await activeKey();
    const voiceId = String(args.voiceId ?? "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(voiceId)) {
      throw new Error(
        "voiceId 必須是 8~256 字元、首字元為英文字母、只含英數字與 - _，且末位不能是 - 或 _。",
      );
    }
    const audioPath = String(args.audioFile ?? "");
    if (audioPath.length === 0) throw new Error("缺少要複刻的音訊路徑（audioFile）。");
    const bytes = await readFile(audioPath);
    if (bytes.byteLength > CLONE_MAX_BYTES) {
      throw new Error(`音訊有 ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB，超過 20 MB 上限。`);
    }
    const uploaded = await uploadFile(active, audioPath, "voice_clone", exec.signal);
    const body = { file_id: uploaded.fileId, voice_id: voiceId };
    if (typeof args.previewText === "string" && args.previewText.length > 0) {
      body.text = args.previewText.slice(0, 1000);
      body.model = SPEECH_MODELS.includes(args.model) ? args.model : SPEECH_MODELS[0];
    }
    if (typeof args.promptAudioFile === "string" && args.promptAudioFile.length > 0) {
      const prompt = await uploadFile(active, args.promptAudioFile, "prompt_audio", exec.signal);
      body.clone_prompt = { prompt_audio: prompt.fileId };
      if (typeof args.promptText === "string" && args.promptText.length > 0) {
        body.clone_prompt.prompt_text = args.promptText;
      }
    }
    if (typeof args.textValidation === "string" && args.textValidation.length > 0) {
      body.text_validation = args.textValidation.slice(0, 200);
    }
    if (typeof args.accuracy === "number") body.accuracy = args.accuracy;
    const { status, body: response } = await callJson({
      url: `${active.apiRoot}/v1/voice_clone`,
      body,
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 180_000,
      signal: exec.signal,
    });
    if (status !== 200 || response === undefined) {
      throw new Error(`MiniMax 音色複刻失敗：${errorMessageOf(status, response)}`);
    }
    const failure = failureOf(response);
    if (failure !== undefined) throw new Error(`MiniMax 音色複刻失敗：${failure.message}`);
    let demo;
    if (typeof response?.demo_audio === "string" && response.demo_audio.length > 0) {
      const target = await outputPath(exec.agent, args.outputFile, "minimax-voice-demo", ".mp3");
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(response.demo_audio, "hex"));
      demo = { path: target };
    }
    return {
      voiceId,
      fileId: uploaded.fileId,
      demo,
      sensitive: response?.input_sensitive,
      sensitiveType: response?.input_sensitive_type,
      usageCharacters: response?.extra_info?.usage_characters,
    };
  }

  /**
   * 音色設計：用文字描述生成音色。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function designVoice(args, exec) {
    const active = await activeKey();
    const prompt = String(args.prompt ?? "");
    if (prompt.trim().length === 0) throw new Error("缺少音色描述（prompt）。");
    const previewText = String(args.previewText ?? "");
    if (previewText.trim().length === 0) throw new Error("缺少試聽文字（previewText）。");
    const body = { prompt, preview_text: previewText.slice(0, 500) };
    if (typeof args.voiceId === "string" && args.voiceId.length > 0) body.voice_id = args.voiceId;
    const { status, body: response } = await callJson({
      url: `${active.apiRoot}/v1/voice_design`,
      body,
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 180_000,
      signal: exec.signal,
    });
    if (status !== 200 || response === undefined) {
      throw new Error(`MiniMax 音色設計失敗：${errorMessageOf(status, response)}`);
    }
    const failure = failureOf(response);
    if (failure !== undefined) throw new Error(`MiniMax 音色設計失敗：${failure.message}`);
    let trial;
    if (typeof response?.trial_audio === "string" && response.trial_audio.length > 0) {
      const target = await outputPath(exec.agent, args.outputFile, "minimax-voice-trial", ".mp3");
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(response.trial_audio, "hex"));
      trial = { path: target };
    }
    return { voiceId: response?.voice_id, trial };
  }

  // ---------------------------------------------------------------- 檔案上傳

  /**
   * 上傳檔案到 MiniMax，換成 `mm_file://{file_id}` 引用。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function upload(args, exec) {
    const active = await activeKey();
    const filePath = String(args.file ?? "");
    if (filePath.length === 0) throw new Error("缺少檔案路徑。");
    const purpose = UPLOAD_PURPOSES.includes(args.purpose) ? args.purpose : "image_generation_input";
    const uploaded = await uploadFile(active, filePath, purpose, exec.signal);
    return {
      ...uploaded,
      reference: `mm_file://${uploaded.fileId}`,
      expiresInDays: 7,
    };
  }

  // ---------------------------------------------------------------- 影片任務管理

  /**
   * 列出影片生成任務（最近 7 天）。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function videoTasks(args, exec) {
    const active = await activeKey();
    const query = new URLSearchParams();
    query.set("page_num", String(Math.max(Number(args.pageNum ?? 1) || 1, 1)));
    query.set("page_size", String(Math.min(Math.max(Number(args.pageSize ?? 20) || 20, 1), 100)));
    if (typeof args.status === "string" && args.status.length > 0) query.set("filter.status", args.status);
    if (typeof args.model === "string" && args.model.length > 0) query.set("filter.model", args.model);
    if (typeof args.taskType === "string" && args.taskType.length > 0) query.set("filter.task_type", args.taskType);
    const { status, body } = await callJson({
      url: `${active.apiRoot}/v2/query/video_generation?${query.toString()}`,
      method: "GET",
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 60_000,
      signal: exec.signal,
    });
    if (status !== 200 || body === undefined) {
      throw new Error(`MiniMax 影片任務列表失敗：${errorMessageOf(status, body)}`);
    }
    const items = Array.isArray(body?.items) ? body.items : [];
    return {
      total: typeof body?.total === "number" ? body.total : items.length,
      tasks: items.map((task) => ({
        taskId: task?.id,
        model: task?.model,
        status: task?.status,
        taskType: task?.task_type,
        resolution: task?.resolution,
        duration: task?.duration,
        ratio: task?.ratio,
        createdAt: task?.created_at,
        updatedAt: task?.updated_at,
        error: task?.error?.message,
        url: task?.content?.url,
      })),
    };
  }

  /**
   * 取消排隊中的影片任務，或刪除已結束的任務記錄。
   *
   * 官方限制：`running` 與 `cancelled` 狀態不可操作。
   *
   * @param {object} args - 工具參數。
   * @param {any} exec - 執行上下文。
   * @returns {Promise<object>} 工具輸出。
   */
  async function videoCancel(args, exec) {
    const active = await activeKey();
    const taskId = String(args.taskId ?? "");
    if (taskId.length === 0) throw new Error("缺少 taskId。");
    const { status, body } = await callJson({
      url: `${active.apiRoot}/v2/video_generation/${encodeURIComponent(taskId)}`,
      method: "DELETE",
      headers: { authorization: `Bearer ${active.key}` },
      timeoutMs: 60_000,
      signal: exec.signal,
    });
    if (status !== 200 || body === undefined) {
      throw new Error(`MiniMax 影片任務操作失敗：${errorMessageOf(status, body)}`);
    }
    return {
      taskId: body?.task_id ?? taskId,
      action: body?.action,
      status: body?.status,
    };
  }

  const text = (value) => [{ type: "text", text: value }];
  const when = async () => {
    try {
      return (await resolveActiveKey()) !== undefined;
    } catch {
      return false;
    }
  };

  return [
    {
      name: "minimax_transcribe",
      description:
        "用 MiniMax asr-1.0 把音訊轉成文字（語音識別）。支援 mp3/wav/m4a/flac/opus 等，單段最長 500 秒、50 MB。可輸出逐字稿、帶說話人標記的分段，或直接存成 srt/vtt 字幕檔。",
      parameters: {
        file: { type: "string", required: true, description: "本機音訊檔路徑。" },
        responseFormat: {
          type: "string",
          description: "json（純文字）/ verbose_json（含說話人與分段）/ srt / vtt（字幕檔），預設 json。",
        },
        timestampLevel: {
          type: "string",
          description: "''（不要時間戳）/ sentence（句段）/ word（中文按字、英文按詞）。只在 verbose_json 下有效。",
        },
        language: { type: "string", description: "語言提示，如 zh、yue、en、ja；不填＝混合語言。" },
        outputFile: { type: "string", description: "輸出檔名（srt/vtt 會存成字幕檔，json 可另存逐字稿）。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            text: { type: "string" },
            duration: { type: "number" },
            speakers: { type: "integer" },
            segments: { type: "array" },
            file: { type: "object" },
          },
        },
        render: (_args, value) =>
          text(
            value.file?.path
              ? `已轉寫（${value.duration ?? "?"} 秒）：${value.file.path}\n\n${value.text ?? ""}`
              : `已轉寫（${value.duration ?? "?"} 秒）：\n\n${value.text ?? ""}`,
          ),
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await transcribe(args, exec);
      },
    },
    {
      name: "minimax_speak_long",
      description:
        "用 MiniMax 語音模型把長文字合成成音檔（單次任務最多 10 萬字，總量可到 100 萬字）。本工具會建立任務、等待完成、再把音檔抓回本機（官方下載網址 9 小時後失效）。",
      parameters: {
        text: { type: "string", description: "要合成的文字（最多 100000 字）。" },
        textFileId: {
          type: "number",
          description: "已上傳的文字檔 file_id（用 minimax_upload_file 傳 purpose=t2a_async_input）。",
        },
        voiceId: { type: "string", description: "音色 id，預設 male-qn-qingse。" },
        model: { type: "string", description: `模型：${SPEECH_MODELS.join(" / ")}，預設 ${SPEECH_MODELS[0]}。` },
        format: { type: "string", description: "mp3 / pcm / flac / wav，預設 mp3。" },
        speed: { type: "number", description: "語速 0.5–2，預設 1。" },
        volume: { type: "number", description: "音量 0–10，預設 1。" },
        pitch: { type: "integer", description: "語調 -12–12，預設 0。" },
        emotion: { type: "string", description: "情緒：happy / sad / angry / fearful / disgusted / surprised / calm / fluent / whisper。" },
        pronunciation: {
          type: "array",
          items: { type: "string" },
          description: "自訂發音規則，例如「危险/dangerous」。",
        },
        waitSeconds: { type: "integer", description: "本次最多等待秒數，30–3000，預設 1800。" },
        outputFile: { type: "string", description: "輸出音檔名。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            status: { type: "string" },
            finished: { type: "boolean" },
            file: { type: "object" },
            characters: { type: "integer" },
            message: { type: "string" },
          },
        },
        render: (_args, value) =>
          text(
            value.file
              ? `語音已合成：${value.file.path}`
              : `taskId=${value.taskId} status=${value.status}\n${value.message ?? ""}`,
          ),
      },
      timeoutMs: 3_060_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await speakLong(args, exec);
      },
    },
    {
      name: "minimax_speak_status",
      description:
        "查詢 MiniMax 異步語音合成任務；已完成時把音檔抓回本機。搭配 minimax_speak_long 回傳的 taskId 使用。",
      parameters: {
        taskId: { type: "string", required: true, description: "異步語音任務 id。" },
        outputFile: { type: "string", description: "輸出音檔名。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            status: { type: "string" },
            fileId: { type: "integer" },
            file: { type: "object" },
          },
        },
        render: (_args, value) =>
          text(value.file ? `語音已下載：${value.file.path}` : `taskId=${value.taskId} status=${value.status}`),
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await speakStatus(args, exec);
      },
    },
    {
      name: "minimax_clone_voice",
      description:
        "用你自己的音訊複刻出一個 MiniMax 音色，之後就能用它做語音合成。音訊需 10 秒以上、5 分鐘以內、20 MB 以內。**帳號需先完成個人或企業認證**，複刻出的音色 7 天內沒被使用會被刪除。",
      parameters: {
        audioFile: { type: "string", required: true, description: "要複刻的本機音訊路徑（mp3/m4a/wav）。" },
        voiceId: {
          type: "string",
          required: true,
          description: "自訂音色 id：8–256 字元，首字元為英文字母，只含英數字與 - _，末位不能是 - 或 _。",
        },
        promptAudioFile: { type: "string", description: "選用的示例音訊（<8 秒），可提升相似度與穩定性。" },
        promptText: { type: "string", description: "示例音訊的逐字內容（需與音訊一致，句末加標點）。" },
        previewText: { type: "string", description: "試聽文字（≤1000 字）；會照語音合成計費。" },
        model: { type: "string", description: "試聽用的語音模型。" },
        textValidation: { type: "string", description: "≤200 字的比對文字；服務端會做 ASR 相似度檢查，太低會拒絕。" },
        accuracy: { type: "number", description: "相似度門檻 0–1，預設 0.7。" },
        outputFile: { type: "string", description: "試聽音檔名。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            voiceId: { type: "string" },
            fileId: { type: "integer" },
            demo: { type: "object" },
            sensitive: { type: "boolean" },
          },
        },
        render: (_args, value) =>
          text(`音色 ${value.voiceId} 已建立${value.demo?.path ? `，試聽：${value.demo.path}` : ""}`),
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await cloneVoice(args, exec);
      },
    },
    {
      name: "minimax_design_voice",
      description:
        "用文字描述設計一個新的 MiniMax 音色（例如「低沉有磁性的懸疑故事旁白」），回傳可立即用於語音合成的 voice_id 與試聽音檔。",
      parameters: {
        prompt: { type: "string", required: true, description: "音色描述。" },
        previewText: { type: "string", required: true, description: "試聽文字（≤500 字）。" },
        voiceId: { type: "string", description: "自訂 voice_id；不填由 MiniMax 自動生成。" },
        outputFile: { type: "string", description: "試聽音檔名。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            voiceId: { type: "string" },
            trial: { type: "object" },
          },
        },
        render: (_args, value) =>
          text(`音色 ${value.voiceId} 已設計${value.trial?.path ? `，試聽：${value.trial.path}` : ""}`),
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await designVoice(args, exec);
      },
    },
    {
      name: "minimax_upload_file",
      description:
        "把本機檔案上傳到 MiniMax，換成 mm_file://file_id 引用。參考圖超過 20 MB、影片參考、需要重複使用的素材時用這個（檔案保存 7 天）。",
      parameters: {
        file: { type: "string", required: true, description: "本機檔案路徑。" },
        purpose: {
          type: "string",
          description: `用途：${UPLOAD_PURPOSES.join(" / ")}。做圖片編輯的參考圖用 image_generation_input。`,
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            fileId: { type: "integer" },
            reference: { type: "string" },
            filename: { type: "string" },
            bytes: { type: "integer" },
          },
        },
        render: (_args, value) => text(`已上傳：${value.reference}（${value.filename}，${value.bytes} bytes，7 天後過期）`),
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await upload(args, exec);
      },
    },
    {
      name: "minimax_video_tasks",
      description:
        "列出最近的 MiniMax 影片生成任務（最近 7 天），可依狀態、模型、任務類型篩選。適合批次管理生成結果。",
      parameters: {
        pageNum: { type: "integer", description: "頁碼，從 1 開始，預設 1。" },
        pageSize: { type: "integer", description: "每頁數量，預設 20。" },
        status: {
          type: "string",
          description: "篩選狀態：queued / running / succeeded / failed / cancelled。",
        },
        model: { type: "string", description: "篩選模型，例如 MiniMax-H3。" },
        taskType: { type: "string", description: "篩選任務類型：generation / h3_context_ir / regeneration。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            total: { type: "integer" },
            tasks: { type: "array", items: { type: "object" } },
          },
        },
        render: (_args, value) =>
          text(
            (value.tasks ?? [])
              .map(
                (task) =>
                  `- ${task.taskId} ${task.status} ${task.model ?? ""} ${task.resolution ?? ""}${task.duration ? `${task.duration}s` : ""}${task.error ? ` 錯誤：${task.error}` : ""}`,
              )
              .join("\n") || "沒有任務。",
          ),
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await videoTasks(args, exec);
      },
    },
    {
      name: "minimax_video_cancel",
      description:
        "取消排隊中的 MiniMax 影片任務（不扣費），或刪除已結束的任務記錄。執行中的任務不可操作。",
      parameters: {
        taskId: { type: "string", required: true, description: "影片任務 id。" },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            action: { type: "string" },
            status: { type: "string" },
          },
        },
        render: (_args, value) => text(`taskId=${value.taskId} action=${value.action} status=${value.status}`),
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await videoCancel(args, exec);
      },
    },
  ];
}
