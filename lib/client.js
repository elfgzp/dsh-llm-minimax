/**
 * dsh-llm-minimax —— 浏览器半边。
 *
 *   1. 设置 → MiniMax：**管理多把 API Key**（每把一个自定义备注名，用一个切换按钮选出
 *      当前生效的那一把，同一时间最多一把生效），看模型目录、上下文大小与套餐额度。
 *      不需要去改任何配置文件。
 *   2. 输入框工具栏的小标记：上下文大小控件 + 有套餐额度时显示文本 5 小时窗口的剩余百分比。
 *   3. 「设置 → 模型」里 MiniMax 卡片下方的一行说明，指回本页。
 *
 * 不实现模型选择器：DSH 的选择器本来就按 provider 分组渲染，`minimax-cn` 路由存在且目录
 * 正确，它就会出现在列表里。Key 只经由宿主写进凭据库，浏览器只拿回末 4 位。
 *
 * 所有写操作只走 `docs/MULTI-KEY-CONTRACT.md` 里约定的 RPC 端点（saveKey / activateKey /
 * renameKey / deleteKey / adoptKey / clearKey / testKey / sync），永远不抛异常，失败一定要
 * 让用户看见。
 */

window.__ModuleLoader__.load({
  id: "dsh-llm-minimax",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const CHANNEL = "/llm-minimax";
    const POLL_MS = 60_000;
    const QUOTA_EVENT = "dsh-llm-minimax:changed";

    // ---------- RPC ----------

    /** 统一返回 `{ ok: true, value }` 或 `{ ok: false, message }`，从不抛。 */
    function call(api, endpoint, payload) {
      const rpc = api && api.connection && api.connection.rpc;
      if (!rpc || typeof rpc.call !== "function") {
        return Promise.resolve({ ok: false, message: "与宿主的连接不可用" });
      }
      return rpc.call(CHANNEL, endpoint, payload === undefined ? {} : payload).then(
        function (result) {
          if (result && result.ok === true) return { ok: true, value: result.value };
          const error = result && result.error;
          return { ok: false, message: (error && error.message) || "请求失败" };
        },
        function (error) {
          return { ok: false, message: (error && error.message) || String(error) };
        }
      );
    }

    /** Key 保存 / 清除后通知页面里其它部件（工具栏标记）立即刷新。 */
    function announceChange() {
      window.dispatchEvent(new CustomEvent(QUOTA_EVENT));
    }

    // ---------- 数据 hooks ----------

    function useQuota(api, region) {
      const [quota, setQuota] = React.useState(null);
      const [pending, setPending] = React.useState(false);
      const alive = React.useRef(true);

      const load = React.useCallback(
        function (force) {
          setPending(true);
          return call(api, "quota", { region: region, force: force === true }).then(function (result) {
            if (!alive.current) return;
            setPending(false);
            if (result.ok) setQuota(result.value);
          });
        },
        [api, region]
      );

      React.useEffect(
        function () {
          alive.current = true;
          void load(false);
          const timer = window.setInterval(function () {
            if (document.visibilityState === "visible") void load(false);
          }, POLL_MS);
          const onChange = function () {
            void load(true);
          };
          window.addEventListener(QUOTA_EVENT, onChange);
          return function () {
            alive.current = false;
            window.clearInterval(timer);
            window.removeEventListener(QUOTA_EVENT, onChange);
          };
        },
        [load]
      );

      return { quota: quota, pending: pending, reload: load };
    }

    function useStatus(api) {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const reload = React.useCallback(
        function () {
          return call(api, "status", {}).then(function (result) {
            if (result.ok) {
              setStatus(result.value);
              setError(null);
            } else {
              setError(result.message);
            }
          });
        },
        [api]
      );
      React.useEffect(
        function () {
          void reload();
          const onChange = function () {
            void reload();
          };
          window.addEventListener(QUOTA_EVENT, onChange);
          return function () {
            window.removeEventListener(QUOTA_EVENT, onChange);
          };
        },
        [reload]
      );
      return { status: status, error: error, reload: reload };
    }

    // ---------- 样式（只用宿主主题 token） ----------

    const C = {
      text: "var(--dsw-alias-label-primary)",
      sub: "var(--dsw-alias-label-secondary)",
      border: "var(--dsw-alias-border-l1)",
      borderStrong: "var(--dsw-alias-border-l2)",
      layer: "var(--dsw-alias-bg-layer-1)",
      layer2: "var(--dsw-alias-bg-layer-2)",
      brand: "var(--dsw-alias-brand-primary)",
      ok: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      error: "var(--dsw-alias-state-error-primary)",
      idle: "var(--dsw-alias-state-idle-primary)",
    };

    const S = {
      page: { display: "flex", flexDirection: "column", gap: 16, color: C.text, fontSize: 13, lineHeight: 1.5 },
      intro: { color: C.sub, fontSize: 13 },
      card: {
        border: "1px solid " + C.border,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        background: C.layer,
      },
      head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
      title: { fontSize: 14, fontWeight: 600 },
      sub: { color: C.sub, fontSize: 12 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 },
      row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      input: {
        flex: "1 1 260px",
        minWidth: 0,
        height: 32,
        padding: "0 10px",
        borderRadius: 8,
        border: "1px solid " + C.borderStrong,
        background: C.layer2,
        color: C.text,
        fontSize: 13,
        outline: "none",
      },
      select: {
        height: 32,
        padding: "0 8px",
        borderRadius: 8,
        border: "1px solid " + C.borderStrong,
        background: C.layer2,
        color: C.text,
        fontSize: 13,
      },
      primary: {
        height: 32,
        padding: "0 14px",
        borderRadius: 8,
        border: "1px solid " + C.brand,
        background: C.brand,
        color: "#fff",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
      },
      button: {
        height: 28,
        padding: "0 10px",
        borderRadius: 8,
        border: "1px solid " + C.borderStrong,
        background: "transparent",
        color: C.text,
        fontSize: 12,
        cursor: "pointer",
      },
      link: { color: C.brand, fontSize: 12, textDecoration: "none" },
      dot: function (color) {
        return { width: 8, height: 8, borderRadius: 999, background: color, flex: "none", display: "inline-block" };
      },
      track: { height: 6, borderRadius: 999, background: C.layer2, overflow: "hidden", border: "1px solid " + C.border },
      // 名册里的标签（区域 / 计费类型 / 来源）
      tag: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        borderRadius: 6,
        border: "1px solid " + C.border,
        color: C.sub,
        fontSize: 11,
        whiteSpace: "nowrap",
      },
      // 单选语义的切换按钮（radio 外观）
      radio: {
        width: 16,
        height: 16,
        borderRadius: 999,
        border: "1px solid " + C.borderStrong,
        background: "transparent",
        padding: 0,
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      },
      radioOn: { border: "1px solid " + C.brand, background: C.brand },
      radioMark: { width: 6, height: 6, borderRadius: 999, background: "#fff" },
      // 备注名（可就地编辑）
      nameBtn: {
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 6,
        padding: "1px 6px",
        color: C.text,
        fontSize: 13,
        fontWeight: 600,
        textAlign: "left",
        cursor: "pointer",
      },
      check: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: C.text,
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
    };

    function disabledStyle(style, disabled) {
      return disabled ? Object.assign({}, style, { opacity: 0.55, cursor: "default" }) : style;
    }

    function colorForRemaining(remaining) {
      if (typeof remaining !== "number") return C.idle;
      if (remaining <= 10) return C.error;
      if (remaining <= 30) return C.warn;
      return C.ok;
    }

    function countdown(resetsAt) {
      if (typeof resetsAt !== "number") return "";
      const ms = resetsAt - Date.now();
      if (!(ms > 0)) return "即将重置";
      const minutes = Math.floor(ms / 60000);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const rest = minutes % 60;
      if (days > 0) return days + " 天 " + hours + " 小时后重置";
      if (hours > 0) return hours + " 小时 " + rest + " 分后重置";
      return Math.max(1, rest) + " 分钟后重置";
    }

    const KEY_KIND_LABEL = { plan: "M Plan 订阅 Key", payg: "按量付费 Key", unknown: "账号 Key" };
    const KEY_KIND_SHORT = { plan: "M Plan 套餐", payg: "按量付费", unknown: "未知" };
    const KEY_SOURCE_LABEL = { store: "本插件保存", env: "来自环境变量", unknown: "来源未知" };
    const REGION_LABEL = { cn: "MiniMax 国内", intl: "MiniMax 国际" };

    // ---------- 名册数据的取值助手 ----------

    /** 已登记的 Key 列表（老宿主没有 keys 字段时给空数组）。 */
    function registryKeys(status) {
      return status && Array.isArray(status.keys) ? status.keys : [];
    }

    /** 区域显示名：优先用宿主给的 displayName。 */
    function regionDisplay(status, region) {
      const found = ((status && status.regions) || []).find(function (r) {
        return r.region === region;
      });
      return (found && found.displayName) || REGION_LABEL[region] || region || "";
    }

    /**
     * 当前生效的那一把。
     *
     * 新宿主的 `activeKey` 为 null 就是「没有生效的 Key」；只有宿主根本没这个字段时
     * （老版本）才退化到区域信息，免得整页空掉。
     */
    function activeKeyOf(status) {
      if (!status) return null;
      if (status.activeKey !== undefined) return status.activeKey;
      const regions = status.regions || [];
      for (const region of regions) {
        if (region.credential && region.credential.configured) {
          return {
            id: null,
            name: "外部设置的 Key",
            region: region.region,
            kind: region.keyKind || "unknown",
            hint: region.keyHint || "",
            source: region.fromEnvironment ? "env" : "store",
            registered: false,
          };
        }
      }
      return null;
    }

    // ---------- 部件 ----------

    function Notice(props) {
      if (!props.note) return null;
      const color = props.note.tone === "ok" ? C.ok : props.note.tone === "error" ? C.error : C.warn;
      return h(
        "div",
        { role: "status", style: { fontSize: 12, color: color, display: "flex", flexDirection: "column", gap: 2 } },
        h("span", null, props.note.text),
        props.note.detail ? h("span", { style: { color: C.sub } }, props.note.detail) : null
      );
    }


    /**
     * 备注名就地编辑：点名字变输入框，回车或「保存」提交 renameKey，Esc 取消，
     * 失焦时没改过就取消、改过就提交。
     */
    function KeyNameCell(props) {
      const entry = props.entry;
      const editing = props.editingId === entry.id;
      const [draft, setDraft] = React.useState(entry.name);
      const [saving, setSaving] = React.useState(false);
      const done = React.useRef(false);

      React.useEffect(
        function () {
          if (!editing) return;
          setDraft(entry.name);
          // 每次打开编辑器都把「本次已提交」的标记清掉，否则改过一次之后就再也改不动了。
          done.current = false;
        },
        [editing, entry.name]
      );

      function cancel() {
        if (done.current) return;
        done.current = true;
        setDraft(entry.name);
        props.onEndEdit();
      }

      function commit() {
        if (done.current || saving) return;
        const value = draft.trim();
        if (value.length === 0) {
          // 空名字没有意义（宿主会退回默认名），当作取消。
          cancel();
          return;
        }
        done.current = true;
        setSaving(true);
        void Promise.resolve(props.onRename(entry.id, value)).then(function (ok) {
          setSaving(false);
          if (ok) {
            props.onEndEdit();
          } else {
            done.current = false; // 失败：留在编辑态，让用户改完重试
          }
        });
      }

      if (!editing) {
        return h(
          "button",
          {
            type: "button",
            style: S.nameBtn,
            title: "点击改名（回车提交，Esc 取消）",
            onClick: function () {
              props.onBeginEdit(entry.id);
            },
          },
          entry.name
        );
      }

      return h(
        "span",
        { style: S.row },
        h("input", {
          value: draft,
          autoFocus: true,
          maxLength: 40,
          "aria-label": "备注名",
          style: Object.assign({}, S.input, { flex: "0 1 180px" }),
          onChange: function (event) {
            setDraft(event.target.value);
          },
          onKeyDown: function (event) {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          },
          onBlur: function () {
            if (draft === entry.name) cancel();
            else commit();
          },
        }),
        h(
          "button",
          {
            type: "button",
            style: disabledStyle(S.button, saving),
            disabled: saving,
            // 阻止 mousedown 抢焦点，免得 blur 先于 click 触发、提交两次。
            onMouseDown: function (event) {
              event.preventDefault();
            },
            onClick: commit,
          },
          "保存"
        ),
        h(
          "button",
          {
            type: "button",
            style: S.button,
            onMouseDown: function (event) {
              event.preventDefault();
            },
            onClick: cancel,
          },
          "取消"
        )
      );
    }

    /** 「当前生效」摘要 + 名册与实际不一致时的两条补救入口。 */
    function ActiveKeyCard(props) {
      const status = props.status;
      const active = props.active;
      const [adoptOpen, setAdoptOpen] = React.useState(false);
      const [adoptName, setAdoptName] = React.useState("");
      const [adopting, setAdopting] = React.useState(false);
      // 名册里没有这一把（可能来自环境变量，或在「设置 → 模型」里直接改过）→ 要给登记入口。
      // 只在 mismatch 时提示是不够的：名册为空、但确实有一把 Key 在用，也是常见情况。
      const unregistered = props.mismatch === true || (active !== null && active.registered === false);

      function adopt() {
        if (adopting) return;
        setAdopting(true);
        void Promise.resolve(props.onAdopt(adoptName.trim())).then(function (ok) {
          setAdopting(false);
          if (ok) {
            setAdoptOpen(false);
            setAdoptName("");
          }
        });
      }

      return h(
        "div",
        { style: S.card },
        h(
          "div",
          { style: S.head },
          h("span", { style: S.title }, "当前生效"),
          h("span", { style: S.sub }, "同一时间最多一把生效")
        ),

        active
          ? h(
              "div",
              { style: S.row },
              h("span", { style: S.dot(C.ok) }),
              h("span", { style: { fontWeight: 600 } }, active.name || "外部设置的 Key"),
              h("span", { style: S.tag }, regionDisplay(status, active.region)),
              h("span", { style: S.mono }, active.hint || "—"),
              h(
                "span",
                { style: S.tag, title: KEY_KIND_LABEL[active.kind] || "" },
                KEY_KIND_SHORT[active.kind] || KEY_KIND_SHORT.unknown
              ),
              h("span", { style: S.sub }, KEY_SOURCE_LABEL[active.source] || KEY_SOURCE_LABEL.unknown),
              active.registered === false ? h("span", { style: S.sub }, "未登记") : null
            )
          : h("span", { style: S.sub }, "当前没有生效的 Key。"),

        unregistered
          ? h(
              "div",
              { style: { color: C.warn, fontSize: 12 } },
              props.mismatch
                ? "当前生效的 Key 与名册记录不一致，可能是在「设置 → 模型」里改过的"
                : "当前生效的 Key 还没有登记到名册（可能来自环境变量，或在「设置 → 模型」里改过），可以登记一下并起个备注名。"
            )
          : null,

        unregistered
          ? h(
              "div",
              { style: S.row },
              h(
                "button",
                {
                  type: "button",
                  style: disabledStyle(S.button, adopting),
                  disabled: adopting,
                  onClick: function () {
                    setAdoptOpen(true);
                  },
                },
                "登记为新的一把"
              ),
              props.registryActive
                ? h(
                    "button",
                    {
                      type: "button",
                      style: disabledStyle(S.button, props.busy),
                      disabled: Boolean(props.busy),
                      onClick: function () {
                        void props.onActivate(props.registryActive);
                      },
                    },
                    "用名册里的那把覆盖回去"
                  )
                : null,
              active && active.registered === false && active.source === "store"
                ? h(
                    "button",
                    {
                      type: "button",
                      style: disabledStyle(S.button, props.busy),
                      disabled: Boolean(props.busy),
                      onClick: function () {
                        void props.onClear(active.region);
                      },
                    },
                    "清除凭据库里的这把"
                  )
                : null
            )
          : null,

        adoptOpen
          ? h(
              "div",
              { style: S.row },
              h("input", {
                value: adoptName,
                maxLength: 40,
                "aria-label": "新 Key 的备注名",
                placeholder: "备注名（可留空，由宿主自动命名）",
                style: Object.assign({}, S.input, { flex: "0 1 220px" }),
                onChange: function (event) {
                  setAdoptName(event.target.value);
                },
                onKeyDown: function (event) {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    adopt();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setAdoptOpen(false);
                    setAdoptName("");
                  }
                },
              }),
              h(
                "button",
                {
                  type: "button",
                  style: disabledStyle(S.button, adopting),
                  disabled: adopting,
                  onClick: adopt,
                },
                adopting ? "登记中…" : "确认登记"
              ),
              h(
                "button",
                {
                  type: "button",
                  style: S.button,
                  onClick: function () {
                    setAdoptOpen(false);
                    setAdoptName("");
                  },
                },
                "取消"
              )
            )
          : null
      );
    }

    /** 已登记的 Key 列表：单选语义的切换按钮 + 就地改名 + 启用 / 测试 / 删除。 */
    function KeyListCard(props) {
      const status = props.status;
      const keys = registryKeys(status);
      const checkedId = props.checkedId;
      const effectiveId = props.effectiveId || null;

      return h(
        "div",
        { style: S.card },
        h(
          "div",
          { style: S.head },
          h("span", { style: S.title }, "已保存的 Key"),
          h("span", { style: S.sub }, keys.length > 0 ? keys.length + " 把" : "")
        ),

        keys.length === 0
          ? h("span", { style: S.sub }, "还没有保存任何 Key。")
          : keys.map(function (entry) {
              const checked = entry.id === checkedId;
              // 名册声称生效的那一把，可能并不是实际在用的那把（用户在别处改过 Key）。
              // 这时要分清「当前生效」和「名册选中」，不能混为一谈。
              const effective = effectiveId !== null && entry.id === effectiveId;
              const kind = entry.kind || "unknown";
              return h(
                "div",
                {
                  key: entry.id,
                  style: Object.assign({}, S.row, { justifyContent: "space-between" }),
                },
                h(
                  "div",
                  { style: S.row },
                  h(
                    "button",
                    {
                      type: "button",
                      role: "radio",
                      "aria-checked": checked ? "true" : "false",
                      "aria-label": (checked ? "名册选中：" : "设为当前生效：") + entry.name,
                      title: effective ? "当前生效" : checked ? "名册选中了它，但当前生效的不是它" : "设为当前生效",
                      style: Object.assign({}, S.radio, checked ? S.radioOn : null),
                      disabled: checked || Boolean(props.busy),
                      onClick: function () {
                        void props.onActivate(entry);
                      },
                    },
                    checked ? h("span", { style: S.radioMark }) : null
                  ),
                  h(KeyNameCell, {
                    key: entry.id + ":name",
                    entry: entry,
                    editingId: props.editingId,
                    onBeginEdit: props.onBeginEdit,
                    onEndEdit: props.onEndEdit,
                    onRename: props.onRename,
                  }),
                  h("span", { style: S.tag }, regionDisplay(status, entry.region)),
                  h("span", { style: S.mono }, entry.hint || "—"),
                  h("span", { style: S.tag, title: KEY_KIND_LABEL[kind] || "" }, KEY_KIND_SHORT[kind] || KEY_KIND_SHORT.unknown)
                ),
                h(
                  "div",
                  { style: S.row },
                  effective
                    ? h("span", { style: { color: C.ok, fontSize: 12 } }, "当前生效")
                    : checked
                      ? h("span", { style: { color: C.warn, fontSize: 12 } }, "名册选中")
                      : null,
                  effective
                    ? null
                    : h(
                        "button",
                        {
                          type: "button",
                          style: disabledStyle(S.button, props.busy),
                          disabled: Boolean(props.busy),
                          onClick: function () {
                            void props.onActivate(entry);
                          },
                        },
                        "启用"
                      ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: disabledStyle(S.button, props.busy),
                      disabled: Boolean(props.busy),
                      onClick: function () {
                        void props.onTest(entry);
                      },
                    },
                    "测试"
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: disabledStyle(S.button, props.busy),
                      disabled: Boolean(props.busy),
                      onClick: function () {
                        props.onBeginEdit(entry.id);
                      },
                    },
                    "改名"
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: disabledStyle(S.button, props.busy),
                      disabled: Boolean(props.busy),
                      onClick: function () {
                        void props.onRemove(entry);
                      },
                    },
                    "删除"
                  )
                )
              );
            })
      );
    }

    /** 添加一把新 Key：备注名 + Key + 区域 + 「保存后立即启用」。 */
    function AddKeyCard(props) {
      const [nameDraft, setNameDraft] = React.useState("");
      const [keyDraft, setKeyDraft] = React.useState("");
      const [region, setRegion] = React.useState("auto");
      const [activateNow, setActivateNow] = React.useState(true);
      const [saving, setSaving] = React.useState(false);

      function submit(event) {
        event.preventDefault();
        if (saving || keyDraft.trim().length === 0) return;
        setSaving(true);
        void Promise.resolve(
          props.onSave({
            key: keyDraft.trim(),
            region: region,
            name: nameDraft.trim(),
            activate: activateNow,
          })
        ).then(function (ok) {
          setSaving(false);
          if (ok) {
            setKeyDraft("");
            setNameDraft("");
          }
        });
      }

      return h(
        "div",
        { style: S.card },
        h("span", { style: S.title }, "添加 Key"),
        h(
          "form",
          {
            style: { display: "flex", flexDirection: "column", gap: 8 },
            onSubmit: submit,
          },
          h(
            "div",
            { style: S.row },
            h("input", {
              type: "text",
              value: nameDraft,
              maxLength: 40,
              autoComplete: "off",
              placeholder: "备注名，例如：公司号",
              "aria-label": "备注名",
              style: Object.assign({}, S.input, { flex: "0 1 180px" }),
              onChange: function (event) {
                setNameDraft(event.target.value);
              },
            }),
            h("input", {
              type: "password",
              value: keyDraft,
              autoComplete: "off",
              spellCheck: false,
              placeholder: "粘贴 MiniMax API Key（sk-cp- / sk-api- / 账号 Key 均可）",
              "aria-label": "MiniMax API Key",
              style: S.input,
              onChange: function (event) {
                setKeyDraft(event.target.value);
              },
            }),
            h(
              "select",
              {
                value: region,
                "aria-label": "区域",
                style: S.select,
                onChange: function (event) {
                  setRegion(event.target.value);
                },
              },
              h("option", { value: "auto" }, "自动识别"),
              h("option", { value: "cn" }, "国内（api.minimaxi.com）"),
              h("option", { value: "intl" }, "国际（api.minimax.io）")
            ),
            h(
              "button",
              {
                type: "submit",
                style: disabledStyle(S.primary, saving || keyDraft.trim().length === 0),
                disabled: saving || keyDraft.trim().length === 0,
              },
              saving ? "校验中…" : "保存"
            )
          ),
          h(
            "div",
            { style: S.row },
            h(
              "label",
              { style: S.check },
              h("input", {
                type: "checkbox",
                checked: activateNow,
                style: { accentColor: C.brand },
                onChange: function (event) {
                  setActivateNow(event.target.checked);
                },
              }),
              "保存后立即启用"
            ),
            h(
              "span",
              { style: S.sub },
              "备注名留空时由宿主自动命名；同名也允许。"
            )
          ),
          h(
            "div",
            { style: S.sub },
            "Key 会先用 GET /v1/models 校验，通过后保存到本机凭据库（$DSH_HOME/.credentials.yaml），不会写进配置文件，也不会回传到浏览器。还没有 Key？",
            h(
              "a",
              {
                href: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
                target: "_blank",
                rel: "noreferrer",
                style: S.link,
              },
              " 去 MiniMax 控制台创建 ↗"
            )
          )
        )
      );
    }

    /**
     * 多 Key 管理区。
     *
     * 写操作一个对一个契约端点：saveKey / activateKey / renameKey / deleteKey / adoptKey /
     * clearKey / testKey。所有失败都要出现在 Notice 里，不允许静默吞掉。
     */
    function KeyManager(props) {
      const api = props.api;
      const status = props.status;
      const [busy, setBusy] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [editingId, setEditingId] = React.useState(null);

      const keys = registryKeys(status);
      const active = activeKeyOf(status);
      const mismatch = Boolean(status && status.mismatch === true);
      const registryActive = keys.find(function (k) {
        return k.active === true;
      }) || null;
      const checkedId = active && active.id ? active.id : registryActive ? registryActive.id : null;
      // 实际在用的那把的 id（不在名册里时为 null）；名册声称生效的那把可能与它不是同一把。
      const effectiveId = active && active.id ? active.id : null;

      /** 每次写操作之后都刷新页面状态，并通知工具栏标记。 */
      function refresh() {
        announceChange();
        props.onChanged();
      }

      /** 统一的失败文案：端点层失败（result.ok === false）与业务层失败（value.ok === false）都要显示。 */
      function fail(prefix, result, value) {
        if (!result.ok) return prefix + result.message;
        return prefix + ((value && value.message) || "未知错误");
      }

      function activate(entry) {
        setBusy("activate");
        return call(api, "activateKey", { id: entry.id }).then(function (result) {
          setBusy(null);
          const value = result.ok ? result.value : null;
          if (!result.ok || !value || value.ok !== true) {
            setNote({ tone: "error", text: fail("切换失败：", result, value) });
            return false;
          }
          const name = (value.active && value.active.name) || entry.name;
          setNote({ tone: "ok", text: "已切换到「" + name + "」。", detail: value.notice });
          refresh();
          return true;
        });
      }

      function rename(id, name) {
        setBusy("rename");
        return call(api, "renameKey", { id: id, name: name }).then(function (result) {
          setBusy(null);
          const value = result.ok ? result.value : null;
          if (!result.ok || !value || value.ok !== true) {
            setNote({ tone: "error", text: fail("改名失败：", result, value) });
            return false;
          }
          setNote({ tone: "ok", text: "已改名为「" + ((value && value.name) || name) + "」。" });
          refresh();
          return true;
        });
      }

      function remove(entry) {
        if (!window.confirm("确定删除「" + entry.name + "」这把 Key 吗？")) return Promise.resolve(false);
        setBusy("remove");
        return call(api, "deleteKey", { id: entry.id }).then(function (result) {
          setBusy(null);
          const value = result.ok ? result.value : null;
          if (!result.ok || !value || value.ok !== true) {
            setNote({ tone: "error", text: fail("删除失败：", result, value) });
            return false;
          }
          if (value.stillActive) {
            // 名册里删掉了，但环境变量那一层还在生效 —— 必须说清楚，不能让用户以为删干净了。
            setNote({
              tone: "warn",
              text: "已从名册里删除「" + entry.name + "」，但环境变量里的那把仍在生效。",
              detail: "要彻底停用它，请从 shell 配置或 DSH 的 .env 中移除，然后重启 DSH。",
            });
          } else {
            setNote({ tone: "ok", text: value.message || ("已删除「" + entry.name + "」。") });
          }
          refresh();
          return true;
        });
      }

      function adopt(name) {
        const payload = name ? { name: name } : {};
        setBusy("adopt");
        return call(api, "adoptKey", payload).then(function (result) {
          setBusy(null);
          const value = result.ok ? result.value : null;
          if (!result.ok || !value || value.ok !== true) {
            setNote({ tone: "error", text: fail("登记失败：", result, value) });
            return false;
          }
          const entryName = (value.entry && value.entry.name) || name || "未命名";
          setNote({ tone: "ok", text: "已登记为「" + entryName + "」，并设为当前生效。" });
          refresh();
          return true;
        });
      }

      function test(entry) {
        setBusy("test");
        return call(api, "testKey", { id: entry.id }).then(function (result) {
          setBusy(null);
          const value = result.ok ? result.value : null;
          if (!result.ok || !value || value.ok !== true) {
            setNote({ tone: "error", text: fail("测试失败：", result, value) });
            return false;
          }
          setNote({ tone: "ok", text: "「" + entry.name + "」" + value.message });
          return true;
        });
      }

      function clear(region) {
        setBusy("clear");
        return call(api, "clearKey", { region: region }).then(function (result) {
          setBusy(null);
          const value = result.ok ? result.value : null;
          if (!result.ok || !value) {
            setNote({ tone: "error", text: fail("清除失败：", result, value) });
            return false;
          }
          if (value.stillActive) {
            setNote({
              tone: "warn",
              text: value.removedFromStore
                ? "已删除本插件保存的那份 Key，但它仍来自环境变量，所以还在生效。"
                : "这把 Key 来自环境变量，不是本插件保存的，无法在这里删除。",
              detail: "要彻底停用它，请从 shell 配置或 DSH 的 .env 中移除，然后重启 DSH。",
            });
          } else if (value.cleared) {
            setNote({ tone: "ok", text: value.message || ("已删除 " + regionDisplay(status, region) + " 的 Key。") });
          } else {
            setNote({ tone: "warn", text: value.message || "没有可删除的 Key。" });
          }
          refresh();
          return true;
        });
      }

      function save(payload) {
        setBusy("save");
        return call(api, "saveKey", {
          key: payload.key,
          region: payload.region,
          name: payload.name,
          activate: payload.activate,
        }).then(function (result) {
          setBusy(null);
          const value = result.ok ? result.value : null;
          if (!result.ok) {
            setNote({ tone: "error", text: "保存失败：" + result.message });
            return false;
          }
          if (!value || value.saved !== true) {
            setNote({ tone: "error", text: (value && value.message) || "保存失败。", detail: value && value.detail });
            return false;
          }
          const entry = value.entry || {};
          const name = entry.name || payload.name || "";
          const details = [];
          details.push(value.activated ? "已设为当前生效。" : "已保存，未设为当前生效。");
          if (value.notice) details.push(value.notice);
          if (value.models && value.models.length > 0) {
            details.push("模型选择器里现在可以选 " + value.models.join("、") + "。");
          }
          if (value.routeOk === false) {
            details.push("注意：模型目录未写入（" + value.routeMessage + "），可在下方点「补写模型目录」。");
          }
          setNote({
            tone: "ok",
            text: "已保存「" + name + "」到 " + (value.displayName || regionDisplay(status, value.region)) + "（" + (value.keyHint || "") + "）。",
            detail: details.join(" "),
          });
          refresh();
          return true;
        });
      }

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 16 } },
        h(ActiveKeyCard, {
          status: status,
          active: active,
          mismatch: mismatch,
          registryActive: registryActive,
          busy: busy,
          onAdopt: adopt,
          onActivate: activate,
          onClear: clear,
        }),
        h(KeyListCard, {
          status: status,
          checkedId: checkedId,
          effectiveId: effectiveId,
          busy: busy,
          editingId: editingId,
          onBeginEdit: function (id) {
            setEditingId(id);
          },
          onEndEdit: function () {
            setEditingId(null);
          },
          onRename: rename,
          onActivate: activate,
          onTest: test,
          onRemove: remove,
        }),
        h(AddKeyCard, { onSave: save }),
        h(Notice, { note: note })
      );
    }

    /**
     * 上下文窗口的小图标：一个框 + 底部一段填充，表示「窗口里已经占用的上下文」。
     * 工具栏空间紧张，用图标 + 数值（1M / 512K）代替「上下文 1M」这样的长标签。
     */
    function ContextGlyph() {
      return h(
        "svg",
        {
          width: 13,
          height: 13,
          viewBox: "0 0 16 16",
          "aria-hidden": true,
          style: { flex: "none", display: "block", opacity: 0.75 },
        },
        h("rect", {
          x: 1.5, y: 2.5, width: 13, height: 11, rx: 2,
          fill: "none", stroke: "currentColor", strokeWidth: 1.3,
        }),
        h("rect", { x: 4, y: 8.5, width: 8, height: 2.5, rx: 1, fill: "currentColor" })
      );
    }

    function WindowBar(props) {
      const win = props.window;
      const remaining = win.remainingPercent;
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 4 } },
        h(
          "div",
          { style: S.head },
          h("span", { style: { fontSize: 12 } }, win.label),
          h("span", { style: Object.assign({}, S.sub, S.mono) }, "剩余 " + remaining + "% · " + countdown(win.resetsAt))
        ),
        h(
          "div",
          { style: S.track },
          h("div", { style: { width: Math.max(2, remaining) + "%", height: "100%", background: colorForRemaining(remaining), borderRadius: 999 } })
        )
      );
    }

    function QuotaCard(props) {
      const { quota, pending, reload } = useQuota(props.api);
      const state = quota ? quota.state : null;
      const pill = {
        plan: ["套餐额度", C.ok],
        payg: ["按量付费", C.brand],
        "no-key": ["未配置 Key", C.idle],
        error: ["读取失败", C.error],
      }[state] || ["读取中", C.idle];

      return h(
        "div",
        { style: S.card },
        h(
          "div",
          { style: S.head },
          // 标题里带上当前生效那把 Key 的备注名，一眼就知道额度查的是哪一把。
          h("span", { style: S.title }, "额度" + (quota && quota.keyName ? " · " + quota.keyName : "")),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.dot(pill[1]) }),
            h("span", { style: S.sub }, pill[0] + (quota && quota.provider && state !== "no-key" ? " · " + quota.provider : "")),
            h("button", { type: "button", style: disabledStyle(S.button, pending), disabled: pending, onClick: function () { void reload(true); } }, pending ? "读取中…" : "刷新")
          )
        ),
        state === "plan"
          ? quota.buckets.map(function (bucket) {
              return h(
                "div",
                { key: bucket.bucket, style: { display: "flex", flexDirection: "column", gap: 8 } },
                quota.buckets.length > 1 ? h("span", { style: { fontSize: 12, fontWeight: 600 } }, bucket.bucketLabel) : null,
                bucket.windows.map(function (win) {
                  return h(WindowBar, { key: win.key, window: win });
                })
              );
            })
          : null,
        state === "payg"
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 4 } },
              h("span", null, quota.message),
              h("span", { style: S.sub }, quota.detail),
              h("a", { href: quota.consoleUrl, target: "_blank", rel: "noreferrer", style: S.link }, "打开 MiniMax 控制台查看余额 ↗")
            )
          : null,
        state === "no-key" ? h("span", { style: S.sub }, "在上方填入 Key 后显示额度。") : null,
        state === "error"
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 2 } },
              h("span", { style: { color: C.error } }, quota.message),
              quota.detail ? h("span", { style: S.sub }, String(quota.detail)) : null
            )
          : null,
        h(
          "span",
          { style: S.sub },
          "MiniMax 只为 M Plan / Token Plan 提供额度接口（GET /v1/token_plan/remains）。按量付费 Key 没有公开的余额接口，本插件不会编造数字。"
        )
      );
    }

    function CatalogCard(props) {
      const api = props.api;
      const status = props.status;
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const models = (status && status.models) || [];
      const retired = (status && status.retired) || [];
      const configured = ((status && status.regions) || []).filter(function (r) {
        return r.configured;
      });
      const options = (status && status.contextOptions) || [];
      // 已配置区域里的生效值；两个区域本插件总写成同一档，取第一个有值的。
      const current = (function () {
        for (let i = 0; i < configured.length; i += 1) {
          if (typeof configured[i].contextWindow === "number") return configured[i].contextWindow;
        }
        return undefined;
      })();
      const currentLabel = (function () {
        for (let i = 0; i < options.length; i += 1) {
          if (options[i].id === current) return options[i].label;
        }
        return current === undefined ? "" : String(Math.round(current / 1000)) + "K";
      })();

      function sync(r) {
        setBusy(true);
        void call(api, "sync", { region: r.region }).then(function (result) {
          setBusy(false);
          const value = result.ok ? result.value : { ok: false, reason: result.message };
          setNote(
            value.ok
              ? { tone: "ok", text: value.changed ? r.displayName + "：模型目录已更新。" : r.displayName + "：模型目录已是当前版本。" }
              : { tone: "error", text: r.displayName + "：" + value.reason }
          );
          props.onChanged();
        });
      }

      return h(
        "div",
        { style: S.card },
        h("span", { style: S.title }, "模型目录"),
        // 上下文预算：两个模型都支持 1M，但窗口越大越贵越慢（M3 在 512K 输入处分价格档），
        // 调小等于让 DSH 更早压缩历史。选项来自宿主，不在浏览器里写死。
        h(
          "div",
          { style: { borderTop: "1px solid " + C.border, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 } },
          h(
            "div",
            { style: S.head },
            h("span", { style: { fontSize: 12, fontWeight: 600 } }, "上下文大小"),
            h(
              "span",
              { style: S.sub },
              current === undefined ? "尚未生效" : "当前 " + currentLabel
            )
          ),
          h(
            "div",
            { style: S.row },
            options.map(function (option) {
              const selected = option.id === current;
              return h(
                "button",
                {
                  key: option.id,
                  type: "button",
                  title: option.note,
                  style: disabledStyle(
                    Object.assign({}, S.button, selected ? { borderColor: C.brand, color: C.brand, fontWeight: 600 } : {}),
                    busy || selected || configured.length === 0
                  ),
                  disabled: busy || selected || configured.length === 0,
                  onClick: function () {
                    setBusy(true);
                    setNote(null);
                    void call(api, "setContext", { contextWindow: option.id }).then(function (result) {
                      setBusy(false);
                      if (!result.ok) {
                        setNote({ tone: "error", text: "设置失败：" + result.message });
                        return;
                      }
                      const value = result.value;
                      const changed = (value.results || []).some(function (r) { return r.changed; });
                      setNote({
                        tone: "ok",
                        text: changed
                          ? "已切换到 " + option.label + " 上下文，新会话生效；已有会话在下次压缩后跟上。"
                          : "已经是 " + option.label + " 上下文，无需改动。",
                      });
                      props.onChanged();
                    });
                  },
                },
                option.label
              );
            })
          ),
          h(
            "span",
            { style: S.sub },
            "窗口越大越贵越慢；MiniMax-M3 在 512K 输入以上按更高单价计费。调小只会让 DSH 更早压缩历史，不影响模型本身的能力。"
          )
        ),
        models.map(function (m) {
          return h(
            "div",
            { key: m.id, style: Object.assign({}, S.head, { alignItems: "baseline" }) },
            h("span", { style: S.mono }, m.id),
            h("span", { style: S.sub }, m.note)
          );
        }),
        configured.map(function (r) {
          return h(
            "div",
            { key: r.region, style: Object.assign({}, S.head, { borderTop: "1px solid " + C.border, paddingTop: 8 }) },
            h(
              "div",
              { style: S.row },
              h("span", { style: S.dot(r.catalogCurrent ? C.ok : C.warn) }),
              h("span", null, r.displayName + "（" + r.provider + "）"),
              h("span", { style: S.sub }, r.catalogCurrent ? "目录已是当前版本" : "目录待更新")
            ),
            r.catalogCurrent
              ? null
              : h("button", { type: "button", style: disabledStyle(S.button, busy), disabled: busy, onClick: function () { sync(r); } }, "补写模型目录")
          );
        }),
        h(Notice, { note: note }),
        h(
          "span",
          { style: S.sub },
          "DSH 自带的 MiniMax 目录只到 MiniMax-M3，还列着已退役的 " +
            retired.map(function (m) { return m.id; }).join("、") +
            "（" + (retired[0] ? retired[0].retiredOn : "") + " 退役）。保存 Key 时本插件会把上面的目录写进对应路由，并打开自适应思考，让选择器里的思考档位真正生效；你自己在「设置 → 模型」里加的其它模型会原样保留。"
        )
      );
    }

    function SettingsPage(props) {
      const api = props.api;
      const { status, error, reload } = useStatus(api);
      return h(
        "div",
        { style: S.page },
        h(
          "div",
          { style: S.intro },
          "使用 MiniMax 官方开放平台的 API Key。可以保存多把 Key、给每把起备注名，再一键切换当前生效的那一把（同一时间只有一把在用）。保存后，MiniMax-M3.1-Flash 与 MiniMax-M3 会出现在输入框的模型选择列表里（MiniMax 国内 / MiniMax 国际分组）。"
        ),
        error ? h("div", { style: { color: C.error, fontSize: 12 } }, "读取状态失败：" + error) : null,
        h(KeyManager, { api: api, status: status, onChanged: reload }),
        h(QuotaCard, { api: api }),
        h(CatalogCard, { api: api, status: status, onChanged: reload })
      );
    }

    // ---------- 工具栏标记 ----------

    /** 模型路由 → 本插件的区域。只有这两条路由属于 MiniMax。 */
    const REGION_OF_PROVIDER = { "minimax-cn": "cn", minimax: "intl" };

    /**
     * 读模型目录服务。它由 dsh-client-ui-model-selection 提供，若尚未注册
     * 则返回 undefined（不抛错）—— 调用方据此先不渲染工具栏控件。
     */
    function resolveModelDirectories(ctx) {
      try {
        return typeof ctx.get === "function" ? ctx.get("modelDirectories", false) : undefined;
      } catch (error) {
        return undefined;
      }
    }

    /**
     * 取某会话的模型目录（与模型选择器同源）。取不到就返回 undefined ——
     * 调用方据此不渲染控件，而不是抛错。
     */
    function directoryFor(directories, sessionId) {
      if (!directories || typeof directories.directoryFor !== "function") return undefined;
      try {
        return directories.directoryFor(sessionId);
      } catch (error) {
        return undefined;
      }
    }

    /**
     * 当前会话选中的模型（与输入框模型选择器同源：modelDirectories 的会话目录）。
     * 拿不到目录时返回 undefined —— 调用方据此「宁可不显示」。
     */
    function useSelectedProvider(directory) {
      const store = directory && directory.store;
      const subscribe = React.useCallback(
        function (fn) {
          return store ? store.subscribe(fn) : function () {};
        },
        [store]
      );
      const read = React.useCallback(
        function () {
          if (!store) return undefined;
          const snapshot = store.getSnapshot();
          // 切换中先按目标模型显示，避免选完要等一拍才出现 / 消失。
          const selection = (snapshot && (snapshot.pending || snapshot.current)) || null;
          return selection ? selection.provider : null;
        },
        [store]
      );
      return React.useSyncExternalStore(subscribe, read, read);
    }

    /**
     * 输入框工具栏标记：只在当前会话选中 MiniMax 模型时出现。
     * 外层只读选择状态；没选 MiniMax 时内层不挂载，也就不会去请求额度。
     */
    function Badge(props) {
      const provider = useSelectedProvider(props.directory);
      const region = provider ? REGION_OF_PROVIDER[provider] : undefined;
      if (region === undefined) return null;
      return h(QuotaBadge, { api: props.api, region: region });
    }

    /**
     * 套餐额度控件：一个小圆点 + 剩余百分比。
     *
     * 可点击 —— 展开一个面板，列出 5 小时窗口与每周窗口的：已用/剩余、进度条、
     * 重置倒计时，以及**按当前用量速度的耗尽预估**（OpenUsage 的做法：
     * 「按当前速度，重置时会落到多少」）。
     */
    function QuotaBadge(props) {
      const { quota } = useQuota(props.api, props.region);
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);

      React.useEffect(
        function () {
          if (!open) return;
          function onDown(event) {
            if (rootRef.current && rootRef.current.contains(event.target)) return;
            setOpen(false);
          }
          function onKey(event) {
            if (event.key === "Escape") setOpen(false);
          }
          document.addEventListener("mousedown", onDown);
          document.addEventListener("keydown", onKey);
          return function () {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
          };
        },
        [open]
      );

      if (!quota || quota.state !== "plan") return null;
      const bucket =
        quota.buckets.find(function (b) { return b.bucket === "general"; }) || quota.buckets[0];
      const win = bucket && (bucket.windows.find(function (w) { return w.key === "interval"; }) || bucket.windows[0]);
      if (!win) return null;

      const trigger = h(
        "button",
        {
          type: "button",
          title: "MiniMax 套餐额度（点击查看 5 小时 / 每周窗口与耗尽预估）",
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          "aria-label": "MiniMax 套餐额度，剩余 " + win.remainingPercent + "%",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 24,
            padding: "0 8px",
            borderRadius: 999,
            border: "1px solid " + C.border,
            background: "transparent",
            color: C.sub,
            fontSize: 11,
            whiteSpace: "nowrap",
            userSelect: "none",
            cursor: "pointer",
          },
          onClick: function () {
            setOpen(function (v) { return !v; });
          },
        },
        h("span", { style: S.dot(colorForRemaining(win.remainingPercent)) }),
        "MiniMax " + win.remainingPercent + "%"
      );

      return h(
        "div",
        { ref: rootRef, style: { position: "relative" } },
        trigger,
        open ? h(QuotaPanel, { quota: quota }) : null
      );
    }

    /** 一个窗口的额度行：进度条 + 已用/剩余 + 重置时间。 */
    function QuotaRow(props) {
      const win = props.window;
      const pace = win.pace;
      const used = win.usedPercent;
      const remaining = win.remainingPercent;
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 5 } },
        h(
          "div",
          { style: Object.assign({}, S.row, { justifyContent: "space-between" }) },
          h("span", { style: { fontSize: 12, fontWeight: 600 } }, win.label),
          h(
            "span",
            { style: Object.assign({}, S.sub, S.mono) },
            "剩余 " + remaining + "% · 已用 " + used + "%"
          )
        ),
        // 进度条表示**剩余**：绿色 = 还充足，条随消耗变短；剩 ≤30% 转橙、≤10% 转红
        // （OpenUsage 的约定）。早先这里画的是「已用」，于是出现「绿色但几乎空的条」——
        // 条的长度与颜色含义相反，看着像快满了，其实快用完了。
        h(
          "div",
          { style: S.track, title: "剩余 " + remaining + "%" },
          h("div", {
            style: {
              width: Math.max(2, remaining) + "%",
              height: "100%",
              background: colorForRemaining(remaining),
              borderRadius: 999,
            },
          })
        ),
        h(
          "div",
          { style: Object.assign({}, S.sub, { fontSize: 11 }) },
          typeof win.resetsAt === "number" ? countdown(win.resetsAt) : "重置时间未知"
        ),
        pace && typeof pace.ratePerHour === "number"
          ? h(
              "div",
              { style: Object.assign({}, S.sub, { fontSize: 11 }) },
              "按当前速度 " + pace.ratePerHour.toFixed(1) + "%/小时" +
                (pace.basis === "average" ? "（窗口平均）" : "") +
                (typeof pace.exhaustsInMs === "number"
                  ? " · 约 " + spanLabel(pace.exhaustsInMs) + "后用完"
                  : "") +
                (typeof pace.atResetPercent === "number"
                  ? " · 重置时约用到 " + Math.round(pace.atResetPercent) + "%"
                  : "")
            )
          : null,
        pace && pace.willExhaustBeforeReset
          ? h(
              "div",
              { style: { fontSize: 11, color: C.error } },
              "按这个速度，额度会在重置前用完"
            )
          : null
      );
    }

    /** 额度详情面板。 */
    function QuotaPanel(props) {
      const quota = props.quota;
      const buckets = quota.buckets ?? [];
      const text = buckets
        .map(function (b) {
          return b.windows
            .map(function (w) { return w.label + " 剩余 " + w.remainingPercent + "%"; })
            .join("\n");
        })
        .join("\n");

      return h(
        "div",
        {
          role: "dialog",
          "aria-label": "MiniMax 套餐额度",
          style: {
            position: "absolute",
            bottom: "calc(100% + 6px)",
            right: 0,
            zIndex: 40,
            width: 300,
            padding: 12,
            borderRadius: 10,
            border: "1px solid " + C.border,
            background: C.layer,
            boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            color: C.text,
            fontSize: 12,
            textAlign: "left",
          },
        },
        h("div", { style: { fontSize: 13, fontWeight: 600 } }, "MiniMax 套餐额度"),
        buckets.map(function (bucket, index) {
          return h(
            "div",
            { key: bucket.bucket, style: { display: "flex", flexDirection: "column", gap: 10 } },
            bucket.windows.map(function (win) {
              return h(QuotaRow, { key: win.key, window: win });
            })
          );
        }),
        h(
          "div",
          { style: Object.assign({}, S.sub, { fontSize: 11, borderTop: "1px solid " + C.border, paddingTop: 8 }) },
          "数据来自 MiniMax 的 token_plan 接口（每分钟刷新）。按量付费 Key 没有该接口，余额请看控制台。"
        )
      );
    }

    /** 把毫秒时长说成人话。 */
    function spanLabel(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
      const minutes = Math.round(ms / 60_000);
      if (minutes < 60) return minutes + " 分钟";
      const hours = minutes / 60;
      if (hours < 24) return hours.toFixed(1) + " 小时";
      return (hours / 24).toFixed(1) + " 天";
    }

    // ---------- 输入框工具栏：上下文大小菜单 ----------

    /**
     * 模型选择器旁边的上下文大小控件。
     *
     * 只在当前会话选中 MiniMax 模型时出现。点击展开一个小菜单选 200K / 512K / 1M。
     *
     * 为什么放在这里而不是模型选择器内部：DSH 的 `selectModel` 只接受
     * { provider, model, reasoningEffort }，**没有按会话设置上下文这一说** ——
     * 上下文是适配器路由里模型条目的属性，改它会写全局路由配置，影响所有用该路由的会话。
     * 所以做成一个与模型选择器并排的独立控件，既不影子化官方座位（那要重写整套菜单），
     * 也让用户一眼看到「上下文和推理等级是两回事，可以分别调」。
     */
    function ContextControl(props) {
      const api = props.api;
      const provider = useSelectedProvider(props.directory);
      const region = provider ? REGION_OF_PROVIDER[provider] : undefined;
      const { status, reload } = useStatus(api);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const rootRef = React.useRef(null);

      React.useEffect(
        function () {
          if (!open) return;
          function onDown(event) {
            if (rootRef.current && rootRef.current.contains(event.target)) return;
            setOpen(false);
          }
          function onKey(event) {
            if (event.key === "Escape") setOpen(false);
          }
          document.addEventListener("mousedown", onDown);
          document.addEventListener("keydown", onKey);
          return function () {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
          };
        },
        [open]
      );

      if (region === undefined) return null;

      const options = (status && status.contextOptions) || [];
      // 只看当前这条路由（用户可能国内国际各配一条，它们的档位可以不同）。
      const active = ((status && status.regions) || []).find(function (r) {
        return r.region === region;
      });
      const current = active && typeof active.contextWindow === "number" ? active.contextWindow : undefined;
      const currentLabel = (function () {
        for (let i = 0; i < options.length; i += 1) {
          if (options[i].id === current) return options[i].label;
        }
        return current === undefined ? "上下文" : Math.round(current / 1000) + "K";
      })();

      function choose(option) {
        setBusy(true);
        setNote(null);
        void call(api, "setContext", { contextWindow: option.id }).then(function (result) {
          setBusy(false);
          if (!result.ok) {
            setNote({ tone: "error", text: "设置失败：" + result.message });
            return;
          }
          const value = result.value;
          const changed = (value.results || []).some(function (r) { return r.changed; });
          setNote({
            tone: changed ? "ok" : "warn",
            text: changed ? "已切换到 " + option.label + " 上下文" : "已经是 " + option.label + " 上下文",
          });
          reload();
        });
      }

      return h(
        "div",
        { ref: rootRef, style: { position: "relative" } },
        h(
          "button",
          {
            type: "button",
            title: "上下文大小：" + currentLabel + "（影响 DSH 何时压缩历史；越大越贵）",
            "aria-label": "上下文大小 " + currentLabel,
            "aria-haspopup": "menu",
            "aria-expanded": open,
            disabled: busy || options.length === 0,
            style: disabledStyle(
              Object.assign({}, S.button, {
                height: 24,
                padding: "0 7px",
                fontSize: 11,
                whiteSpace: "nowrap",
                gap: 4,
                display: "inline-flex",
                alignItems: "center",
              }),
              busy || options.length === 0
            ),
            onClick: function () {
              setOpen(function (v) { return !v; });
            },
          },
          h(ContextGlyph, {}),
          currentLabel
        ),
        open
          ? h(
              "div",
              {
                role: "menu",
                style: {
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  right: 0,
                  zIndex: 40,
                  minWidth: 190,
                  padding: 4,
                  borderRadius: 10,
                  border: "1px solid " + C.border,
                  background: C.layer,
                  boxShadow: "0 8px 24px rgba(0,0,0,.18)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                },
              },
              options.map(function (option) {
                const selected = option.id === current;
                return h(
                  "button",
                  {
                    key: option.id,
                    type: "button",
                    role: "menuitemradio",
                    "aria-checked": selected,
                    title: option.note,
                    style: Object.assign(
                      {},
                      S.button,
                      {
                        height: "auto",
                        border: "none",
                        textAlign: "left",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        padding: "6px 8px",
                        background: selected ? C.layer2 : "transparent",
                        color: selected ? C.brand : C.text,
                        fontWeight: selected ? 600 : 400,
                      }
                    ),
                    onClick: function () {
                      choose(option);
                      setOpen(false);
                    },
                  },
                  h("span", null, option.label),
                  h("span", { style: Object.assign({}, S.sub, { fontSize: 11 }) }, option.note)
                );
              }),
              note
                ? h(
                    "div",
                    { style: { fontSize: 11, padding: "4px 8px 2px", color: note.tone === "ok" ? C.ok : C.warn } },
                    note.text
                  )
                : null
            )
          : null
      );
    }

    // ---------- 「设置 → 模型」里的 MiniMax 卡片提示 ----------

    function ProviderCardHint(props) {
      // owner props：{ provider: ConfigurableProviderView, configured, keyConfigured }
      const id = props && props.provider && props.provider.provider;
      if (id !== "minimax-cn" && id !== "minimax") return null;
      return h(
        "div",
        { style: Object.assign({}, S.sub, { padding: "4px 0" }) },
        "MiniMax 的 Key、当前模型目录（含 MiniMax-M3.1-Flash）和套餐额度，也可以在「设置 → MiniMax」页面直接管理。"
      );
    }

    // ---------- 装配 ----------

    return {
      // 依赖清单：
      //  - slots / connection：座位注册与 RPC 通道。
      //  - modelDirectories：模型选择器同源的选择状态（由 dsh-client-ui-model-selection
      //    提供，package.json 的 dsh.client.inject 已声明该包在前）。
      //  - remote / remote.session：**必需**。modelDirectories.directoryFor() 内部要读
      //    ctx.remote.session，而 cordis 的服务访问是严格的：未声明的服务会抛
      //    「cannot get property "remote.session" without inject」。不声明它，
      //    directoryFor 每次都抛异常、控件永远拿到 undefined —— 表现为界面里
      //    什么都没有，且没有任何报错线索。
      inject: ["slots", "connection", "remote", "remote.session", "modelDirectories"],
      apply(ctx) {
        const api = { connection: ctx.connection };

        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            { name: "settings.section", id: "minimax", order: 12, label: function () { return "MiniMax"; } },
            function () {
              return h(SettingsPage, { api: api });
            }
          );
        });

        // 工具栏上的上下文/额度控件。
        //
        // 用 ctx.inject([...]) 声明 modelDirectories 依赖：cordis 会等该服务就绪
        // 才执行这个回调（服务由 dsh-client-ui-model-selection 注册）。
        // 这**不会**阻塞 apply 的其余部分 —— 设置页等与模型无关的功能照常注册，
        // 即使模型选择器插件尚未就绪也不受影响。
        ctx.inject(["slots", "modelDirectories"], function (scope) {
          const models = scope.get("modelDirectories", false);

          ctx.slots.inject("conversation.input.right", function () {
            return ctx.slots.register(
              {
                name: "conversation.input.right",
                id: "minimax-context",
                // 排在腾讯圆环（order 100）之后 —— conversation.input.right 整个插槽
                // 渲染在模型座位**之前**，所以同一插槽里 order 越大就越贴近模型选择器。
                order: 210,
                inject: function (sessionId) {
                  return { directory: directoryFor(models, sessionId) };
                },
              },
              function (slotProps) {
                return h(ContextControl, { api: api, directory: slotProps && slotProps.directory });
              }
            );
          });

          ctx.slots.inject("conversation.input.right", function () {
            return ctx.slots.register(
              {
                name: "conversation.input.right",
                id: "minimax-quota",
                order: 200,
                inject: function (sessionId) {
                  return { directory: directoryFor(models, sessionId) };
                },
              },
              function (slotProps) {
                return h(Badge, { api: api, directory: slotProps && slotProps.directory });
              }
            );
          });
        });

        // provider-card 按 settingsNs（= llm-pi-ai 那一行的条目 id）分发；组合里它通常是
        // `include:llm-pi-ai`，直接写在 patch 里时是 `llm-pi-ai`，两个都登记。
        ["include:llm-pi-ai", "llm-pi-ai"].forEach(function (key) {
          ctx.slots.inject("settings.models.provider-card", function () {
            return ctx.slots.register({ name: "settings.models.provider-card", key: key }, function (props) {
              return h(ProviderCardHint, props);
            });
          });
        });
      },
    };
  },
});
