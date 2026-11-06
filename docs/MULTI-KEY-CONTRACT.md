# 多 API Key 契约（宿主半边 ↔ 浏览器半边）

> 这份文档是**两边共同的唯一事实来源**。宿主半边（`lib/index.js`）与浏览器半边
> （`lib/client.js`）都按这里写的字段名与语义实现；改动任何一边都必须同步这份文档。

## 0. 目标（用户原话）

> 设置里有一项 minimax 的版块，其中可以添加 api key 的功能，当前是输入了一个 api key 便会把
> 前一个 api key 覆盖掉，我需要你做一个可以保存多个 api key 且可以选取当前使用哪个的切换按钮
> （最多只能启动一个），再添加可自定义备注名称的功能方便我知道当前用的是哪一个 api key。

落点：**「设置 → MiniMax」页面**。保存多把 Key → 每把一个自定义备注名 → 用一个切换按钮
选出「当前使用的那一把」，同一时间最多一把生效。

## 1. 传输（不变）

- RPC 频道：`/llm-minimax`（常量 `CHANNEL`，宿主与浏览器各定义一份同名常量）。
- 调用：`connection.rpc.call(CHANNEL, endpoint, payload)`。
- 信封：成功 `{ ok: true, value }`；失败 `{ ok: false, error: { code, message } }`。
  **任何端点都不抛异常**，失败一律走 `ok:false`。

## 2. 宿主内部数据模型

凭据库里多存一份「Key 名册」，引用名固定为 **`MINIMAX_KEY_RING`**，值是一个 JSON 字符串：

```json
{
  "version": 1,
  "entries": [
    {
      "id": "k3f9a2c1",
      "name": "公司号",
      "region": "cn",
      "key": "sk-cp-xxxxxxxx",
      "kind": "plan",
      "createdAt": 1760000000000
    }
  ],
  "activeId": "k3f9a2c1"
}
```

规则：

- `region` ∈ `"cn"` | `"intl"`（一把 Key 只在一个区域可用，跨区会被上游 2049 拒绝）。
- `kind`：`"plan"`（`sk-cp-`）/ `"payg"`（`sk-api-`）/ `"unknown"`，与 `catalog.js` 的
  `keyKindOf` 一致。
- `activeId` 指向全局唯一「正在生效」的那一把。**同时最多一把生效。**
- 生效方式：把 `activeId` 那把的 `key` 写进该区域的**规范凭据引用**
  （`cn` → `MINIMAX_CN_API_KEY`，`intl` → `MINIMAX_API_KEY`；若用户在 `llm-pi-ai` 路由上
  自定义了 `apiKeyEnv`，以用户那个为准，见宿主 `credentialRefOf`）。
  MiniMax 模型路由读的就是这个引用，所以「切换」= 改写这个引用。
- 换区域生效时（例如从国内 Key 换到国际 Key），上一个区域引用里由本插件写入的那份会被
  `unset`，保证全局只有一把在用；若上一份来自环境变量（本插件动不了），不删，只在
  `notice` 里如实说明。
- **同一把 Key 只在一个区域有效**（国内与国际不通用）。因此激活 / 登记时，若另一个区域的
  引用里放着的是**同一把 Key**（上一版插件可能把一把 Key 同时写进两个引用），那是必然配不通
  的配置，会被一并清掉，并在 `notice` 里说明。
- 原始 Key 只存在于宿主（凭据库 + 名册），**任何返回给浏览器的字段都不含原始 Key**。

## 3. `status`（扩展原有端点）

原有字段全部保留（`regions` / `models` / `retired` / `settingsAvailable` /
`credentialsAvailable`），新增：

```jsonc
{
  "registryRef": "MINIMAX_KEY_RING",
  // 已登记的 Key（名册里的全部条目，不含原始 Key）
  "keys": [
    {
      "id": "k3f9a2c1",
      "name": "公司号",
      "region": "cn",
      "kind": "plan",
      "hint": "••••1234",
      "createdAt": 1760000000000,
      "active": true            // 是否就是当前生效的那一把
    }
  ],
  // 当前真正生效的那一把（可能不在 keys 里：用户在「设置 → 模型」里直接改过）
  "activeKey": {
    "id": "k3f9a2c1",          // 在 keys 里才有；否则为 null
    "name": "公司号",           // 未登记时给 "外部设置的 Key"
    "region": "cn",
    "kind": "plan",
    "hint": "••••1234",
    "source": "store",         // "store" | "env" | "unknown"
    "registered": true         // 是否已登记进 keys
  },
  // 名册里的 activeId 与实际生效的 Key 对不上（被别处改过 / 名册损坏）
  "mismatch": false
}
```

## 4. 端点一览

### `saveKey`（扩展）

入参：`{ key, region?, name?, activate? }`

- `key`：必填，粘贴的原始 Key（宿主用 `normalizeKey` 规整）。
- `region`：`"cn"` | `"intl"` | `"auto"`（默认 auto：先国内后国际自动识别）。
- `name`：**可选**，自定义备注名。缺省时宿主生成 `MiniMax Key N`（N = 该区域已有条目数 + 1）。
  去掉首尾空白后为空 → 退回默认名。最多 40 个字符，超出截断。
- `activate`：可选，默认 `true`。为 `true` 时保存完立刻设为当前生效。

行为：先按原逻辑校验（`GET /v1/models`）→ 校验通过才写名册 → 若 `activate` 则激活
（写规范凭据引用）→ 保证路由与模型目录就绪。

返回值（`value`）：

```jsonc
{
  "saved": true,
  "region": "cn",
  "provider": "minimax-cn",
  "displayName": "MiniMax 国内",
  "keyHint": "••••1234",
  "keyKind": "plan",
  "credentialRef": "MINIMAX_CN_API_KEY",
  "routeOk": true,
  "routeMessage": undefined,
  "models": ["MiniMax-M3.1-Flash", "MiniMax-M3"],
  "upstreamHasFlash": true,
  "entry": {                   // 名册里新增的条目
    "id": "k3f9a2c1", "name": "公司号", "region": "cn",
    "kind": "plan", "hint": "••••1234", "createdAt": 1760000000000
  },
  "activated": true,           // 是否已经成为当前生效的那一把
  "notice": undefined          // 换区域生效等需要如实说明的情况
}
```

校验失败时：`{ saved: false, message, detail }`（保持原有语义，什么都不写）。

### `activateKey`（新）

入参：`{ id }`（名册条目 id）。

行为：把该条目的 Key 写进它所在区域的规范凭据引用 → 名册 `activeId` 指向它 → 作废额度缓存。

返回值：

```jsonc
{
  "ok": true,
  "active": { "id": "k3f9a2c1", "name": "公司号", "region": "cn", "kind": "plan", "hint": "••••1234" },
  "notice": "已切换到「公司号」。国际路由将不再有可用 Key。"
}
```

找不到 id：`{ ok: false, message: "找不到这把 Key" }`。

### `renameKey`（新）

入参：`{ id, name }`。行为：改名册里的备注名（规整同上：去空白、空则退回默认名、≤40 字）。

返回值：`{ ok: true, id, name }` / `{ ok: false, message }`。

### `deleteKey`（新）

入参：`{ id }`。

行为：从名册里删除该条目；若它是当前生效的那一把 → `unset` 规范凭据引用（仅限本插件
写进去的那层，环境变量那层动不了，要如实说明）。

返回值：

```jsonc
{
  "ok": true,
  "deleted": true,
  "wasActive": true,
  "stillActive": false,        // 环境变量那层还在 → true
  "message": "已删除「公司号」。"
}
```

### `adoptKey`（新）

入参：`{ name? }`。行为：把**当前实际生效**的那把 Key（规范凭据引用里的值）登记进名册，
并设为生效。用于「用户在「设置 → 模型」页里直接改了 Key」的情况。

返回值：`{ ok: true, entry: {...}, active: {...} }` / `{ ok: false, message }`。
当前没有生效的 Key 时：`{ ok: false, message: "当前没有生效的 Key" }`。

### `clearKey`（保留原有语义，扩展）

入参：`{ region }`（`"cn"` | `"intl"`）。行为：删掉该区域规范凭据引用里由本插件写入的那份，
若它在名册里也一并删除。

返回值沿用原有字段：`{ cleared, region, removedFromStore, stillActive, source, message }`。

### `testKey`（扩展）

入参：`{ region? }` 或 `{ id? }`。

- 给 `id`：测试名册里那把（不必是生效的那把）。
- 给 `region` 或都不给：测试该区域当前生效的那把（原有行为）。

返回值：`{ ok: true, message, models }` / `{ ok: false, message }`（原有语义）。

### `quota`（扩展）

原有字段全部保留，新增 `keyName`（当前生效那把的备注名；未登记时为
`"外部设置的 Key"`）—— 输入框工具栏的小标记用它显示「现在用的是哪一把」。

### `sync`（不变）

原有行为：把模型目录对齐到当前版本。

## 5. 浏览器半边要做的事

在「设置 → MiniMax」页面里，把原来的「API Key」卡片（单个输入框 + 存/删/测）换成：

1. **当前生效**：一行摘要 —— 备注名、区域、末 4 位、类型（M Plan / 按量付费）、来源
   （本插件保存 / 环境变量）。出现下面任一情况时给出「登记 / 补救」入口：
   - `mismatch === true`：当前生效的 Key 与名册记录不一致（被别处改过）→ 警示 + 两个按钮：
     「登记为新的一把」（`adoptKey`，可填备注名）与「用名册里的那把覆盖回去」（`activateKey`）。
   - `activeKey.registered === false`：当前生效的 Key 不在名册里（名册为空、或它来自环境变量）
     → 同样要给「登记为新的一把」的入口，否则用户没有任何办法给已经在用的那把 Key 起名。
     ⚠️ 只在 `mismatch` 时提示是不够的：名册为空但确实有一把 Key 在用，是最常见的情况。
2. **Key 列表**：每行 = 切换按钮（radio 语义：当前生效的那把是选中态，其余未选中）+ 备注名
   + 区域标签 + 末 4 位 + 类型标签 + 操作（改名 / 删除）。
   - 备注名可就地编辑：点名字变输入框，回车或「保存」提交 `renameKey`，Esc 取消。
   - 切换按钮点一下即 `activateKey`；切换后立刻刷新列表与摘要。
3. **添加 Key**：备注名输入框（可空，空则由宿主生成）+ Key 输入框（密码框）+ 区域选择
   （自动识别 / 国内 / 国际）+「保存后立即启用」复选框（默认勾选）+ 保存按钮。
4. **额度卡片**：标题里带上当前生效 Key 的备注名。
5. 工具栏小标记（`conversation.input.right`）的 tooltip 里加上当前 Key 的备注名。

浏览器半边**不得**直接读写凭据库，一律走上面的 RPC 端点。

## 6. 既有行为的兼容

- 原来「保存一个 Key 会覆盖上一个」的路径没有了：现在保存 = 新增一条名册记录；
  旧的那把仍在名册里，只是变成「未启用」。
- 已经在用的 Key（升级前就存在规范凭据引用里的）不会丢：`status` 会把它作为
  `activeKey` 报出来（`registered:false`），用户可以「登记为新的一把」给它起名字。
- `clearKey` / `testKey` / `quota` / `sync` 的原有语义与返回字段保持不变（只做加法）。
