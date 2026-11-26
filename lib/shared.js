/**
 * MiniMax 工具集共用的底層：HTTP 呼叫、錯誤轉譯、輸出路徑、檔案下載。
 *
 * 抽出來的原因：`media.js` 與 `extra.js` 兩組工具都要用同一套規則，
 * 而且這些規則各自踩過坑（檔名拼成 undefined、錯誤碼沒翻譯、逾時沒設），
 * 放一份比複製兩份安全。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { failureOf } from "./catalog.js";

/** Windows 保留裝置名（檔名去掉副檔名後不可為這些）。 */
const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * 把任意名稱整理成安全的檔名（去掉路徑成分與 Windows 非法字元）。
 *
 * @param {string} raw - 使用者指定的檔名。
 * @param {string} fallback - 沒有名字時的預設名。
 * @returns {string} 乾淨的檔名（不含副檔名）。
 */
export function sanitizeFileName(raw, fallback) {
  let name = typeof raw === "string" ? raw : "";
  // 先砍掉任何路徑成分，只留最後一段。
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim().replace(/[. ]+$/, "");
  if (name.length === 0) name = fallback;
  if (RESERVED_NAMES.has(name.toUpperCase())) name = `_${name}`;
  return name.slice(0, 120);
}

/**
 * 確保輸出路徑不存在衝突：已存在就加 -2、-3 …
 *
 * @param {string} dir - 目標資料夾。
 * @param {string} base - 不含副檔名的檔名。
 * @param {string} ext - 副檔名（含點）。
 * @returns {Promise<string>} 可寫入的完整路徑。
 */
async function uniquePath(dir, base, ext) {
  for (let index = 1; index < 200; index += 1) {
    const candidate = join(dir, `${base}${index === 1 ? "" : `-${index}`}${ext}`);
    try {
      await readFile(candidate);
    } catch {
      return candidate;
    }
  }
  return join(dir, `${base}-${Date.now()}${ext}`);
}

/**
 * 建立一個輸出路徑解析器。
 *
 * 使用者指定的相對路徑以工作目錄為根，絕對路徑照用；沒指定就落在工作目錄，
 * 檔名衝突時自動加序號。
 *
 * @param {(agent: any) => Promise<string>} resolveWorkingDirectory - 取得會話工作目錄。
 * @returns {(agent: any, requested: string | undefined, fallbackBase: string, ext: string) => Promise<string>} 路徑解析器。
 */
export function createOutputPath(resolveWorkingDirectory) {
  return async function outputPath(agent, requested, fallbackBase, ext) {
    let dir;
    try {
      dir = await resolveWorkingDirectory(agent);
    } catch {
      dir = process.cwd();
    }
    if (typeof requested === "string" && requested.trim().length > 0) {
      const raw = requested.trim();
      const absolute = isAbsolute(raw) ? raw : resolve(dir, raw);
      const base = sanitizeFileName(raw, fallbackBase);
      const target = join(dirname(absolute), base + ext);
      await mkdir(dirname(target), { recursive: true });
      return target;
    }
    await mkdir(dir, { recursive: true });
    return uniquePath(dir, sanitizeFileName(fallbackBase, fallbackBase), ext);
  };
}

/**
 * 發一次 JSON 請求並解析回應。
 *
 * @param {object} options - 請求選項。
 * @param {string} options.url - 完整 URL。
 * @param {string} [options.method] - HTTP method。
 * @param {object} [options.body] - JSON body。
 * @param {object} [options.headers] - 額外 header。
 * @param {number} [options.timeoutMs] - 逾時（毫秒）。
 * @param {AbortSignal} [options.signal] - 外部取消訊號。
 * @returns {Promise<{ status: number, body: any }>} 狀態碼與解析後的 body。
 */
export async function callJson({ url, method = "POST", body, headers = {}, timeoutMs = 60_000, signal }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: composite,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

/**
 * 把 MiniMax 的錯誤回應轉成人能讀的訊息。
 *
 * MiniMax 兩代端點的錯誤形狀不同：
 *   - 舊世代（語音、檔案）固定回 HTTP 200，錯誤在 `base_resp.status_code`。
 *   - 新世代（ASR、影片 V2）用真實 HTTP 狀態碼，body 是 OpenAI 風格 `error`。
 * 兩種都要認得。
 *
 * @param {number} status - HTTP 狀態碼。
 * @param {any} body - 回應 body。
 * @returns {string} 錯誤訊息。
 */
export function errorMessageOf(status, body) {
  const failure = failureOf(body);
  if (failure !== undefined) {
    const code = failure.code !== undefined && failure.code >= 0 ? `（${failure.code}）` : "";
    return `${failure.message}${code}`;
  }
  const detail = body?.error?.message ?? body?.base_resp?.status_msg;
  if (typeof detail === "string" && detail.length > 0) return detail;
  return `HTTP ${status}`;
}

/**
 * 下載遠端檔案到本機路徑。
 *
 * @param {string} url - 下載網址。
 * @param {string} target - 落地路徑。
 * @param {AbortSignal} [signal] - 取消訊號。
 * @returns {Promise<number>} 寫入位元組數。
 */
export async function download(url, target, signal) {
  const response = await fetch(url, {
    signal: signal === undefined ? AbortSignal.timeout(300_000) : signal,
  });
  if (!response.ok) throw new Error(`下載失敗 HTTP ${response.status}：${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return bytes.byteLength;
}

/**
 * 副檔名 → MIME（判斷上傳時要用的 content type）。
 *
 * @param {string} filePath - 檔案路徑。
 * @returns {string} MIME 類型。
 */
export function mimeOf(filePath) {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".gif":
      return "image/gif";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    case ".aac":
      return "audio/aac";
    case ".opus":
      return "audio/opus";
    case ".ogg":
      return "audio/ogg";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".avi":
      return "video/x-msvideo";
    case ".mkv":
      return "video/x-matroska";
    case ".txt":
      return "text/plain";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

/**
 * 建立 multipart 表單並送出。
 *
 * `content-type` **不能**手動設定 —— 瀏覽器／fetch 必須自己加上 boundary，
 * 手動設定會讓伺服器解析不出表單。
 *
 * ⚠️ 表單欄位必須寫成 `[name, value, filename]`：Blob 少了檔名參數時，
 * `FormData.append` 會用預設名 "blob"，MiniMax 的副檔名檢查就會拒收
 * （實測：上傳 mp3 給 voice_clone 回「invalid file ext for voice clone」）。
 *
 * @param {string} url - 端點。
 * @param {string} key - API Key。
 * @param {Array<[string, string | Blob, string?]>} fields - 表單欄位。
 * @param {object} [headers] - 額外 header。
 * @param {number} [timeoutMs] - 逾時。
 * @param {AbortSignal} [signal] - 取消訊號。
 * @returns {Promise<{ status: number, body: any }>} 回應。
 */
export async function postMultipart({ url, key, fields, headers = {}, timeoutMs = 300_000, signal }) {
  const form = new FormData();
  for (const [name, value, filename] of fields) {
    if (filename === undefined) form.append(name, value);
    else form.append(name, value, filename);
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, ...headers },
    body: form,
    signal: composite,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}
