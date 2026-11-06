/**
 * 宿主半边的端到端测试：用假的 settings / credentials / connection 服务驱动真实的 apply()，
 * 对 MiniMax **真实接口**走一遍「设置页粘贴 Key → 校验 → 存凭据 → 写路由 → 读额度」。
 *
 * 只有设置了 MINIMAX_TEST_KEY 时才跑联网部分；否则只跑离线部分。
 *   MINIMAX_TEST_KEY="$(cat /tmp/mm_test_token.txt)" node --test test/host.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import { apply, CHANNEL } from "../lib/index.js";

const LIVE_KEY = process.env.MINIMAX_TEST_KEY;

import { harness, viaFallback } from "./harness.js";


test("RPC 频道注册上了：rpc.handle 拿得到 webServer（修复线上 HTTP 405）", () => {
  const h = harness();
  assert.equal(h.routes.length, 1, "频道应恰好注册一次");
  assert.equal(h.routes[0].path, CHANNEL);
  assert.equal(h.routes[0].handler, "rpc.handle", "正常版本走 connection.rpc.handle");
});

test("rpc.handle 不可用时退回 webServer 前缀路由，协议与鉴权保持一致", async () => {
  const h = harness({ rpcHandleBroken: true });
  assert.equal(h.routes.length, 1);
  const route = h.routes[0];
  assert.equal(typeof route.handler, "function", "回退路由是真实的 HTTP handler");

  const status = await viaFallback(route, "status", {});
  assert.equal(status.ok, true);
  assert.equal(status.value.regions[0].provider, "minimax-cn");

  const denied = await viaFallback(route, "status", {}, { auth: "nope" });
  assert.equal(denied.httpStatus, 401, "没有浏览器会话必须被拒");

  const unknown = await viaFallback(route, "nope", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "gateway/not-found");
});

test("RPC 结果总是 { ok, value } / { ok: false, error } 信封", async () => {
  const h = harness();
  const status = await h.call("status", {});
  assert.equal(status.ok, true);
  assert.equal(status.value.regions.length, 2);
  assert.equal(status.value.regions[0].provider, "minimax-cn");
  assert.equal(status.value.regions[0].configured, false);

  const unknown = await h.call("nope", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "gateway/not-found");
});

test("没有 Key 时额度为 no-key，且不发请求", async () => {
  const h = harness();
  const quota = await h.call("quota", {});
  assert.equal(quota.value.state, "no-key");
});

test("不像 Key 的输入在发请求前就被拒，凭据库不被写", async () => {
  const h = harness();
  const result = await h.call("saveKey", { key: "abc def ghi" });
  assert.equal(result.ok, true);
  assert.equal(result.value.saved, false);
  assert.equal(h.store.size, 0);
});

test("已有路由启动时自动对齐目录，并保留用户自己的字段和模型", async () => {
  const h = harness({
    providers: {
      "minimax-cn": {
        apiKeyEnv: "MY_MINIMAX_KEY",
        retryPolicy: { mode: "normal", maxRetries: 2 },
        models: [{ id: "MiniMax-M2.7" }, { id: "custom-1", name: "自定义" }],
      },
    },
  });
  // apply 里的对齐是异步的，等它落盘。
  await new Promise((r) => setTimeout(r, 20));
  const route = h.state.providers["minimax-cn"];
  assert.deepEqual(route.models.map((m) => m.id), ["MiniMax-M3.1-Flash", "MiniMax-M3", "custom-1"]);
  assert.equal(route.apiKeyEnv, "MY_MINIMAX_KEY", "用户自定义的凭据引用不能被覆盖");
  assert.deepEqual(route.retryPolicy, { mode: "normal", maxRetries: 2 }, "其它字段不能被动");
  assert.equal(h.state.mutations.length, 1, "写入后的 volatile-update 不应再触发第二次写入");
  assert.equal(h.state.providers.minimax, undefined, "没配置过的国际路由不能凭空创建");
});

test("按量付费 Key 的额度状态不发请求、如实说明", { skip: false }, async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  h.store.set("MINIMAX_CN_API_KEY", "sk-api-0000000000000000");
  const quota = await h.call("quota", { region: "cn" });
  assert.equal(quota.value.state, "payg");
  assert.equal(quota.value.keyKind, "payg");
  assert.match(quota.value.consoleUrl, /minimaxi\.com/);
  assert.equal(JSON.stringify(quota).includes("sk-api-0000000000000000"), false, "Key 不能出现在给浏览器的结果里");
});

test("联网：无效 Key 两个区域都校验失败，什么都不写", { skip: LIVE_KEY === undefined }, async () => {
  const h = harness();
  const result = await h.call("saveKey", { key: "sk-api-definitely-not-valid-000000" });
  assert.equal(result.value.saved, false);
  assert.match(result.value.detail, /MiniMax 国内/);
  assert.equal(h.store.size, 0);
  assert.deepEqual(h.state.providers, {});
});

test("联网：真实 Key 自动识别国内 → 存凭据 → 建路由 → 读到套餐额度", { skip: LIVE_KEY === undefined }, async () => {
  const h = harness();
  const saved = await h.call("saveKey", { key: "  " + LIVE_KEY + "\n", region: "auto" });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.saved, true, JSON.stringify(saved.value));
  assert.equal(saved.value.region, "cn");
  assert.equal(saved.value.provider, "minimax-cn");
  assert.equal(saved.value.upstreamHasFlash, true, "上游 /v1/models 应包含 MiniMax-M3.1-Flash");
  assert.equal(JSON.stringify(saved).includes(LIVE_KEY), false, "Key 不能回传浏览器");

  assert.equal(h.store.get("MINIMAX_CN_API_KEY"), LIVE_KEY, "规整后的 Key 写进约定的凭据引用");
  const route = h.state.providers["minimax-cn"];
  assert.equal(route.apiKeyEnv, "MINIMAX_CN_API_KEY");
  assert.deepEqual(route.models.map((m) => m.id), ["MiniMax-M3.1-Flash", "MiniMax-M3"]);
  assert.ok(h.emitted.includes("llm/adapters-updated"));

  const status = await h.call("status", {});
  const cn = status.value.regions.find((r) => r.region === "cn");
  assert.equal(cn.configured, true);
  assert.equal(cn.credential.configured, true);
  assert.equal(cn.catalogCurrent, true);
  assert.equal(cn.keyHint, "••••" + LIVE_KEY.slice(-4));

  const quota = await h.call("quota", { force: true });
  assert.equal(quota.value.state, "plan", JSON.stringify(quota.value));
  const general = quota.value.buckets.find((b) => b.bucket === "general");
  assert.ok(general, "应有文本桶");
  const interval = general.windows.find((w) => w.key === "interval");
  assert.equal(interval.windowMs, 5 * 3_600_000);
  assert.ok(interval.remainingPercent >= 0 && interval.remainingPercent <= 100);

  const tested = await h.call("testKey", { region: "cn" });
  assert.equal(tested.value.ok, true);

  const cleared = await h.call("clearKey", { region: "cn" });
  assert.equal(cleared.value.cleared, true);
  assert.equal(h.store.has("MINIMAX_CN_API_KEY"), false);
  assert.equal((await h.call("quota", { region: "cn" })).value.state, "no-key");
});

test("联网：国内 Key 强制选国际区域会被拒（2049），不写入", { skip: LIVE_KEY === undefined }, async () => {
  const h = harness();
  const result = await h.call("saveKey", { key: LIVE_KEY, region: "intl" });
  assert.equal(result.value.saved, false);
  assert.match(result.value.detail, /区域/);
  assert.equal(h.store.size, 0);
});

test("删除环境变量提供的 Key：如实报告删不掉，不谎报成功", async () => {
  const h = harness({
    providers: { minimax: { apiKeyEnv: "MINIMAX_API_KEY" } },
    envKeys: { MINIMAX_API_KEY: "env-provided-key-000000" },
  });

  // status 必须标出这一层是环境变量给的，且库里没有。
  const status = await h.call("status", {});
  const intl = status.value.regions.find((r) => r.region === "intl");
  assert.equal(intl.credential.configured, true);
  assert.equal(intl.fromEnvironment, true, "必须标记为来自环境变量");
  assert.equal(intl.storedInCredentialStore, false);
  assert.equal(intl.keySource, "env");

  const cleared = await h.call("clearKey", { region: "intl" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.cleared, false, "没有从库里删掉任何东西，不能报成功");
  assert.equal(cleared.value.stillActive, true, "Key 仍然生效，界面必须知道");
  assert.match(cleared.value.message, /环境变量/);

  // 删完之后 Key 依然在（这正是用户看到的「删了还在」）。
  const after = await h.call("status", {});
  assert.equal(after.value.regions.find((r) => r.region === "intl").credential.configured, true);
});

test("删除库里保存的 Key：删掉后回落到环境变量也如实报告", async () => {
  const h = harness({
    providers: { minimax: { apiKeyEnv: "MINIMAX_API_KEY" } },
    envKeys: { MINIMAX_API_KEY: "env-provided-key-000000" },
  });
  h.store.set("MINIMAX_API_KEY", "stored-in-keyring-111111");

  const before = await h.call("status", {});
  const b = before.value.regions.find((r) => r.region === "intl");
  assert.equal(b.storedInCredentialStore, true);
  assert.equal(b.fromEnvironment, false);

  const cleared = await h.call("clearKey", { region: "intl" });
  assert.equal(cleared.value.removedFromStore, true, "库里那份要真的删掉");
  assert.equal(cleared.value.stillActive, true, "但环境变量那层还在，Key 仍生效");
  assert.equal(h.store.has("MINIMAX_API_KEY"), false);
  assert.match(cleared.value.message, /环境变量里还有一份/);
});

test("删除库里保存的 Key：没有兜底层时彻底消失", async () => {
  const h = harness({ providers: { minimax: { apiKeyEnv: "MINIMAX_API_KEY" } } });
  h.store.set("MINIMAX_API_KEY", "stored-only-222222");

  const cleared = await h.call("clearKey", { region: "intl" });
  assert.equal(cleared.value.cleared, true);
  assert.equal(cleared.value.stillActive, false);
  assert.equal(cleared.value.removedFromStore, true);

  const after = await h.call("status", {});
  const r = after.value.regions.find((x) => x.region === "intl");
  assert.equal(r.credential.configured, false, "界面上这一行应当消失");
  assert.equal((await h.call("quota", { region: "intl" })).value.state, "no-key");
});

test("删除本来就没有的 Key：不谎报", async () => {
  const h = harness();
  const cleared = await h.call("clearKey", { region: "cn" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.cleared, false);
  assert.match(cleared.value.message, /本来就没有/);
});

test("setContext 改到已配置路由的上下文，且不影响其它字段", async () => {
  const h = harness({
    providers: {
      "minimax-cn": { apiKeyEnv: "MINIMAX_CN_API_KEY", retryPolicy: { mode: "normal", maxRetries: 2 } },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.state.providers["minimax-cn"].models[0].contextWindow, 1000000);

  const result = await h.call("setContext", { contextWindow: 200000 });
  assert.equal(result.ok, true);
  assert.equal(result.value.contextWindow, 200000);
  for (const model of h.state.providers["minimax-cn"].models) {
    assert.equal(model.contextWindow, 200000, "两个模型都跟着切");
  }
  assert.deepEqual(h.state.providers["minimax-cn"].retryPolicy, { mode: "normal", maxRetries: 2 }, "其它字段不动");
  assert.equal(h.state.providers.minimax, undefined, "没配置的区域不能被顺手创建");

  // 再对齐一次不应把值改回默认。
  const synced = await h.call("sync", { region: "cn" });
  assert.equal(synced.value.changed, false, "已经是最新，不应重复写");
  assert.equal(h.state.providers["minimax-cn"].models[0].contextWindow, 200000);
});

test("setContext 遇到未知档位会规整成合法值", async () => {
  const h = harness({ providers: { "minimax-cn": { apiKeyEnv: "MINIMAX_CN_API_KEY" } } });
  await new Promise((r) => setTimeout(r, 20));
  const result = await h.call("setContext", { contextWindow: 400000 });
  assert.equal(result.value.contextWindow, 200000, "取不超过它的最大档");
  assert.equal(h.state.providers["minimax-cn"].models[0].contextWindow, 200000);
});

