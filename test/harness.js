/**
 * 测试用的宿主替身：用假的 settings / credentials / connection 服务驱动真实的 apply()。
 *
 * 单独成文件，host.test.js（端到端 / 联网）与 multikey.test.js（多 Key 离线）共用。
 */
import assert from "node:assert/strict";

import { apply, CHANNEL } from "../lib/index.js";

export function harness({ providers = {}, rpcHandleBroken = false, envKeys: initialEnv = {} } = {}) {
  const store = new Map();
  const envKeys = new Map(Object.entries(initialEnv));
  const state = { providers: structuredClone(providers), revision: 1, mutations: [] };
  const listeners = new Map();
  let rpcHandler;
  /** 通过 webServer 注册的路由（回退路径或 rpc.handle 的真实实现都会走这里）。 */
  const routes = [];

  const settings = {
    describe() {
      return [{ ns: "include:llm-pi-ai", value: { providers: structuredClone(state.providers) }, revision: state.revision }];
    },
    async mutate(ns, ops, revision) {
      assert.equal(ns, "include:llm-pi-ai");
      assert.equal(revision, state.revision, "写入必须带上 describe 给出的 revision");
      for (const op of ops) {
        assert.equal(op.op, "set");
        const [root, provider, field] = op.path;
        assert.equal(root, "providers");
        state.providers[provider] ??= {};
        state.providers[provider][field] = structuredClone(op.value);
      }
      state.mutations.push(ops);
      state.revision += 1;
      // 真实宿主在表单值变化后向所有人广播 settings/document-updated(ns, revision)。
      for (const fn of listeners.get("settings/document-updated") ?? []) fn(ns, state.revision);
      // 这个事件 Loader 只发给配置所属的 fiber（pi-ai 自己），本插件收不到；模拟也不发。
    },
  };
  const credentials = {
    // 模拟真实凭据服务的两层结构：库里没有时回落到 `env`（环境变量 / .env）。
    async resolve(ref) {
      if (store.has(ref)) return { value: store.get(ref), source: "store" };
      if (envKeys.has(ref)) return { value: envKeys.get(ref), source: "env" };
      return undefined;
    },
    async describe(ref) {
      const configured = store.has(ref) || envKeys.has(ref);
      return {
        configured,
        source: store.has(ref) ? "store" : envKeys.has(ref) ? "env" : undefined,
        writable: true,
      };
    },
    async set(ref, value) {
      store.set(ref, value);
    },
    async unset(ref) {
      store.delete(ref);
    },
  };
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  // 模拟真实宿主：rpc.handle 的实现是 `owner.webServer.register(route)`，owner 是调用方的
  // scope。所以 handle 必须以 scope 为 this 调用，且 scope 里必须有 webServer，否则抛错 ——
  // 这正是线上出现 HTTP 405 的原因（只 inject 了 connection）。
  function makeConnection(owner) {
    return {
      rpc: {
        handle(channel, handler) {
          assert.equal(channel, CHANNEL);
          if (rpcHandleBroken) throw new Error("rpc.handle 在这个版本上不可用");
          if (owner.webServer === undefined) {
            throw new Error('cannot get required service "webServer" in inject');
          }
          rpcHandler = handler;
          owner.webServer.register({ kind: "prefix", path: channel, handler: "rpc.handle" });
          return () => {};
        },
      },
      requestRejection(req) {
        return req.headers["x-test-auth"] === "ok" ? undefined : 401;
      },
    };
  }
  const services = { settings, credentials, webServer };
  const emitted = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]) },
    get: (key) => services[key],
    emit: (name) => emitted.push(name),
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    effect: (fn) => fn(),
    inject(keys, fn) {
      const scope = { on: ctx.on, effect: ctx.effect };
      for (const key of keys) {
        scope[key] = key === "connection" ? makeConnection(scope) : services[key];
      }
      fn(scope);
    },
  };
  apply(ctx, {});
  const call = (endpoint, payload) => {
    assert.ok(rpcHandler !== undefined || routes.length > 0, "RPC 频道没有注册上");
    if (rpcHandler !== undefined) return rpcHandler(endpoint, payload, new AbortController().signal, {});
    return viaFallback(routes[0], endpoint, payload);
  };
  return { call, state, store, envKeys, emitted, logs, routes, connection: makeConnection({ webServer }) };
}

/** 用一个假的 IncomingMessage / ServerResponse 驱动回退路由，返回解析后的 result。 */
export async function viaFallback(route, endpoint, payload, { auth = "ok", rpcId = "r1" } = {}) {
  const body = Buffer.from(JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload }));
  const req = {
    method: "POST",
    url: `${CHANNEL}/${endpoint}`,
    headers: { "content-type": "application/json", "x-test-auth": auth },
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.body = text ?? "";
    },
  };
  await route.handler(req, res);
  if (res.status !== 200) return { httpStatus: res.status, text: res.body };
  const envelope = JSON.parse(res.body);
  assert.equal(envelope.type, "server-response");
  assert.equal(envelope.rpcId, rpcId);
  return envelope.result;
}
