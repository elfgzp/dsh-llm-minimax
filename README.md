# dsh-llm-minimax

把 **MiniMax 官方开放平台**（api.minimaxi.com / api.minimax.io）的模型放进 DeepSeek Harness 的模型选择列表，Key 直接在设置页里填，并显示套餐额度。

## 安装

需要 DeepSeek Harness 0.2.x。

> **升级插件后需要重启 DSH**。主机不会热重载宿主插件的代码：不重启的话，新版本里的
> 工具与 provider 不会生效。
**在 Web 界面里装**：侧边栏 → **插件** → **添加插件** → **安装第三方插件**，粘贴仓库地址：

```
https://github.com/elfgzp/dsh-llm-minimax
```

确认后在「已安装插件」里打开 **MiniMax 模型**。

**让 agent 装**：在开启了插件管理工具的会话里说

> 从 https://github.com/elfgzp/dsh-llm-minimax 安装这个插件并启用

**命令行**：

```sh
dsh plugin --profile <profile> add "github:elfgzp/dsh-llm-minimax#main"
```

## 用法

1. 打开 **设置 → MiniMax**。
2. 在「添加 Key」里粘贴 Key（可先填一个**备注名**，例如「公司号」），点 **校验并保存**。区域默认自动识别（先试国内，再试国际）。
3. 回到对话，在输入框的模型选择器里选 **MiniMax 国内 → MiniMax-M3.1-Flash**（或 MiniMax-M3）。

不用改配置文件，也不用重启。

保存时插件依次做这些事，任一步失败就什么都不写：

- 用 `GET /v1/models` 校验 Key，确定它属于国内还是国际；
- 把 Key 存进本机凭据库 `$DSH_HOME/.credentials.yaml`，引用名是 `MINIMAX_CN_API_KEY` / `MINIMAX_API_KEY`（与「设置 → 模型」页用的是同一个）；
- 在 `llm-pi-ai` 里启用对应路由（`minimax-cn` / `minimax`），写入当前模型目录。

Key 只在宿主进程里流转，浏览器只拿回末 4 位。

## 多把 Key 与备注名

一把 Key 覆盖另一把会让「换号」变得很麻烦：想在两个 MiniMax 账号之间来回切，只能先把
当前的删掉或覆盖掉。所以设置页不再只有一个输入框，而是一份**可以保存多把 Key 的名册**：

| 操作 | 在「设置 → MiniMax」里怎么做 | 背后发生了什么 |
|---|---|---|
| 保存一把新 Key | 「添加 Key」卡片：填**备注名**（如「公司号」）+ Key，选区域（默认自动识别），可取消「保存后立即启用」 | 校验通过后写进凭据库里的**名册**（引用名 `MINIMAX_KEY_RING`），并按需把它设为当前生效的那一把。**上一把不会被覆盖**，只是变成「未启用」 |
| 切换当前用哪一把 | Key 列表每行左边的切换按钮（radio 语义） | 把这一把的 Key 写进该区域的规范凭据引用（`MINIMAX_CN_API_KEY` / `MINIMAX_API_KEY`）—— 模型路由读的就是那里，所以切换立刻生效，**同一时间只有一把在用** |
| 改备注名 | 点列表里的名字就地编辑，回车保存 | 只改名册里的名字，不动 Key |
| 删掉一把 | 每行的「删除」 | 从名册移除；如果删的是当前生效的那一把，规范凭据引用里本插件写的那份也会收回 |

规则与边界：

- **名册存在凭据库里**（引用名 `MINIMAX_KEY_RING`），原始 Key 从不离开宿主进程；
  浏览器只拿得到末 4 位和备注名。
- **一把 Key 只在一个区域有效**（国内 Key 打国际端点会被上游拒绝），所以备注名之外还会
  显示它属于「MiniMax 国内」还是「MiniMax 国际」。
- 换区域切换时，上一个区域里**由本插件写入**的那份会被收回；如果那边留的是环境变量里的
  Key，插件动不了，会如实说明，不会谎报「已删除」。
- 如果当前生效的 Key 不是本插件登记的（例如你直接在「设置 → 模型」里改过），页面会显示
  一条提示，并提供「登记为新的一把」（给它起个备注名）与「用名册里的那把覆盖回去」。
- 额度读的是**当前生效的那一把**；输入框工具栏的小标记里也会带上它的备注名。

宿主与浏览器两边的字段契约写在 [`docs/MULTI-KEY-CONTRACT.md`](docs/MULTI-KEY-CONTRACT.md)，
名册的纯数据层在 `lib/registry.js`（不碰宿主、不联网，因此单测不需要宿主）。

## 输入框工具栏

选中官方 MiniMax 模型（`minimax-cn` / `minimax` 路由）时，模型选择器左边会出现两个控件：

| 控件 | 含义 |
|---|---|
| `▣ 1M` | 上下文预算。点开可选 200K / 512K / 1M。悬停看说明 |
| `● MiniMax 62%` | 套餐额度。悬停看 5 小时与每周窗口的剩余与重置时间 |

**只对官方 MiniMax 路由生效。** 换成别的模型（腾讯内网、DeepSeek、GLM…）这两个控件会完全消失，不影响任何其它模型 —— 因为上下文预算是「模型条目」的属性，而不是会话属性：DSH 的 `selectModel` 只接受 `{provider, model, reasoningEffort}`，没有按会话设置上下文这一说。

注意模型选择器里可能出现两个 MiniMax：一个带 `x0.08` 倍率（腾讯内网网关转发的），一个在 `minimax-cn` 分组下（官方 API）。**控件只在后者出现**，因为上下文预算改的是官方路由的模型目录。

## 为什么需要这个插件

DSH 自带的 `@deepseek-ai/dsh-llm-pi-ai` 已经有 `minimax-cn` 和 `minimax` 两条路由（Anthropic Messages 协议），所以本插件**不实现模型适配器**，只补它缺的部分：

| 问题 | DSH 自带 | 本插件 |
|---|---|---|
| 模型目录 | MiniMax-M3、M2.7、M2.7-highspeed | **MiniMax-M3.1-Flash**、MiniMax-M3；不写已退役的 M2.x |
| 思考档位 | 目录外模型走预算式思考，选择器档位不生效 | 打开 `forceAdaptiveThinking`，档位以 `output_config.effort` 发出 |
| M3.1-Flash 的「关闭思考」 | — | 不提供：该模型关闭思考会返回 400 |
| 填 Key | 要先在「设置 → 模型」添加提供商 | 设置页直接填，自动识别区域；可保存多把并切换 |
| 额度 | 无 | M Plan / Token Plan 的 5 小时与每周窗口 |

你在「设置 → 模型」里给这条路由加的其它模型会保留；路由上的 `baseURL`、`retryPolicy`、`headers` 等字段插件不会改。之后该路由的配置每次变化，插件都会检查目录，有缺项就补回去。

## 额度

| Key 类型 | 显示内容 |
|---|---|
| M Plan / Token Plan 订阅 Key（`sk-cp-`，或有订阅的账号 Key） | 各用量桶的区间窗口（文本 5 小时、视频 24 小时，按接口返回的起止时间计算）和每周窗口：剩余百分比与重置倒计时 |
| 按量付费 Key（`sk-api-`） | 说明 MiniMax 不提供余额查询接口，附控制台链接；不显示任何数字 |

额度来自 `GET /v1/token_plan/remains`，每分钟刷新一次。这个接口出错时也返回 HTTP 200，插件按 `base_resp.status_code` 判断结果：`2062` 表示没有生效中的订阅，`1004` / `2049` 表示 Key 被拒或区域不对。

输入框工具栏的小标记只在有套餐窗口时出现，显示文本 5 小时窗口的剩余百分比；鼠标悬停显示所有窗口。

## 模型

| 模型 | 上下文 | 默认最大输出 | 思考 |
|---|---|---|---|
| MiniMax-M3.1-Flash | 1,000,000 | 131,072（上限 524,288） | 始终思考；深度可选 low … max |
| MiniMax-M3 | 1,000,000 | 131,072（上限 524,288） | 自适应；可选关闭或 low … max |

M2.5 / M2.7 系列于 2026-11-18 退役。M Plan 下旧名字会自动路由到 M3.1 Flash，按量付费请求退役后会失败。

## 多模态工具

除了聊天模型，本插件还注册了六个 **MiniMax 专用的模型工具**，让 agent 用同一把 Key 直接调用
MiniMax 的多模态与联网能力。它们在「有生效的 Key」时才出现在模型面前；没有 Key 就不该让模型
反复调用然后拿到一句「尚未设置 API Key」。

| 工具 | 能力 | 官方端点 |
|---|---|---|
| `minimax_search` | 联网搜索：模型在 MiniMax 服务端自己检索并作答，回传整理好的答案与来源网址 | `POST /anthropic/v1/messages`（服务端工具 `web_search_20250305`） |
| `minimax_generate_image` | 文生图 / 图生图（1–16 张参考图），落地成图片文件 | `POST /v1/images/generations`、`POST /v1/images/edits` |
| `minimax_generate_video` | 视频生成，支持首帧 / 尾帧，内部轮询到终态 | `POST /v2/video_generation` |
| `minimax_video_status` | 查视频任务状态；已完成时直接下载 mp4 | `GET /v2/query/video_generation/{task_id}` |
| `minimax_speak` | 语音合成，落地成 mp3（单次 1 万字） | `POST /v1/t2a_v2` |
| `minimax_speak_long` | 长文本语音合成（单次 10 万字 / 总量 100 万字），异步建任务并抓回音档 | `POST /v1/t2a_async_v2` + `GET /v1/query/t2a_async_query_v2` |
| `minimax_speak_status` | 查异步语音任务；已完成时把音档抓回本地 | `GET /v1/query/t2a_async_query_v2` |
| `minimax_transcribe` | 语音识别（asr-1.0），可输出逐字稿、说话人分段、srt/vtt 字幕 | `POST /v1/speech_to_text` |
| `minimax_voices` | 列出可用音色（系统 / 复刻 / 文生） | `POST /v1/get_voice` |
| `minimax_clone_voice` | 用自己的音频复刻出一个音色 | `POST /v1/files/upload` + `POST /v1/voice_clone` |
| `minimax_design_voice` | 用文字描述设计一个新音色 | `POST /v1/voice_design` |
| `minimax_upload_file` | 上传文件换取 `mm_file://{file_id}` 引用（保存 7 天） | `POST /v1/files/upload` |
| `minimax_video_tasks` | 列出最近 7 天的视频生成任务，可按状态/模型/类型筛选 | `GET /v2/query/video_generation` |
| `minimax_video_cancel` | 取消排队中的任务（不扣费）或删除已结束的记录 | `DELETE /v2/video_generation/{task_id}` |

支持的模型：

- 图像：`MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed`
- 视频：`MiniMax-H3`（支持 768P / 2K）、`MiniMax-H3-Highspeed`、`MiniMax-H3-Lite`、`MiniMax-H3-Max`
- 语音：`speech-2.8-hd`、`speech-2.8-turbo`、`speech-2.6-hd`、`speech-2.6-turbo`、`speech-02-hd`、`speech-02-turbo`
- 识别：`asr-1.0`

产物落在**调用它的那个会话的工作目录**里，工具返回绝对路径。

### 音色复刻与设计的前置条件

- `minimax_clone_voice` **要求账号已完成个人或企业认证**，否则返回 `voice clone user forbidden`。
- 复刻出的音色是**临时音色**：7 天内没有被正式用于语音合成就会被删除。
- `minimax_design_voice` 在部分订阅档位下不可用（会返回「token plan not support model, preview_text」）。

### 两代端点的错误形状不同

- 语音、文件这批**旧世代**端点固定返回 HTTP 200，失败写在 `base_resp.status_code`
  （1004 鉴权失败、1002 限流、2013 参数错、1008 余额不足）。
- 语音识别与视频 V2 这批**新世代**端点用真实 HTTP 状态码，body 是 OpenAI 风格的 `error`。

插件两种都认，并把错误码翻译成人能读的句子。

### 为什么联网搜索要自己实现

底层的 `pi-ai` 在 Anthropic 协议下只会生成 **client tool**（`{name, description, input_schema}`），
无法透传 MiniMax 的**服务端工具**。所以 `minimax_search` 直接打 Anthropic 兼容端点，把
`server_tool_use` 与 `web_search_tool_result` 两种内容块收敛成「答案 + 来源列表」。

这条路径**不依赖 DeepSeek 账号余额**——DSH 内置的 `web_search` 走的是 DeepSeek 的
`/v1/tools/search`，余额不足时会直接失败。

### 接管原生 web_search

本插件还把 MiniMax 注册成 DSH 的联网搜索 provider，并把 `web.searchProvider` 指向它，
**原生 `web_search` 工具因此改走 MiniMax**，不再需要 DeepSeek 余额。

规则：

- 只有在你**没有自己指定过** `web.searchProvider` 时才接管；明确的设置永远优先。
- `web.searchProvider` 是 volatile 字段，只在运行时生效，不写进 profile patch，
  所以每次启动由本插件重新设定。
- 不想接管就把插件配置 `disableWebSearchTakeover` 设成 `true`（默认 `false`，即接管）。

接管状态会写到 `~/.dsh/minimax-native-search.json`（Windows 下是
`C:\Users\<你>\.dsh\minimax-native-search.json`），里面会写明当前主���跑的是哪个版本、
provider 有没有注册成功、以及接管走到了哪一步：

```json
{
  "takeover": true,
  "provider": "minimax",
  "takeoverEnabled": true,
  "providerRegistered": true,
  "pluginVersion": "0.6.2",
  "rawConfig": {},
  "checkedAt": "2026-11-23T07:30:00.000Z"
}
```

> 这个文件用 `~/.dsh` 兜底，而不是只依赖 `$DSH_HOME` 环境变量 —— 主机进程不一定带这个
> 变量，只靠它会把采样与状态写到不存在的路径，而且因为写入被静默吞掉，看起来一切正常，
> 实际上每分钟的用量采样从来没落地过。

### 两条硬约束

1. **图像接口不支持幂等**：请求发出后，即使客户端超时或断开，服务端仍会完成生成并对成功的图片
   计数费，重试会重新生成并重复计费。因此本插件**不做自动重试**，超时就是超时，如实回报。
2. **图像接口服务端最长等待 600 秒**，客户端超时必须不低于 600 秒，否则会出现「已计费但没拿到
   图片」。插件设 660 秒。

### 音乐

MiniMax 的音乐生成（`music-3.0` 等）自 2026-08-20 起不再面向新用户提供服务，本插件不提供该工具。

### 没有做进去的 Matrix 专属能力

MiniMax Code 桌面客户端还有一个 Matrix 网关（`agent.minimax.cn`），额外提供**去背**、
**图片增强**、**图片搜索**与**反向搜图**。这些能力走的是客户端的登录态（Matrix OAuth token），
不是开放平台的 API Key；本机那份 token 早已过期，且 `~/.minimax/mcp/mcp.json` 指向的
`matrix-mcp-cli` 并不存在。因此本插件**不包含**这四项，避免依赖一个跑不起来的通路。

## 测试

```sh
node --test test/                                          # 离线
MINIMAX_TEST_KEY="<你的 Key>" node --test test/            # 加上对真实 MiniMax 接口的端到端测试
```

## 已知限制

- 按量付费账户的余额和消费只能在 MiniMax 控制台查看，这是 MiniMax 的限制。
- 模型目录是插件内置的。MiniMax 发布新模型后，在「设置 → 模型 → MiniMax 国内 → 模型选项」里手动加一行即可，插件会保留它。
- 多 Key 名册是本插件自己的格式（凭据库里的 `MINIMAX_KEY_RING`），DSH 不认识它；换用别的插件或手动删掉这个引用，名册会回到「只有当前生效的那一把」的状态（Key 本身不会丢）。
