/**
 * 「Key 名册」——多把 API Key 的纯数据层。
 *
 * 名册是一份 JSON，存进凭据库（凭据库就是放秘密的地方，原始 Key 只该待在这里）。
 * 它记录用户保存的**多把** Key、每把的备注名、以及哪一把是当前生效的。
 *
 * 真正给模型路由用的仍然是各区域的「规范凭据引用」（`MINIMAX_CN_API_KEY` /
 * `MINIMAX_API_KEY`）：名册里的 activeId 指向的那一把，会被写进它所属区域的规范引用，
 * 所以「切换」= 改写那个引用。名册本身不参与路由。
 *
 * 这一层只放纯函数：不碰宿主、不联网，因此单测不需要宿主。
 */

import { keyHintOf, keyKindOf } from "./catalog.js";

/** 名册在凭据库里的引用名。 */
export const REGISTRY_REF = "MINIMAX_KEY_RING";

/** 备注名的最大长度（超出截断，太长在设置页里也没法看）。 */
export const MAX_NAME_LENGTH = 40;

/** 空的名册。 */
export function emptyRegistry() {
  return { version: 1, entries: [], activeId: null };
}

/**
 * 生成名册条目 id。时间戳保证大致递增，随机后缀避免同一毫秒内撞车。
 */
export function newEntryId() {
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 规整用户填的备注名：去首尾空白、去掉控制字符、截断到上限。
 * 返回 undefined 表示「没填」，由调用方生成默认名。
 */
export function normalizeName(raw) {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH) : cleaned;
}

/** 默认备注名：MiniMax Key 1 / 2 / …（序号按该区域已有条目数递增）。 */
export function defaultName(index) {
  return `MiniMax Key ${index + 1}`;
}

/**
 * 解析名册 JSON。
 *
 * 坏数据不能把整份名册弄丢，也不能让一条坏记录污染整份：逐条丢弃非法条目，
 * 只保留 id / name / region / key 都是合法字符串的条目（region 必须是已知区域）。
 *
 * @returns {{ registry: {version:number, entries:object[], activeId:string|null}, invalid: boolean }}
 */
export function parseRegistry(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { registry: emptyRegistry(), invalid: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { registry: emptyRegistry(), invalid: true };
  }
  if (parsed === null || typeof parsed !== "object") return { registry: emptyRegistry(), invalid: true };
  const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const entries = [];
  for (const entry of rawEntries) {
    if (entry === null || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
    const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined;
    const region = entry.region === "cn" || entry.region === "intl" ? entry.region : undefined;
    const key = typeof entry.key === "string" && entry.key.length > 0 ? entry.key : undefined;
    if (id === undefined || name === undefined || region === undefined || key === undefined) continue;
    entries.push({
      id,
      name,
      region,
      key,
      kind: typeof entry.kind === "string" ? entry.kind : keyKindOf(key),
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
    });
  }
  const activeId =
    typeof parsed.activeId === "string" && entries.some((entry) => entry.id === parsed.activeId)
      ? parsed.activeId
      : null;
  return { registry: { version: 1, entries, activeId }, invalid: false };
}

/** 序列化名册（单行 JSON，凭据库里不需要缩进）。 */
export function stringifyRegistry(registry) {
  return JSON.stringify({
    version: 1,
    entries: registry.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      region: entry.region,
      key: entry.key,
      kind: entry.kind,
      createdAt: entry.createdAt,
    })),
    activeId: registry.activeId ?? null,
  });
}

/** 名册里当前生效的条目（没有则 undefined）。 */
export function activeEntryOf(registry) {
  if (registry.activeId === null || registry.activeId === undefined) return undefined;
  return registry.entries.find((entry) => entry.id === registry.activeId);
}

/** 名册里某个区域的条目数量（用来生成不重名的默认备注名）。 */
export function countEntriesOf(registry, region) {
  return registry.entries.filter((entry) => entry.region === region).length;
}

/** 把名册条目投影成给浏览器看的形状（不含原始 Key）。 */
export function projectEntry(entry, activeId) {
  return {
    id: entry.id,
    name: entry.name,
    region: entry.region,
    kind: entry.kind,
    hint: keyHintOf(entry.key),
    createdAt: entry.createdAt,
    active: entry.id === activeId,
  };
}
