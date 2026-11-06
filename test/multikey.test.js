/**
 * 多 Key 的离线测试：名册 + 切换 + 改名 + 删除 + 登记。
 *
 * 这些端点都不需要联网（不校验 Key），所以直接往凭据库里塞一份名册就能测。
 * 「保存 Key」要打上游接口，属于联网测试（见 host.test.js）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { harness } from "./harness.js";
import { REGISTRY_REF } from "../lib/registry.js";

const KEY_A = "sk-cp-aaaaaaaaaaaaaaaa";
const KEY_B = "sk-cp-bbbbbbbbbbbbbbbb";
const KEY_INTL = "sk-cp-cccccccccccccccc";

/** 往凭据库里塞一份名册。 */
function seed(h, entries, activeId) {
  h.store.set(
    REGISTRY_REF,
    JSON.stringify({
      version: 1,
      entries: entries.map((entry) => ({
        kind: "plan",
        createdAt: 1,
        ...entry,
      })),
      activeId: activeId ?? null,
    }),
  );
}

function registryOf(h) {
  return JSON.parse(h.store.get(REGISTRY_REF));
}

test("名册里有多把 Key 时，当前生效的只有一把", async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  seed(
    h,
    [
      { id: "k1", name: "公司号", region: "cn", key: KEY_A },
      { id: "k2", name: "个人号", region: "cn", key: KEY_B },
    ],
    "k1",
  );
  h.store.set("MINIMAX_CN_API_KEY", KEY_A);

  const status = await h.call("status", {});
  assert.equal(status.value.keys.length, 2, "两把 Key 都该在列表里");
  assert.equal(status.value.keys.find((k) => k.id === "k1").active, true);
  assert.equal(status.value.keys.find((k) => k.id === "k2").active, false);
  assert.equal(status.value.activeKey.id, "k1");
  assert.equal(status.value.activeKey.name, "公司号");
  assert.equal(status.value.activeKey.hint, "••••" + KEY_A.slice(-4));
  assert.equal(status.value.mismatch, false);
  assert.equal(JSON.stringify(status).includes(KEY_A), false, "原始 Key 不能回传浏览器");
  assert.equal(JSON.stringify(status).includes(KEY_B), false, "原始 Key 不能回传浏览器");
});

test("切换：改写规范凭据引用，同一时间只有一把生效", async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  seed(
    h,
    [
      { id: "k1", name: "公司号", region: "cn", key: KEY_A },
      { id: "k2", name: "个人号", region: "cn", key: KEY_B },
    ],
    "k1",
  );
  h.store.set("MINIMAX_CN_API_KEY", KEY_A);

  const switched = await h.call("activateKey", { id: "k2" });
  assert.equal(switched.ok, true);
  assert.equal(switched.value.active.name, "个人号");
  assert.equal(h.store.get("MINIMAX_CN_API_KEY"), KEY_B, "切换 = 改写规范凭据引用");
  assert.equal(registryOf(h).activeId, "k2");

  const status = await h.call("status", {});
  assert.equal(status.value.keys.find((k) => k.id === "k2").active, true);
  assert.equal(status.value.keys.find((k) => k.id === "k1").active, false);
  assert.equal(status.value.activeKey.name, "个人号");
});

test("切换到不存在的 Key：如实报错，不改任何状态", async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  seed(h, [{ id: "k1", name: "公司号", region: "cn", key: KEY_A }], "k1");
  const result = await h.call("activateKey", { id: "nope" });
  assert.equal(result.ok, true);
  assert.equal(result.value.ok, false);
  assert.match(result.value.message, /找不到/);
});

test("换区域切换：上一个区域里本插件写的那份会被收回", async () => {
  const h = harness({ providers: { "minimax-cn": {}, minimax: {} } });
  seed(
    h,
    [
      { id: "k1", name: "国内号", region: "cn", key: KEY_A },
      { id: "k2", name: "国际号", region: "intl", key: KEY_INTL },
    ],
    "k1",
  );
  h.store.set("MINIMAX_CN_API_KEY", KEY_A);

  const switched = await h.call("activateKey", { id: "k2" });
  assert.equal(switched.value.ok, true);
  assert.equal(h.store.get("MINIMAX_API_KEY"), KEY_INTL);
  assert.equal(h.store.has("MINIMAX_CN_API_KEY"), false, "国内那把应当被收回，保证只有一把在用");
  assert.match(switched.value.notice, /国内/);
});

test("同一把 Key 被同时放在两个区域的引用里：登记时清掉另一个（同一把 Key 只能在一个区域用）", async () => {
  const h = harness({ providers: { "minimax-cn": {}, minimax: {} } });
  // 上一版插件可能把同一把 Key 写进了两个引用；它在国际端点必然失败。
  h.store.set("MINIMAX_CN_API_KEY", KEY_A);
  h.store.set("MINIMAX_API_KEY", KEY_A);

  const adopted = await h.call("adoptKey", { name: "公司号" });
  assert.equal(adopted.value.ok, true);
  assert.equal(h.store.get("MINIMAX_CN_API_KEY"), KEY_A, "生效区域的那份要留着");
  assert.equal(h.store.has("MINIMAX_API_KEY"), false, "另一个区域的同一把 Key 要清掉");
  assert.match(adopted.value.notice, /同一把 Key/);
});

test("改名：备注名立刻生效，空名被拒", async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  seed(h, [{ id: "k1", name: "公司号", region: "cn", key: KEY_A }], "k1");

  const renamed = await h.call("renameKey", { id: "k1", name: "  备用号  " });
  assert.equal(renamed.value.ok, true);
  assert.equal(renamed.value.name, "备用号");
  assert.equal(registryOf(h).entries[0].name, "备用号");

  const blank = await h.call("renameKey", { id: "k1", name: "   " });
  assert.equal(blank.value.ok, false);
  assert.match(blank.value.message, /备注名/);
});

test("删除非生效的那把：当前生效的不受影响", async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  seed(
    h,
    [
      { id: "k1", name: "公司号", region: "cn", key: KEY_A },
      { id: "k2", name: "个人号", region: "cn", key: KEY_B },
    ],
    "k1",
  );
  h.store.set("MINIMAX_CN_API_KEY", KEY_A);

  const deleted = await h.call("deleteKey", { id: "k2" });
  assert.equal(deleted.value.ok, true);
  assert.equal(deleted.value.wasActive, false);
  assert.equal(deleted.value.stillActive, false);
  assert.equal(h.store.get("MINIMAX_CN_API_KEY"), KEY_A, "生效的那把不能被动");

  const status = await h.call("status", {});
  assert.equal(status.value.keys.length, 1);
  assert.equal(status.value.keys[0].id, "k1");
});

test("删除生效的那把：规范凭据引用里那份也收回来", async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  seed(h, [{ id: "k1", name: "公司号", region: "cn", key: KEY_A }], "k1");
  h.store.set("MINIMAX_CN_API_KEY", KEY_A);

  const deleted = await h.call("deleteKey", { id: "k1" });
  assert.equal(deleted.value.ok, true);
  assert.equal(deleted.value.wasActive, true);
  assert.equal(deleted.value.stillActive, false);
  assert.equal(h.store.has("MINIMAX_CN_API_KEY"), false, "生效的那份也要收回");

  const status = await h.call("status", {});
  assert.equal(status.value.keys.length, 0);
  assert.equal(status.value.activeKey, null);
});

test("删除生效的那把但环境变量还在：如实说「仍然生效」", async () => {
  const h = harness({
    providers: { "minimax-cn": {} },
    envKeys: { MINIMAX_CN_API_KEY: "env-provided-key-000000" },
  });
  seed(h, [{ id: "k1", name: "公司号", region: "cn", key: KEY_A }], "k1");
  h.store.set("MINIMAX_CN_API_KEY", KEY_A);

  const deleted = await h.call("deleteKey", { id: "k1" });
  assert.equal(deleted.value.stillActive, true);
  assert.match(deleted.value.message, /环境变量/);
});

test("登记：把当前生效但没登记的 Key 收进名册并起名", async () => {  const h = harness({ providers: { "minimax-cn": {} } });
  h.store.set("MINIMAX_CN_API_KEY", KEY_A);

  const before = await h.call("status", {});
  assert.equal(before.value.keys.length, 0);
  assert.equal(before.value.activeKey.registered, false);
  assert.equal(before.value.activeKey.name, "外部设置的 Key");

  const adopted = await h.call("adoptKey", { name: "老 Key" });
  assert.equal(adopted.value.ok, true);
  assert.equal(adopted.value.entry.name, "老 Key");
  assert.equal(adopted.value.active.id, adopted.value.entry.id);

  const after = await h.call("status", {});
  assert.equal(after.value.keys.length, 1);
  assert.equal(after.value.keys[0].name, "老 Key");
  assert.equal(after.value.activeKey.registered, true);
  assert.equal(after.value.activeKey.name, "老 Key");
  assert.equal(after.value.mismatch, false);
});

test("名册与实际生效的 Key 对不上时，如实报 mismatch", async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  seed(h, [{ id: "k1", name: "公司号", region: "cn", key: KEY_A }], "k1");
  // 有人在「设置 → 模型」里把 Key 换掉了。
  h.store.set("MINIMAX_CN_API_KEY", KEY_B);

  const status = await h.call("status", {});
  assert.equal(status.value.mismatch, true);
  assert.equal(status.value.activeKey.registered, false, "生效的那把不在名册里");
  assert.equal(status.value.activeKey.hint, "••••" + KEY_B.slice(-4));
});

test("没有生效的 Key 时，登记端点如实报错", async () => {
  const h = harness({ providers: { "minimax-cn": {} } });
  const adopted = await h.call("adoptKey", {});
  assert.equal(adopted.value.ok, false);
  assert.match(adopted.value.message, /没有生效的 Key/);
});
