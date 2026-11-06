/**
 * dsh-llm-minimax —— 宿主半边。
 *
 * 为什么不是一个 adapter：`@deepseek-ai/dsh-llm-pi-ai` 已内置 `minimax-cn`（国内）与
 * `minimax`（国际）两条目录路由，协议（Anthropic Messages）与端点都由 pi-ai 给出。
 * 腾讯内网那个参考插件必须自写 `LlmAdapter`，是因为腾讯内网在 pi-ai 目录里没有条目；
 * MiniMax 有。所以这里只做 pi-ai 不负责的三件事：
 *
 *   1. **Key 直接在设置页填**：浏览器把 Key 交给本插件，本插件先打 `GET /v1/models`
 *      校验（并自动识别国内 / 国际），通过后写进凭据库（`MINIMAX_CN_API_KEY` /
 *      `MINIMAX_API_KEY`，与内置「设置 → 模型」页用的是同一个引用），再把路由写进
 *      `llm-pi-ai.providers`。Key 只在宿主进程里流转，浏览器拿回的只有末 4 位。
 *   2. **补模型目录**：内置目录停在 MiniMax-M3，仍列着已退役的 M2.7 家族，缺当前主力
 *      MiniMax-M3.1-Flash。这里把目录写进 `providers[<route>].models`（pi-ai 语义是整份
 *      替换，所以用户自己加的其它模型原样保留在后面），并打开 `forceAdaptiveThinking`，
 *      让选择器里的思考档位真正到达服务端。
 *   3. **读额度**：`GET /v1/token_plan/remains` 只对 M Plan / Token Plan 生效；按量付费 Key
 *      没有公开余额接口，如实报告「去控制台看」，绝不编造数字。
 *
 * 写设置时只动 `providers[<route>]` 的 `apiKeyEnv` / `models` 两个字段，从不覆盖用户在
 * 那条路由上配的 `baseURL` / `retryPolicy` / `headers` 等其它字段。
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  CONTEXT_OPTIONS,
  DEFAULT_CONTEXT_WINDOW,
  MODELS,
  REGIONS,
  RETIRED_MODELS,
  ROUTES,
  catalogUpToDate,
  estimatePace,
  failureOf,
  keyHintOf,
  keyKindOf,
  mergeModels,
  normalizeContextWindow,
  normalizeKey,
  projectBucket,
} from "./catalog.js";
import {
  REGISTRY_REF,
  activeEntryOf,
  countEntriesOf,
  defaultName,
  emptyRegistry,
  newEntryId,
  normalizeName,
  parseRegistry,
  projectEntry,
  stringifyRegistry,
} from "./registry.js";

export const name = "llm-minimax";

/** 本插件独占的 RPC 频道（浏览器半边同名常量）。 */
export const CHANNEL = "/llm-minimax";

/** pi-ai 那一行在设置服务里的命名空间就是它的条目 id。 */
const PI_AI_NS_CANDIDATES = ["include:llm-pi-ai", "llm-pi-ai"];

/** 额度窗口按小时变化，一分钟足够新鲜；失败后更快重试。 */
const QUOTA_TTL_MS = 60_000;
const QUOTA_ERROR_TTL_MS = 20_000;
/** 单次对 MiniMax 的请求上限，避免面板跟着一个卡住的请求一起等。 */
const REQUEST_TIMEOUT_MS = 15_000;
/** 自动对齐的防自激窗口。 */
const REWRITE_GUARD_MS = 10_000;

export function apply(ctx) {
  const logger = ctx.logger;
  /** region -> { at, value } */
  const quotaCache = new Map();
  /** region -> Promise：同一区域的并发额度读取合并成一次。 */
  const quotaPending = new Map();
  /** region -> 上次由本插件写入 llm-pi-ai 的时间。 */
  const lastWrite = new Map();

  // ---------- 服务取用（都是可选的，缺了就降级，不抛） ----------

  const service = (key) => {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  };

  // ---------- llm-pi-ai 设置 ----------

  function piAiDescriptor() {
    const settings = service("settings");
    if (settings === undefined) return undefined;
    let descriptors;
    try {
      descriptors = settings.describe({ redactSecrets: true });
    } catch (error) {
      logger.warn("MiniMax：读取设置目录失败");
      logger.warn(error);
      return undefined;
    }
    for (const candidate of PI_AI_NS_CANDIDATES) {
      const hit = descriptors.find((d) => String(d.ns) === candidate);
      if (hit !== undefined) return hit;
    }
    return descriptors.find((d) => /(^|:)llm-pi-ai$/.test(String(d.ns)));
  }

  function routeProfile(region) {
    const descriptor = piAiDescriptor();
    const providers = descriptor?.value?.providers;
    const profile = providers !== null && typeof providers === "object" ? providers[ROUTES[region].provider] : undefined;
    return { descriptor, profile: profile !== null && typeof profile === "object" ? profile : undefined };
  }

  /** 路由实际使用的凭据引用：用户在路由上写了 apiKeyEnv 就用它，否则用约定名。 */
  function credentialRefOf(region, profile) {
    const configured = profile?.apiKeyEnv;
    return typeof configured === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(configured)
      ? configured
      : ROUTES[region].env;
  }

  /**
   * 把路由与目录写进 llm-pi-ai。只在确有差异时写：每次写都会让 pi-ai 重建注册快照。
   * @param contextWindow - 生效的上下文预算；省略时沿用已存目录里的值。
   * @returns {{ ok: boolean, changed?: boolean, reason?: string, models?: string[] }}
   */
  async function ensureRoute(region, options) {
    const { create, contextWindow } = options;
    const settings = service("settings");
    if (settings === undefined) return { ok: false, reason: "设置服务不可用" };
    const { descriptor, profile } = routeProfile(region);
    if (descriptor === undefined) return { ok: false, reason: "找不到 llm-pi-ai 的设置命名空间" };
    if (profile === undefined && !create) return { ok: false, reason: "route-not-configured" };

    const ops = [];
    const provider = ROUTES[region].provider;
    if (profile?.apiKeyEnv === undefined) {
      ops.push({ op: "set", path: ["providers", provider, "apiKeyEnv"], value: ROUTES[region].env });
    }
    if (!catalogUpToDate(profile?.models, contextWindow)) {
      ops.push({ op: "set", path: ["providers", provider, "models"], value: mergeModels(profile?.models, contextWindow) });
    }
    const models = MODELS.map((m) => m.id);
    if (ops.length === 0) return { ok: true, changed: false, models };
    // 防自激：本插件的写入会触发 settings 变更事件 → 再次自动对齐。正常情况下第二次对齐
    // 判定「已是最新」而不再写；万一读回的形状与预期不一致，这个时间窗阻止它反复写。
    //
    // 但**用户主动的操作不受此限**：调 setContext 或刚保存 Key 时，哪怕上一毫秒刚自动对齐过，
    // 也必须照办 —— 否则点了按钮什么都不发生（曾经就是这样，按钮看起来失效）。
    const last = lastWrite.get(region);
    const throttled = !create && !options.byUser && last !== undefined && Date.now() - last < REWRITE_GUARD_MS;
    if (throttled) {
      logger.warn(`MiniMax：${provider} 刚写过仍判定不一致，跳过本次自动对齐`);
      return { ok: true, changed: false, models };
    }
    lastWrite.set(region, Date.now());
    await settings.mutate(String(descriptor.ns), ops, descriptor.revision);
    logger.info(`MiniMax：已更新 ${provider}（${ops.map((op) => op.path.at(-1)).join("、")}）`);
    return { ok: true, changed: true, models };
  }

  /** 已经有路由的区域，自动把目录对齐到当前版本（不创建新路由）。 */
  async function alignExistingRoutes() {
    for (const region of REGIONS) {
      try {
        const result = await ensureRoute(region, { create: false });
        if (!result.ok && result.reason !== "route-not-configured") {
          logger.warn(`MiniMax：对齐 ${ROUTES[region].provider} 目录失败：${result.reason}`);
        }
      } catch (error) {
        logger.warn(`MiniMax：对齐 ${ROUTES[region].provider} 目录抛错`);
        logger.warn(error);
      }
    }
  }

  // ---------- 凭据 ----------

  /**
   * 解析某条路由当前生效的 Key。
   *
   * `source` 直接来自凭据服务的 `ResolvedCredential.source`：`store` 表示凭据库里有一份
   * （本插件写得进去、也删得掉），其它值（例如 `env`）表示它来自环境变量或 .env —— 那一层
   * 本插件既不能改也不能删，必须如实告诉用户，否则「删除」会看起来成功、实际什么也没变。
   */
  async function resolveKey(region) {
    const credentials = service("credentials");
    if (credentials === undefined) return undefined;
    const { profile } = routeProfile(region);
    const ref = credentialRefOf(region, profile);
    try {
      const hit = await credentials.resolve(ref);
      return typeof hit?.value === "string" && hit.value.length > 0
        ? { key: hit.value, ref, source: typeof hit.source === "string" ? hit.source : "unknown" }
        : undefined;
    } catch (error) {
      logger.warn(`MiniMax：解析凭据 ${ref} 失败`);
      logger.warn(error);
      return undefined;
    }
  }

  /**
   * 凭据库里是否存着这一份（只有这一层本插件能删）。
   *
   * 不能用 `describe().configured`：它把环境变量兜底也算作「已配置」，无法区分
   * 「库里有」和「只有环境变量」。必须看解析出来的 `source` 是不是 `store`。
   */
  async function storedKeyExists(region) {
    const resolved = await resolveKey(region);
    return resolved !== undefined && resolved.source === "store";
  }

  // ---------- 名册（多把 Key + 备注名 + 切换） ----------

  /**
   * 读名册。名册存在凭据库里（引用名固定），所以它和其它秘密一样只落在宿主。
   * 坏数据按空名册处理，但绝不删除任何 Key。
   */
  async function readRegistry() {
    const credentials = service("credentials");
    if (credentials === undefined) return emptyRegistry();
    let text;
    try {
      const hit = await credentials.resolve(REGISTRY_REF);
      text = typeof hit?.value === "string" ? hit.value : undefined;
    } catch (error) {
      logger.warn("MiniMax：读取 Key 名册失败");
      logger.warn(error);
      return emptyRegistry();
    }
    const parsed = parseRegistry(text);
    if (parsed.invalid) {
      logger.warn("MiniMax：Key 名册解析失败，已按空名册处理（里面的 Key 不会被删）");
    }
    return parsed.registry;
  }

  /** 写名册。 */
  async function writeRegistry(registry) {
    const credentials = service("credentials");
    if (credentials === undefined) throw new Error("凭据服务不可用，无法保存 Key 名册");
    await credentials.set(REGISTRY_REF, stringifyRegistry(registry));
  }

  /**
   * 当前真正生效的那一把，以及名册是否与之一致。
   *
   * 「生效」不看名册，只看各区域的规范凭据引用里现在是什么值 —— 那是模型路由真正读的
   * 地方。名册只是「我们打算让哪一把生效」的记录。所以：用户若在「设置 → 模型」里直接
   * 改过 Key，名册会与实际对不上，这里必须如实报出来。
   */
  async function effectiveKey() {
    const registry = await readRegistry();
    const candidates = [];
    for (const region of REGIONS) {
      const resolved = await resolveKey(region);
      if (resolved !== undefined) candidates.push({ region, resolved });
    }
    const claimed = activeEntryOf(registry);
    // 优先采信名册声称生效的那个区域；它没有 Key 时才看别的区域。
    let chosen = claimed === undefined ? undefined : candidates.find((c) => c.region === claimed.region);
    if (chosen === undefined) chosen = candidates[0];
    const matched =
      chosen === undefined ? undefined : registry.entries.find((e) => e.key === chosen.resolved.key);
    const activeKey =
      chosen === undefined
        ? null
        : {
            id: matched?.id ?? null,
            name: matched?.name ?? "外部设置的 Key",
            region: chosen.region,
            kind: keyKindOf(chosen.resolved.key),
            hint: keyHintOf(chosen.resolved.key),
            source: chosen.resolved.source,
            registered: matched !== undefined,
          };
    // 名册说 A 生效，实际生效的却是别的 Key —— 对不上，必须让用户知道。
    const mismatch = claimed !== undefined && (matched === undefined || matched.id !== claimed.id);
    return { registry, activeKey, mismatch };
  }

  /**
   * 让名册里的某一把成为当前生效的那一把。
   *
   * 生效 = 把它的 Key 写进它所属区域的规范凭据引用（模型路由读的就是那个引用）。
   * 换区域时，上一个区域里由本插件写入的那份会被收回，保证同一时间只有一把在用；
   * 环境变量那一层本插件动不了，如实说明，而不是假装删掉了。
   */
  async function applyActive(registry, entry) {
    const credentials = service("credentials");
    if (credentials === undefined) throw new Error("凭据服务不可用，无法切换 Key");
    const notices = [];
    const previous = activeEntryOf(registry);
    if (previous !== undefined && previous.id !== entry.id && previous.region !== entry.region) {
      const { profile } = routeProfile(previous.region);
      const previousRef = credentialRefOf(previous.region, profile);
      const resolved = await resolveKey(previous.region);
      if (resolved !== undefined && resolved.key === previous.key) {
        await credentials.unset(previousRef);
        const after = await resolveKey(previous.region);
        if (after === undefined) {
          notices.push(`${ROUTES[previous.region].displayName} 路由现在没有可用 Key。`);
        } else {
          notices.push(
            `${ROUTES[previous.region].displayName} 路由上还留着环境变量里的那一份 Key，仍可使用。`,
          );
        }
      } else if (resolved !== undefined) {
        notices.push(`${ROUTES[previous.region].displayName} 路由上的 Key 不是本插件写入的那一份，没有动它。`);
      }
    }
    const { profile } = routeProfile(entry.region);
    const ref = credentialRefOf(entry.region, profile);
    await credentials.set(ref, entry.key);
    // 同一把 Key 只在一个区域有效（国内与国际不通用）。如果另一个区域里放着的是
    // 同一把 Key（例如上一版插件把它同时写进了两个引用），那是必然配不通的配置，
    // 顺手清掉，并把这件事告诉用户。
    for (const region of REGIONS) {
      if (region === entry.region) continue;
      const other = routeProfile(region);
      const otherRef = credentialRefOf(region, other.profile);
      const resolved = await resolveKey(region);
      if (resolved === undefined || resolved.key !== entry.key) continue;
      await credentials.unset(otherRef);
      notices.push(`${ROUTES[region].displayName} 路由里放的是同一把 Key，已清理（一把 Key 只能在一个区域用）。`);
    }
    registry.activeId = entry.id;
    await writeRegistry(registry);
    quotaCache.delete(entry.region);
    return { notices, ref };
  }

  // ---------- 对 MiniMax 的请求 ----------

  async function minimaxGet(region, path, key, signal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(ROUTES[region].apiRoot + path, {
      method: "GET",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  /**
   * 用 `GET /v1/models` 校验一把 Key 在某区域是否可用。
   * @returns {{ ok: true, models: string[] } | { ok: false, kind: string, message: string, code?: number }}
   */
  async function verifyKey(region, key, signal) {
    let result;
    try {
      result = await minimaxGet(region, "/v1/models", key, signal);
    } catch (error) {
      return { ok: false, kind: "network", message: `无法连接 ${ROUTES[region].apiRoot}：${messageOf(error)}` };
    }
    const failure = failureOf(result.body);
    if (result.status === 200 && failure === undefined) {
      const models = Array.isArray(result.body?.data)
        ? result.body.data.map((m) => m?.id).filter((id) => typeof id === "string")
        : [];
      return { ok: true, models };
    }
    if (failure !== undefined) return { ok: false, kind: failure.kind, code: failure.code, message: failure.message };
    return { ok: false, kind: "error", message: `${ROUTES[region].apiRoot} 返回 HTTP ${result.status}` };
  }

  // ---------- 额度 ----------

  /**
   * 一个区域的额度状态（给浏览器看的纯 JSON，不含 Key）。state 取值：
   *   plan    M Plan 窗口，带各桶各窗口的剩余百分比与重置时间
   *   payg    按量付费 / 没有生效中的套餐：官方无余额接口，附控制台地址
   *   no-key  还没配 Key
   *   error   请求失败或 Key 被拒
   */
  function quotaOf(region, { force = false } = {}) {
    const cached = quotaCache.get(region);
    if (!force && cached !== undefined) {
      const ttl = cached.value.state === "error" ? QUOTA_ERROR_TTL_MS : QUOTA_TTL_MS;
      if (Date.now() - cached.at < ttl) return Promise.resolve(cached.value);
    }
    const pending = quotaPending.get(region);
    if (pending !== undefined) return pending;
    const run = readQuota(region)
      .then((value) => {
        quotaCache.set(region, { at: Date.now(), value });
        return value;
      })
      .finally(() => quotaPending.delete(region));
    quotaPending.set(region, run);
    return run;
  }

  async function readQuota(region) {
    const route = ROUTES[region];
    const base = { region, provider: route.provider, checkedAt: Date.now() };
    const resolved = await resolveKey(region);
    if (resolved === undefined) return { ...base, state: "no-key" };
    const keyKind = keyKindOf(resolved.key);
    // keyName：当前生效这把的备注名 —— 输入框工具栏的小标记用它显示「现在用的是哪一把」。
    const registry = await readRegistry();
    const matched = registry.entries.find((entry) => entry.key === resolved.key);
    const keyInfo = {
      ...base,
      keyKind,
      keyHint: keyHintOf(resolved.key),
      keyName: matched?.name ?? "外部设置的 Key",
    };

    // 按量付费 Key：官方确实没有公开余额接口，不发请求，直接如实回答。
    if (keyKind === "payg") return paygState(keyInfo, "按量付费 Key（sk-api-）");

    let result;
    try {
      result = await minimaxGet(region, "/v1/token_plan/remains", resolved.key);
    } catch (error) {
      return { ...keyInfo, state: "error", message: "无法连接 MiniMax 额度接口", detail: messageOf(error) };
    }
    // 关键：这个接口失败也回 HTTP 200，真正的结果在 base_resp.status_code。
    const failure = failureOf(result.body);
    if (failure?.kind === "no-plan") return paygState(keyInfo, "这把 Key 没有生效中的 M Plan / Token Plan 订阅");
    if (failure !== undefined) return { ...keyInfo, state: "error", code: failure.code, message: failure.message };
    if (result.body === undefined) {
      return { ...keyInfo, state: "error", message: `额度接口返回了无法解析的响应（HTTP ${result.status}）` };
    }
    const buckets = Array.isArray(result.body.model_remains)
      ? result.body.model_remains.map(projectBucket).filter((bucket) => bucket !== null)
      : [];
    if (buckets.length === 0) return paygState(keyInfo, "响应里没有处于套餐内的用量桶");

    // 记一个采样点，供「按当前速度估算多久用完」用。
    recordSample(region, buckets);

    // 给每个窗口配一份速度与推算。
    //
    // **每个窗口必须用自己的采样**：5 小时窗口与每周窗口的剩余百分比是两条独立的
    // 曲线，用同一份采样去算每周的斜率，会把 5 小时的速度套到 5 天的窗口上，
    // 推出「重置时用到 6000%」这种荒谬结论。
    const now = Date.now();
    const withPace = buckets.map((bucket) => ({
      ...bucket,
      windows: bucket.windows.map((win) => ({
        ...win,
        pace: estimatePace(win, samplesOf(region, win.key), now),
      })),
    }));
    return { ...keyInfo, state: "plan", buckets: withPace };
  }

  // ---------- 用量采样（用于估算消耗速度） ----------

  /**
   * 采样历史。MiniMax 的用量窗口是百分比制，接口不给「还剩多少 token」，
   * 只给「还剩百分之几」，所以「按当前用量多久用完」只能从时间序列推：
   * 采样越多，斜率越贴近真实速度。
   *
   * 采样同时落盘，这样重启 DSH 也不会把历史清零（否则「近期速度」要重新攒）。
   */
  const samples = new Map(); // region -> { interval: [...], weekly: [...] }
  const SAMPLE_LIMIT = 720; // 每分钟一条 ≈ 12 小时
  let samplesDirty = false;

  function samplesFile() {
    const home = process.env.DSH_HOME || `${process.env.HOME || ""}/.dsh`;
    return `${home}/minimax-usage-samples.json`;
  }

  /** 取某区域某条窗口的采样（interval / weekly 各自一条曲线）。 */
  function samplesOf(region, windowKey) {
    const entry = samples.get(region);
    if (entry === undefined || entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    return entry[windowKey] ?? [];
  }

  /**
   * 记一个采样点：两个窗口各记各的。
   *
   * 5 小时窗口与每周窗口是两条独立的剩余曲线，速度必须分别算。
   */
  function recordSample(region, buckets) {
    const bucket = buckets.find((b) => b.bucket === "general") ?? buckets[0];
    if (bucket === undefined) return;
    const entry = samples.get(region);
    const store = entry !== undefined && entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? entry
      : { interval: [], weekly: [] };
    const t = Date.now();
    let changed = false;
    for (const win of bucket.windows) {
      const list = store[win.key] ?? (store[win.key] = []);
      const last = list[list.length - 1];
      // 同一时刻不重复记；一分钟内也不重复记（轮询间隔就是 60s）。
      if (last !== undefined && t - last.t < 30_000) continue;
      list.push({ t, remainingPercent: win.remainingPercent });
      while (list.length > SAMPLE_LIMIT) list.shift();
      changed = true;
    }
    if (!changed) return;
    samples.set(region, store);
    samplesDirty = true;
  }

  function loadSamples() {
    try {
      const raw = readFileSync(samplesFile(), "utf8");
      const parsed = JSON.parse(raw);
      for (const [region, entry] of Object.entries(parsed ?? {})) {
        // 旧格式（扁平数组）只对应 5 小时窗口，丢掉重新采即可 —— 混用会让每周的
        // 速度变成 5 小时的速度。
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const store = {};
        for (const key of ["interval", "weekly"]) {
          if (Array.isArray(entry[key])) store[key] = entry[key].filter((s) => s && typeof s.t === "number");
        }
        samples.set(region, store);
      }
    } catch {
      // 没有历史文件是正常情况。
    }
  }

  function saveSamples() {
    if (!samplesDirty) return;
    samplesDirty = false;
    try {
      const file = samplesFile();
      writeFileSync(file, JSON.stringify(Object.fromEntries(samples)), { mode: 0o600 });
    } catch (error) {
      logger.warn("MiniMax：用量采样写盘失败");
      logger.warn(error);
    }
  }

  function paygState(keyInfo, reason) {
    return {
      ...keyInfo,
      state: "payg",
      message: "MiniMax 没有提供按量付费余额的查询接口",
      detail: `${reason}；余额与消费只能在 MiniMax 控制台查看。`,
      consoleUrl: ROUTES[keyInfo.region].balanceConsole,
    };
  }

  // ---------- RPC 端点 ----------

  /** 设置页一次取全的状态：两个区域的路由 / Key / 目录事实。 */
  async function rpcStatus() {
    const credentials = service("credentials");
    const regions = [];
    for (const region of REGIONS) {
      const route = ROUTES[region];
      const { profile } = routeProfile(region);
      const ref = credentialRefOf(region, profile);
      let credential = { configured: false };
      if (credentials !== undefined) {
        try {
          const info = await credentials.describe(ref);
          credential = { configured: info.configured === true, source: info.source, writable: info.writable === true };
        } catch {
          credential = { configured: false };
        }
      }
      let keyHint;
      let keyKind;
      let keySource;
      let storedInCredentialStore = false;
      if (credential.configured) {
        const resolved = await resolveKey(region);
        if (resolved !== undefined) {
          keyHint = keyHintOf(resolved.key);
          keyKind = keyKindOf(resolved.key);
          keySource = resolved.source;
        }
        // 关键区分：库里那份（我们删得掉）vs 环境变量兜底那份（删不掉）。
        // 界面上「删除」按钮是否可用、以及删完到底会不会真的消失，都取决于这个。
        storedInCredentialStore = await storedKeyExists(region);
      }
      const ids = Array.isArray(profile?.models) ? profile.models.map((m) => m?.id).filter(Boolean) : [];
      // 当前生效的上下文预算：取该路由上本插件管理的第一个模型的值。
      const managed = Array.isArray(profile?.models)
        ? profile.models.find((m) => m !== null && typeof m === "object" && MODELS.some((d) => d.id === m.id))
        : undefined;
      regions.push({
        region,
        provider: route.provider,
        displayName: route.displayName,
        baseURL: route.baseURL,
        keyConsole: route.keyConsole,
        credentialRef: ref,
        configured: profile !== undefined,
        credential,
        keyHint,
        keyKind,
        keySource,
        storedInCredentialStore,
        // 删完是否会立刻回落到环境变量（即「删除」按了也没用）—— 界面据此换文案。
        fromEnvironment: credential.configured === true && storedInCredentialStore === false,
        catalogCurrent: profile !== undefined && catalogUpToDate(profile.models),
        contextWindow:
          managed?.contextWindow === undefined ? undefined : normalizeContextWindow(managed.contextWindow),
        modelIds: ids,
      });
    }
    const { registry, activeKey, mismatch } = await effectiveKey();
    return {
      regions,
      models: MODELS.map(({ id, name, maxTokens, input, note }) => ({ id, name, maxTokens, input, note })),
      contextOptions: CONTEXT_OPTIONS,
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
      retired: RETIRED_MODELS,
      settingsAvailable: service("settings") !== undefined,
      credentialsAvailable: credentials !== undefined,
      // ---- 多 Key 名册 ----
      registryRef: REGISTRY_REF,
      keys: registry.entries.map((entry) => projectEntry(entry, registry.activeId)),
      activeKey,
      mismatch,
    };
  }

  /**
   * 保存 Key：校验 → 写凭据 → 建路由 / 补目录。region 为 "auto" 时先国内后国际自动识别。
   * Key 校验不通过就什么都不写。
   */
  async function rpcSaveKey(payload, signal) {
    const key = normalizeKey(payload?.key);
    if (key === undefined) return { saved: false, message: "这不像一把 API Key：请粘贴完整的 Key（不能含空格）" };
    const credentials = service("credentials");
    if (credentials === undefined) return { saved: false, message: "凭据服务不可用，无法保存 Key" };

    const requested = REGIONS.includes(payload?.region) ? [payload.region] : REGIONS;
    let region;
    let verified;
    const attempts = [];
    for (const candidate of requested) {
      const outcome = await verifyKey(candidate, key, signal);
      if (outcome.ok) {
        region = candidate;
        verified = outcome;
        break;
      }
      attempts.push(`${ROUTES[candidate].displayName}：${outcome.message}`);
      // 网络错误时不要继续拿它去试另一个区域：结论不可靠。
      if (outcome.kind === "network") break;
    }
    if (region === undefined) return { saved: false, message: "Key 校验未通过", detail: attempts.join("；") };

    const { profile } = routeProfile(region);
    const ref = credentialRefOf(region, profile);

    // ---- 名册：保存的是「多把里的一把」，不再覆盖上一把 ----
    const registry = await readRegistry();
    let entry = registry.entries.find((candidate) => candidate.key === key && candidate.region === region);
    const requestedName = normalizeName(payload?.name);
    if (entry === undefined) {
      entry = {
        id: newEntryId(),
        name: requestedName ?? defaultName(countEntriesOf(registry, region)),
        region,
        key,
        kind: keyKindOf(key),
        createdAt: Date.now(),
      };
      registry.entries.push(entry);
    } else if (requestedName !== undefined) {
      entry.name = requestedName;
    }

    // activate 缺省为 true：保存完就让它生效。传 false 则只入库、当前生效的那把不动。
    const activate = payload?.activate !== false;
    let notice;
    if (activate) {
      const applied = await applyActive(registry, entry);
      notice = applied.notices.length > 0 ? applied.notices.join(" ") : undefined;
    } else {
      await writeRegistry(registry);
    }

    const route = await ensureRoute(region, { create: true, byUser: true });
    quotaCache.delete(region);
    notifyModelsChanged();
    return {
      saved: true,
      region,
      provider: ROUTES[region].provider,
      displayName: ROUTES[region].displayName,
      keyHint: keyHintOf(key),
      keyKind: keyKindOf(key),
      credentialRef: ref,
      routeOk: route.ok,
      routeMessage: route.ok ? undefined : route.reason,
      models: MODELS.map((m) => m.id),
      upstreamHasFlash: verified.models.includes("MiniMax-M3.1-Flash"),
      entry: {
        id: entry.id,
        name: entry.name,
        region: entry.region,
        kind: entry.kind,
        hint: keyHintOf(entry.key),
        createdAt: entry.createdAt,
        active: activate,
      },
      activated: activate,
      notice,
    };
  }

  /** 把名册里的某一把设为当前生效的那一把。 */
  async function rpcActivateKey(payload) {
    const registry = await readRegistry();
    const entry = registry.entries.find((candidate) => candidate.id === payload?.id);
    if (entry === undefined) return { ok: false, message: "找不到这把 Key" };
    const applied = await applyActive(registry, entry);
    return {
      ok: true,
      active: {
        id: entry.id,
        name: entry.name,
        region: entry.region,
        kind: entry.kind,
        hint: keyHintOf(entry.key),
      },
      notice: applied.notices.length > 0 ? applied.notices.join(" ") : undefined,
    };
  }

  /** 改备注名。 */
  async function rpcRenameKey(payload) {
    const registry = await readRegistry();
    const entry = registry.entries.find((candidate) => candidate.id === payload?.id);
    if (entry === undefined) return { ok: false, message: "找不到这把 Key" };
    const name = normalizeName(payload?.name);
    if (name === undefined) return { ok: false, message: "备注名不能为空" };
    entry.name = name;
    await writeRegistry(registry);
    return { ok: true, id: entry.id, name };
  }

  /** 删掉一把。删的是当前生效的那把时，把规范凭据引用里本插件写的那份也收回来。 */
  async function rpcDeleteKey(payload) {
    const credentials = service("credentials");
    const registry = await readRegistry();
    const index = registry.entries.findIndex((candidate) => candidate.id === payload?.id);
    if (index === -1) return { ok: false, message: "找不到这把 Key" };
    const entry = registry.entries[index];
    const wasActive = registry.activeId === entry.id;
    registry.entries.splice(index, 1);
    if (wasActive) registry.activeId = null;
    await writeRegistry(registry);

    let stillActive = false;
    let message = `已删除「${entry.name}」。`;
    if (wasActive) {
      const { profile } = routeProfile(entry.region);
      const ref = credentialRefOf(entry.region, profile);
      const resolved = await resolveKey(entry.region);
      // 只有确实是我们写进去的那一份才收；环境变量那一层本插件动不了。
      if (resolved !== undefined && resolved.key === entry.key && credentials !== undefined) {
        await credentials.unset(ref);
      }
      const after = await resolveKey(entry.region);
      if (after !== undefined) {
        stillActive = true;
        message = `已删除「${entry.name}」，但${ROUTES[entry.region].displayName} 路由上还留着环境变量里的那一份 Key，仍在使用。`;
      } else {
        message = `已删除「${entry.name}」，${ROUTES[entry.region].displayName} 路由现在没有可用 Key。`;
      }
      quotaCache.delete(entry.region);
    }
    return { ok: true, deleted: true, wasActive, stillActive, message };
  }

  /**
   * 把当前真正生效的那把 Key 登记进名册（用户此前可能在「设置 → 模型」里直接改过）。
   */
  async function rpcAdoptKey(payload) {
    const { registry, activeKey } = await effectiveKey();
    if (activeKey === null) return { ok: false, message: "当前没有生效的 Key" };
    const resolved = await resolveKey(activeKey.region);
    if (resolved === undefined) return { ok: false, message: "当前没有生效的 Key" };
    let entry = registry.entries.find((candidate) => candidate.key === resolved.key);
    const requestedName = normalizeName(payload?.name);
    if (entry === undefined) {
      entry = {
        id: newEntryId(),
        name: requestedName ?? defaultName(countEntriesOf(registry, activeKey.region)),
        region: activeKey.region,
        key: resolved.key,
        kind: keyKindOf(resolved.key),
        createdAt: Date.now(),
      };
      registry.entries.push(entry);
    } else if (requestedName !== undefined) {
      entry.name = requestedName;
    }
    const applied = await applyActive(registry, entry);
    quotaCache.delete(activeKey.region);
    return {
      ok: true,
      entry: {
        id: entry.id,
        name: entry.name,
        region: entry.region,
        kind: entry.kind,
        hint: keyHintOf(entry.key),
        createdAt: entry.createdAt,
        active: true,
      },
      active: {
        id: entry.id,
        name: entry.name,
        region: entry.region,
        kind: entry.kind,
        hint: keyHintOf(entry.key),
      },
      notice: applied.notices.length > 0 ? applied.notices.join(" ") : undefined,
    };
  }

  /** 清除 Key：只删凭据，保留路由与目录（没有 Key 的路由在请求时会报 MISSING_CREDENTIAL）。 */
  /**
   * 删除 Key。
   *
   * 只能删掉凭据库里那一层。凭据引用背后还有环境变量 / .env 这样的兜底层，删掉库里那份后
   * 会立刻回落到兜底层 —— 若不把这件事说清楚，界面就会显示「已删除」而 Key 其实还在用
   * （曾经就是这个 bug）。
   *
   * @returns {{ cleared: boolean, region: string, stillFromEnv?: string, message?: string, source?: string }}
   */
  async function rpcClearKey(payload) {
    const region = REGIONS.includes(payload?.region) ? payload.region : "cn";
    const credentials = service("credentials");
    if (credentials === undefined) return { cleared: false, region, message: "凭据服务不可用" };
    const { profile } = routeProfile(region);
    const ref = credentialRefOf(region, profile);
    const before = await resolveKey(region);
    const stored = await storedKeyExists(region);

    if (stored) await credentials.unset(ref);
    quotaCache.delete(region);

    // 名册里对应的那一条也一并删掉（否则会留下一个指向已删 Key 的条目）。
    // 只有确实是本插件写进库里那一份时才动 —— 环境变量那层本插件管不了。
    if (before !== undefined && before.source === "store") {
      const registry = await readRegistry();
      const index = registry.entries.findIndex(
        (entry) => entry.region === region && entry.key === before.key,
      );
      if (index !== -1) {
        const removed = registry.entries[index];
        registry.entries.splice(index, 1);
        if (registry.activeId === removed.id) registry.activeId = null;
        await writeRegistry(registry);
      }
    }

    // 删完再解析一次：还有值就说明兜底层在生效，且这一层本插件动不了。
    const after = await resolveKey(region);
    if (after !== undefined) {
      return {
        cleared: stored,
        region,
        removedFromStore: stored,
        stillActive: true,
        source: after.source,
        message: stored
          ? "已删除本插件保存的那份 Key，但环境变量里还有一份仍在使用"
          : "这把 Key 来自环境变量，不是本插件保存的，删不掉",
      };
    }
    if (!stored && before === undefined) {
      return { cleared: false, region, removedFromStore: false, message: "本来就没有保存 Key" };
    }
    return { cleared: true, region, removedFromStore: stored, stillActive: false };
  }

  /** 校验一把 Key。可以校验名册里指定的某一把，也可以校验某区域当前生效的那一把。 */
  async function rpcTestKey(payload, signal) {
    let region;
    let key;
    if (typeof payload?.id === "string" && payload.id.length > 0) {
      const registry = await readRegistry();
      const entry = registry.entries.find((candidate) => candidate.id === payload.id);
      if (entry === undefined) return { ok: false, message: "找不到这把 Key" };
      region = entry.region;
      key = entry.key;
    } else {
      region = REGIONS.includes(payload?.region) ? payload.region : "cn";
      const resolved = await resolveKey(region);
      if (resolved === undefined) return { ok: false, message: "还没有保存 Key" };
      key = resolved.key;
    }
    const outcome = await verifyKey(region, key, signal);
    return outcome.ok
      ? { ok: true, message: `连接正常，上游可用模型 ${outcome.models.length} 个`, models: outcome.models }
      : { ok: false, message: outcome.message };
  }

  async function rpcQuota(payload) {
    const force = payload?.force === true;
    if (REGIONS.includes(payload?.region)) return quotaOf(payload.region, { force });
    // 未指定区域：取第一个有 Key 的区域，都没有就报国内的 no-key。
    for (const region of REGIONS) {
      const value = await quotaOf(region, { force });
      if (value.state !== "no-key") return value;
    }
    return quotaOf("cn");
  }

  async function dispatch(endpoint, payload, signal) {
    switch (endpoint) {
      case "status":
        return rpcStatus();
      case "quota":
        return rpcQuota(payload);
      case "saveKey":
        return rpcSaveKey(payload, signal);
      case "clearKey":
        return rpcClearKey(payload);
      case "testKey":
        return rpcTestKey(payload, signal);
      case "activateKey":
        return rpcActivateKey(payload);
      case "renameKey":
        return rpcRenameKey(payload);
      case "deleteKey":
        return rpcDeleteKey(payload);
      case "adoptKey":
        return rpcAdoptKey(payload);
      case "sync": {
        const region = REGIONS.includes(payload?.region) ? payload.region : "cn";
        const result = await ensureRoute(region, { create: false, byUser: true });
        if (result.changed) notifyModelsChanged();
        return result;
      }
      case "setContext": {
        // 切换上下文预算：写进该区域的模型目录（两条路由各自独立，因为用户可能只配了一个区域）。
        const window = normalizeContextWindow(payload?.contextWindow);
        const results = [];
        for (const region of REGIONS) {
          const { profile } = routeProfile(region);
          if (profile === undefined) continue; // 没配置的区域不动，避免凭空建路由
          const result = await ensureRoute(region, { create: false, contextWindow: window, byUser: true });
          results.push({ region, ok: result.ok, changed: result.changed === true, reason: result.reason });
        }
        if (results.some((r) => r.changed)) notifyModelsChanged();
        return { contextWindow: window, results };
      }
      default:
        throw new RpcFailure("gateway/not-found", `未知端点 ${endpoint}`);
    }
  }

  /** 统一包装成 ConnectionRpcHandlerResult：`{ ok, value }` 或 `{ ok: false, error }`。 */
  const handler = async (endpoint, payload, signal) => {
    try {
      return { ok: true, value: await dispatch(endpoint, payload, signal) };
    } catch (error) {
      const code = error instanceof RpcFailure ? error.code : "gateway/internal";
      if (!(error instanceof RpcFailure)) {
        logger.warn(`MiniMax：RPC ${endpoint} 失败`);
        logger.warn(error);
      }
      return { ok: false, error: { code, message: messageOf(error), details: {} } };
    }
  };

  function notifyModelsChanged() {
    try {
      ctx.emit("llm/adapters-updated");
    } catch (error) {
      logger.warn("MiniMax：广播模型目录变化失败");
      logger.warn(error);
    }
  }

  // RPC 频道注册。
  //
  // `connection.rpc.handle` 的实现是 `owner.webServer.register(route)`：它从**调用方**的
  // context 读 webServer。所以 scope 必须同时 inject `webServer`，否则注册时就抛错、频道
  // 根本不存在，浏览器每次调用都会拿到 HTTP 405（只 inject connection 时就是这个现象）。
  //
  // 万一某个版本的 rpc.handle 仍然不可用，退回在 webServer 上注册同样的前缀路由，并复用
  // connection 自己的 Host/Origin 栅栏与浏览器会话鉴权（`admit`），信封格式与 rpc.handle
  // 完全一致，浏览器半边不需要区分。
  ctx.inject(["connection", "webServer"], (scope) => {
    const connection = scope.connection;
    try {
      scope.effect(() => connection.rpc.handle(CHANNEL, handler), "MiniMax：RPC 频道");
      return;
    } catch (error) {
      logger.warn("MiniMax：connection.rpc.handle 不可用，改用 webServer 前缀路由");
      logger.warn(error);
    }
    scope.effect(
      () =>
        scope.webServer.register({
          kind: "prefix",
          path: CHANNEL,
          handler: (req, res) => handleFallbackRequest(connection, req, res, handler),
        }),
      "MiniMax：RPC 频道（回退路由）",
    );
  });

  // ---------- 生命周期 ----------

  // settings 服务就绪后对齐一次已有路由的目录；之后 llm-pi-ai 那一行的表单每次变化都再
  // 对齐，保证用户在「设置 → 模型」里动过这条路由后 M3.1 不会被挤掉。
  //
  // 注意不能用 `loader/volatile-update`：Loader 把它过滤给配置所属的 fiber，别的插件的
  // 配置变化本插件收不到。`settings/document-updated` 是面向所有人的那一个。
  ctx.inject(["settings"], (scope) => {
    void alignExistingRoutes();
    scope.on("settings/document-updated", (ns) => {
      if (!/(^|:)llm-pi-ai$/.test(String(ns))) return;
      quotaCache.clear();
      void alignExistingRoutes();
    });
  });

  // 凭据在别处被改（例如内置「设置 → 模型」页）时，额度缓存立即作废。
  ctx.on("credentials/reference-updated", (ref) => {
    for (const region of REGIONS) {
      if (String(ref) === ROUTES[region].env) quotaCache.delete(region);
    }
  });

  // ---------- 采样循环 ----------
  //
  // 定期读一次额度并记下采样点：MiniMax 的用量窗口是百分比制，「按当前用量多久用完」
  // 只能从时间序列的斜率推出来。页面关着也照采，重启后历史仍在（落盘）。
  loadSamples();
  const sampler = setInterval(() => {
    for (const region of REGIONS) {
      void quotaOf(region, { force: true }).catch(() => {});
    }
    saveSamples();
  }, 60_000);
  if (typeof sampler.unref === "function") sampler.unref();
  ctx.effect(() => () => {
    clearInterval(sampler);
    saveSamples();
  });
}

class RpcFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function messageOf(error) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "请求超时";
    if (error.name === "AbortError") return "请求已取消";
    return error.message;
  }
  return String(error);
}

/**
 * 回退路由：在 webServer 上手工实现与 `connection.rpc.handle` 相同的协议。
 *   请求  POST {CHANNEL}/{endpoint}，JSON：{ type: "client-request", rpcId, method, payload }
 *   应答  200 JSON：{ type: "server-response", rpcId, result }，result 即 handler 的返回值
 * 鉴权走 connection 的公开栅栏 `requestRejection`（Host/Origin + 浏览器会话），不绕过。
 */
export async function handleFallbackRequest(connection, req, res, handler) {
  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) {
    res.writeHead(rejection);
    res.end(rejection === 401 ? "unauthorized" : "forbidden");
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
  const endpoint = pathname.startsWith(CHANNEL + "/") ? pathname.slice(CHANNEL.length + 1) : undefined;
  if (endpoint === undefined || endpoint.length === 0 || endpoint.includes("/")) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("method not allowed");
    return;
  }
  const contentType =
    typeof req.headers["content-type"] === "string"
      ? req.headers["content-type"].split(";", 1)[0].trim().toLowerCase()
      : undefined;
  if (contentType !== "application/json") {
    res.writeHead(415);
    res.end("content type must be application/json");
    return;
  }
  let envelope;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400);
    res.end("body is not JSON");
    return;
  }
  if (envelope === null || typeof envelope !== "object") {
    res.writeHead(400);
    res.end("body is not an object");
    return;
  }
  const rpcId = typeof envelope.rpcId === "string" ? envelope.rpcId : "invalid-request";
  const result =
    envelope.method !== endpoint
      ? {
          ok: false,
          error: {
            code: "gateway/bad-request",
            message: `method ${JSON.stringify(String(envelope.method))} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: {},
          },
        }
      : await handler(endpoint, envelope.payload, new AbortController().signal, undefined);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ type: "server-response", rpcId, result }));
}
