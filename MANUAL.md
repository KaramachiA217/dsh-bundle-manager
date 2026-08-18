# dsh-bundle-manager 使用与开发手册

> 完整详细的插件挂载管理器使用与开发手册。快速入门见 `README.md`。
> 版本：0.4.5。最后更新：2026-08-16。

---

## 1. 概述

`dsh-bundle-manager` 是 DSH 桌面/Web 端的**运行时插件挂载管理器**：在设置页提供一个「插件挂载管理」section，对**可选第三方插件 bundle** 做运行时挂载/卸载——**瞬时生效、零重启、不写 profile manifest**。

### 1.1 做什么 / 不做什么

| | 说明 |
|---|---|
| ✅ 做 | 统一插件列表（每行状态点：active / loading / pending / unmounted / failed / broken-manifest）；运行时 `loader.create/remove` 挂载/卸载；预设（preset）保存与切换；坏插件挂载失败自动回退 + 重试 |
| ❌ 不做 | **安装/卸载插件**（`dsh plugin add/remove` 的事）；**改写 `dsh.profile.bundles`**；重启 dsh；碰 `.dsh/profiles/<name>/package.json` |

### 1.2 核心机制一句话

它是「本次进程要挂哪些第三方可选插件」的**运行时挂载层**：用 `ctx.loader.create/remove` 把别的插件包挂进内存 loader 树（`write()` 是 no-op，永不落盘），因此「挂载表」由插件管理器**自己持久化**到独立文件，完全零接触 profile manifest。

> **关键架构要求**：第三方插件必须**移出 `dsh.profile.bundles`**、只留在 `dependencies`（bundles 只留 `dsh-base` / `dsh-web-app` / `dsh-settings-ui` / `dsh-bundle-manager`）。否则它们的 client 半边会随 boot 扫进初始 `__DSH_BOOT__` 图，而 dsh 客户端无卸载链 + HMR 关闭，运行时「取消挂载」无法撤掉已加载的 UI。

---

## 2. 安装

### 2.1 前置条件

- 一个可用的 dsh profile（含 `dsh-base` + `dsh-web-app` + `dsh-settings-ui`）。
- 已装好本插件管理器要管理的第三方插件（它们应作为 `dependencies` 存在，且各自 `package.json` 声明 `dsh.bundle.patch`）。
- 桌面壳场景：壳 spawn dsh 时注入 `DSH_PROFILE` 环境变量（用于定位 profile 目录；缺失则从本包路径推导，再回退 `'web'`）。

### 2.2 方式 A：`dsh plugin` 安装

```sh
dsh plugin --profile <name> add <path-to-this-package>
```

重启该 profile 的 dsh 实例后，设置 → 插件挂载管理。

### 2.3 方式 B：桌面壳原生集成（file: tgz）

1. 源码放入壳仓库 `plugins/dsh-bundle-manager/`。
2. 打包：在包目录 `npm pack --cache <npm-cache-dir>` → 产出 `<name>-<ver>.tgz`。
3. 改 profile `package.json`：
   - `dependencies` 加 `"dsh-bundle-manager": "file:<绝对路径>/dsh-bundle-manager-<ver>.tgz"`
   - `dsh.profile.bundles` 加 `"dsh-bundle-manager"`（建议放在 `dsh-settings-ui` 之后、第三方插件之前）。
4. `pnpm install --no-frozen-lockfile`（在 profile 根目录）。
5. 重启壳。

> **改代码后必须 bump 版本 + 重打 tgz + 重装**：pnpm 会凭 lockfile 里的旧 integrity 缓存同名 `file:` tarball，同版本重打会被 `Already up to date` 吞掉（开发踩坑 P4）。

---

## 3. 使用指南（UI）

设置 → 插件挂载管理，页面分四块：

1. **头部**：显示当前 profile 名（0.4.1 起无「刷新」按钮——挂载表唯一写者是本页「保存并刷新」、保存后硬刷新，重拉场景不存在；防误读为「重载页面」）。
2. **预设区**：显示当前激活预设名；下拉切换预设；输入新预设名 +「保存为预设」。
3. **插件列表（统一）**：每行 = 插件名 + 版本徽标 + 当前状态点（已挂载/未挂载/挂载失败/挂载中-等待服务）+ 开关（草稿）。有未保存更改的行标「待保存」。
4. **提交栏**：「保存并刷新」（主按钮）+「放弃更改」。
5. **错误横幅 + 重试**（0.4.1）：首次/重新拉取列表失败时显示错误横幅 + 「重试拉取」按钮（明确语义、有反馈）；非静默、非靠盲点。

### 3.1 操作语义

- **开关**：只改**本地草稿**（不即时生效），有改动标「待保存」。
- **「保存并刷新」**：把整张草稿表 POST 给 host → host 一次性 diff 应用（create 挂载 / remove 卸载）+ 持久化 → 客户端 `location.reload()` 硬刷新。**装载与取消装载统一走这一条流程**。
- **「放弃更改」**：草稿回退到当前已提交状态（服务器数据未动）。
- **「重试拉取」（0.4.1）**：仅出现在 `list` 拉取失败的错误横幅旁（error/code 可见）；挂载中的插件显示为「挂载中/等待服务」状态行、会自动 settle，不需要也不应靠重试解决——**启动列表完整性由架构保证**（boot 同步 reconcile 在就绪行前完成、client 后于 host 激活），不存在「二次点击补全」场景。
- **切换预设**：应用该预设的挂载集 + 自动刷新。
- **「保存为预设」（0.4.2/0.4.4）**：把**当前草稿勾选（含未提交）合并**进快照存为命名预设——**预设 = 你想要的组合，无需先「保存并刷新」**；**保存「新」预设会自动设为当前激活**（随后「保存并刷新」应用的就是刚保存的预设——消除「保存了预设2、保存并刷新却改了预设1」的困惑）；**覆盖已有预设不切换激活**（只更新记录）并弹「覆盖确认」。保存后 toast 提示应用需点「保存并刷新」。
- **「删除预设」（0.4.3）**：预设卡红色「删除预设」按钮（与「保存为预设」横向平分一行）→ 弹**多选选择器**（默认与当前激活预设不可选）→「下一步」→ **不可逆确认**（「将永久移除：A、B…」）→ 确认删除；删除后列表自动刷新。host 同时防御：拒删 default 与当前激活预设、拒非法名/空数组。

### 3.2 保存 = 应用 + 刷新

挂载状态由插件管理器持久化到 `registry.json`，下次启动自动按表重挂；「保存并刷新」是唯一提交入口，硬刷新让浏览器重新拉取更新后的 `__DSH_BOOT__` 图。

---

## 4. HTTP API（fenced JSON 路由）

- 前缀：`POST /bundle-manager/api/<method>`，body 为 JSON。
- 信封：成功 `{ "ok": true, "value": <结果> }`；失败 `{ "ok": false, "error": { "code": <码>, "message": <信息> } }`。
- 访问控制：浏览器信任围栏（loopback + 同源，与 `/api` 网关一致）。

### 4.1 方法

| method | body | 返回 value | 说明 |
|---|---|---|---|
| `list` | `{}` | 见下 | 统一插件列表（含当前挂载状态 + 存储状态） |
| `apply` | `{ entries: { "<pkg>": true\|false, ... } }` | `{ ok:true }` | 一次性应用整张挂载表（diff：create/remove），**同步完成**（客户端等它返回后再刷新）；经变更队列串行（30s 上限） |
| `preset/save` | `{ name }` | `{ ok:true }` | 把当前挂载表快照为 `presets[name]`；经变更队列 |
| `preset/switch` | `{ name }` | `{ ok:true }` | diff 切换预设，同步完成；经变更队列 |

### 4.2 `list` 返回结构

```json
{
  "profile": "rc6-dev",
  "version": "0.4.5",
  "activePreset": "default",
  "presets": ["default"],
  "storage": {
    "path": "<DSH_BUNDLE_MANAGER_HOME>/registry.json",
    "mode": "shell",
    "writable": true,
    "lastError": null
  },
  "plugins": [
    { "pkg": "dsh-conversation-search", "version": "0.2.2",
      "mounted": true, "state": "active", "error": null, "managed": true, "waitingFor": [] },
    { "pkg": "dsh-balance", "version": "0.1.0",
      "mounted": false, "state": "unmounted", "error": null, "managed": false, "waitingFor": [] },
    { "pkg": "dsh-wechat-bridge", "version": "0.1.0",
      "mounted": false, "state": "failed", "error": "…", "managed": false,
      "kind": "activate-failed", "attempts": 2, "waitingFor": [] },
    { "pkg": "dsh-broken", "version": "未知",
      "mounted": false, "state": "broken-manifest", "error": "package.json 解析失败，无法判定是否为可选插件", "managed": false }
  ]
}
```

- `plugins[]` = 每个候选一行：`mounted` 当前实际挂载态；`state ∈ active | loading | pending | unmounted | failed | broken-manifest`；`error` 失败信息。
- `managed`：`true` = 本插件管理器运行时创建；`false` = 其它来源。
- `waitingFor[]`（v0.3）：pending/loading 行的「还在等哪些服务」。
- `kind` / `attempts`（v0.3）：failed 行的失败分类与次数。`kind ∈ import-failed | activate-failed | pending-timeout | config-invalid | manifest-invalid | not-a-bundle | unknown`。
- `broken-manifest`（v0.3）：package.json 解析失败的依赖——可见但**不可 toggle**。
- `storage`（v0.3）：挂载表写入状态。`writable:false` 时设置页顶部显示警示条。

### 4.3 错误码

| code | 含义 |
|---|---|
| `framework-protected` | 尝试 toggle 框架核心包（dsh-base / dsh-web-app / dsh-settings-ui / dsh-bundle-manager） |
| `bad-request` | 非法 pkg / 预设名 / 预设不存在 / 非 bundle / 坏清单包 |
| `not-found` | 未知 method |
| `forbidden` | 未过围栏 |
| `internal` | 未捕获异常 |
| `storage-error`（v0.3） | 挂载已生效但 registry 写盘失败（本次更改重启后失效） |
| `timeout`（v0.3） | 变更操作 30s 未完成 |

---

## 5. 数据模型（registry.json）

由插件管理器自管持久化，schema：

```json
{
  "version": 1,
  "activePreset": "default",
  "presets": {
    "default": { "dsh-balance": { "config": null } },
    "work":    { "dsh-balance": { "config": null } }
  },
  "failed": {
    "dsh-wechat-bridge": { "error": "…", "at": 1755000000000, "kind": "activate-failed", "attempts": 2 }
  }
}
```

- `presets[activePreset]` = 当前要挂的表（pkg → `{ config }`）；**不在表内 = OFF**。
- `config` 预留（无配置编辑 UI，恒为 `null`）。
- `failed`（v0.3）：`kind` 失败分类 + `attempts` 次数（成功挂载即删；账本 ≤128 条按 `at` 淘汰最旧）。

### 5.1 持久层选址（v0.3：shell / generic 双布局）

| 模式 | 触发 | primary | legacyMirror（`.dsh/profiles/<name>/bundle-manager/registry.json`） |
|---|---|---|---|
| **shell**（桌面壳原生） | `DSH_BUNDLE_MANAGER_HOME` 为合法绝对路径（壳 main.js 注入） | 壳仓库 `plugins/dsh-bundle-manager/registry.json`——**零写 `.dsh`** | **只读**：首启一次性迁移到 primary，之后永不改写 |
| **generic**（通用 dsh） | 无 env 或 env 非法 | 插件包内 `registry.json` | 双写（v0.2 语义不回归） |

- 读链：`primary → primary.bak → legacyMirror → 默认`；坏文件改名 `.corrupt-<ts>` 后试下一源（不覆盖、不静默丢弃）。
- 写：**原子写**（`.tmp` + 同卷 rename，失败回退直写）；写前把当前可解析内容拷 `.bak`（last-known-good）。
- 上限/过滤：presets≤64 / 每 preset≤512 / failed≤128 / error≤240 字符；跳过 `__proto__`/`constructor`/`prototype` 键；`version !== 1` 视为无效（走播种）。
- **绝不写** `dsh.profile.bundles` / `package.json` 的 manifest 字段。

### 5.2 首装播种

- 首装无持久文件（`found === false`）**或**「registry 存在但 activePreset 表为空、failed 为空、树里有 boot 挂载第三方」→ 播种当前 boot 挂载态（全标 ON）——「空表」永远解释为「保持现状」，绝不发生「空 registry 全卸载」。

---

## 6. 架构与原理

### 6.1 单包双半边

```
dsh-bundle-manager/
├── cordis.patch.yml     # 单行 insert（id: bundle-manager, name: dsh-bundle-manager）
├── package.json         # name/version/exports/dsh.bundle/dsh.client
├── lib/
│   ├── index.js         # host 半边（Node 进程，ESM）
│   └── client.js        # client 半边（浏览器，CJS 工厂 __ModuleLoader__.load）
├── README.md / MANUAL.md / CHANGELOG.md
└── registry.json        # 运行时生成（勿提交）
```

- **host 半边** `inject: ['webServer', 'loader']`：读 profile / 自管持久层 / 启动期重挂 / fenced 路由 / disposer。
- **client 半边** `inject: ['slots', 'settingsUi']`：走 `dsh-settings-ui` kit 注册设置页 section。

### 6.2 运行时挂载机制

1. host 半 `ctx.loader.create({ id, name, config })` 把插件包挂进内存树；`entry.parent.remove(裸id)` 卸载。
2. 挂出去的 client 半 UI 由框架 `internal/plugin` → `ClientModuleRegistry` → `client-hmr` SSE 链路自动加载，本插件 client 半无需自实现加载。

### 6.3 启动期重挂（`apply` 内 `await` 同步执行，P8）

1. **迁移**（shell 模式首启）：legacy mirror → 壳目录 primary（原子写），mirror 只读保留。
2. **播种**（首装 / 空表 + 树有 boot 第三方，见 §5.2）。
3. **(a) remove 步**：`loader.entries()` 中「在 candidates 内、且 registry 标 OFF」的条目 → `entry.parent.remove`（每项独立 try/catch）。
4. **(b) create 步**：registry 标 ON、但树中还没有的条目 → `mountWithWatchdog`（20s 看门狗，每项独立 try/catch；失败/超时进 Failed 账本）。

> 必须 `await` 同步：ON 插件要在 `dsh web:` 就绪行打印前进入 `__DSH_BOOT__` 图（延迟重挂会让 ON 插件首屏缺失）。

### 6.4 自愈回退 + 挂载看门狗（v0.3，0.3.1 语义更新）

用户勾选挂载一个坏插件 → `loader.create` 的 fiber 启动抛错（或 **20 秒看门狗超时**）→ host 半 catch → 该 pkg 进 Failed 账本（`kind`+`attempts`）、其它插件照常。因为根本不写 manifest，**挂载不成功就不生效**，无需任何回退物。

- **失败（error）**：快速失败型（import 失败 / apply 抛错）→ 树中行移除；boot/apply/preset 三路径统一由 `preserveOnFailure` 决定表行去留（apply 转 OFF、boot/preset 保留待重试）。
- **超时（pending-timeout，0.3.1）**：timeout ≠ 失败、fiber 可能仍在启动——**保持用户意图**：表行补写/保留 + 账本记 `pending-timeout`，行不 remove，之后由 fiber 实际状态校正（`list` 可看 `waitingFor` / 状态）。避免「树里有行、表里无行 → 重启后被当表外挂载移除（用户开了却没了）」。
- **boot 分组并行（0.3.1）**：启动期挂载按 **`DSH_PM_BOOT_GROUPS`**（默认 4，有效范围 1–8）确定性分片，组间并行、组内串行，最坏启动延迟从 20s×N 降到 20s×ceil(N/G)；并行轮的快速失败项会**串行单飞重试一次**（成功 = 疑似并发干扰/依赖时序假失败、清账本；失败 = 真失败、账本 attempts+1 并输出完整 debug 日志）；**超时型绝不重试**。**`DSH_PM_BOOT_GROUPS=1` 还原旧串行行为**（并发可疑时对照复现）。并发安全性由 Cordis DI 保证（`inject` 声明 + `fiber.await()` 等待），`cordis-plugin-loader` 官方 `Group.update` 本身就是全并发 create（源码实证）。启动日志可见 `boot mount: N 插件 / G 组并行 / 失败 X / …`。

### 6.5 framework 白名单

`dsh-base` / `dsh-web-app` / `dsh-settings-ui` / `dsh-bundle-manager`（两种拼写都覆盖）禁止运行时 toggle（`framework-protected`）。这些是沙箱/凭据/settings/session 与整个浏览器壳 + client-modules 扫描的提供者。

### 6.6 可选插件判定（0.2.3 起含 node_modules 扫描）

「可选插件候选」= **并集**：① `dependencies` 里、`package.json` 有 `dsh.bundle.patch`、且不在 framework 白名单的包；② **扫 `profiles/<name>/node_modules/`**（含 `@scope/pkg`）里声明 `dsh.bundle.patch` 的包（「已装未声明」也可见可挂）。纯库（无 `dsh.bundle`）不算候选；patch 直接挂载的 provider（如 `@deepseek-ai/dsh-web-search-exa`，无 `dsh.bundle`）也不在候选内。**package.json 解析失败的依赖 → `broken-manifest` 行**（可见、不可 toggle，v0.3）。

---

## 7. 关键源码契约（开发必读）

### 7.1 Loader API（`ctx.loader`，来自 `@deepseek-ai/cordis-plugin-loader`）

| API | 说明 | 关键点 |
|---|---|---|
| `create({ id?, name, config? })` | 返回 entryId，挂载到**顶层** root group | `name` = 包名，解析到 profile `node_modules/<pkg>/` |
| `entries()` | 迭代顶层 + 所有嵌套子树条目 | 含 `include` 子树里 boot 挂载的行 |
| `store[id]` | 顶层条目字典 | 嵌套条目不在此（在 `store['include'].subtree`） |
| `remove(id)` | ⚠️ 对**嵌套**条目是静默 no-op | 它把完整路径传给 group 的裸 id remove |
| `entry.parent.remove(裸id)` | ✅ 正确卸载任意条目 | 裸 id + 直接父 group |

- `entry.id`（getter）= 完整路径（如 `include:balance`）；`entry.options.id` = 裸 id（`balance`）。
- `entry.options.name` = 包名；`entry.options.config` = 该行 config。
- fiber 状态：`entry.fiber.state === 2` = ACTIVE；`entry.fiber._error` = 失败原因（TS private，运行时可读）。

> **铁律**：卸载 boot 挂载的嵌套条目，用 `entry.parent.remove(entry.options.id)`，不要用 `loader.remove(entry.id)`。

### 7.2 `ctx.webServer.register`（fenced 路由）

```js
ctx.webServer.register({ kind: 'prefix', path: '/bundle-manager/api', handler: async (req, res) => {...} })
```

- 信封 + 围栏模式见 §4；参考 `dsh-mcp-manager` 的 `/mcp/api`。

### 7.3 `dsh-settings-ui` kit（client 半边）

- `ctx.settingsUi.createSettingsStore({ get })`：只传 `get`（列表 CRUD 用 `run` 而非 `commit`）；store 只在 `apply` 建一次，经 `inject` 传入组件。
- `ctx.settingsUi.section({ id, order, label, inject, render })`：注册设置页 section；`render` 返回 `React.Fragment`，不包裸 `<div>`。
- `useSettings(store)` → `{ doc, busy, error, saved, loaded }`；`store.run(fn)` 自动 busy/error/刷新。
- 原子组件：`ui.Card` / `ui.Switch` / `ui.StatusDot` / `ui.Banner` / `ui.Button` / `ui.Select` / `ui.TextInput` / `ui.Field` / `ui.SectionHeader` 等。

### 7.4 参考实现

| 范本 | 参考价值 |
|---|---|
| `packages/host/directory-picker-auto/src/index.ts` | 运行时 `loader.create/remove` + effect/disposer 结构 |
| `dsh-mcp-manager`（lib/*.js，npm 同名包） | fenced 路由 + 围栏 + kit 设置页 + Loader 行生命周期（**与本插件最同形**） |
| `dsh-settings-ui`（lib/client.js + GUIDE.zh.md，npm 同名包） | kit API 权威 |
| `apps/cli/src/plugin.ts`（`exportsPatch`）、`boot/app-boot/src/profile.ts` | bundle 判定 / profile 装配源码事实 |

---

## 8. 开发流程

### 8.1 目录与构建

- 纯 JS，无构建步骤：host 半边 ESM、client 半边 CJS 工厂；**禁止 TS 语法 / JSX / `import`（client）**。
- 校验：`node --check lib/index.js lib/client.js`。

### 8.2 改 → 验 → 发布（流程 A）

1. 改 `lib/*.js` → `node --check`。
2. bump `package.json` patch 版本（**必做**，见 P4）。
3. 同步源码到壳仓库 `plugins/dsh-bundle-manager/` 副本 → `npm pack --cache <npm-cache-dir>`。
4. 更新 profile `package.json` 的 `file:` 路径 → `pnpm install --no-frozen-lockfile`。
5. dev 壳（`rc6-dev` profile）验证 → web 端复验（浏览器打开壳实例；原 web-dev 复测命令已删除 2026-08-18，见全局 HANDOFF §2）→ 同步稳定壳 + push。

> 本地快速迭代可临时「直接覆盖 `node_modules/dsh-bundle-manager/lib/index.js` + 重启 dsh」绕过 pack/install，正式发布仍走 bump+pack。

### 8.3 验证清单（自检）

- [ ] `node --check lib/index.js lib/client.js` 通过。
- [ ] **`node test/harness.mjs` 159 断言全过**（v0.3 起：迁移/坏文件保底/播种/broken-manifest/看门狗/storage-error/框架保护/预设 diff/generic 双写；含一个 ~20s 用例）。
- [ ] 设置页列表正确（包名 + 版本 + state；broken-manifest 行黄色点禁用；failed 行带分类+次数；storage 告警条）。
- [ ] toggle 开关 → 内存树该行出现/消失；registry 更新；无重启。
- [ ] 重启 → 按表重挂（shell 模式 registry 在壳目录，`.dsh` mirror 不再被写）。
- [ ] 挂坏插件 → 进 Failed 组（kind+attempts）、其它照常、可重试；永不 settle → 20s 看门狗超时进 `pending-timeout`。
- [ ] 预设切换 → diff 生效（共有插件不折腾）。
- [ ] 拒绝 framework 包 toggle。
- [ ] **不写** `profiles/<name>/package.json` 的 `dsh.profile.bundles`。
- [ ] disposer 逆序卸载自建行。

---

## 9. 踩坑与边界（重要）

1. **嵌套条目 + `loader.remove` no-op**：见 §7.1，卸载用 `entry.parent.remove(裸id)`。
2. **pnpm `file:` 同版本缓存**：改代码必 bump 版本（P4）。
3. **`dsh-wechat-bridge` exact 路由**：同会话「卸载→重挂」会 `duplicate exact route`；进 Failed 组、重启恢复。走 `ctx.effect` 注册路由的插件无此问题（P6）。
4. **client unload stub**：host 半卸载后 client 半 UI 残留，需手动刷新页面（官方 `packages/client/runtime/README.md:91`）。
5. **环境变量**：官方不暴露 profile 环境；读 `process.env.DSH_PROFILE`（壳注入）→ 从本包路径推导 → 回退 `'web'`；仅用于**读**目录。`DSH_BUNDLE_MANAGER_HOME`（v0.3，壳注入）决定 registry 落壳仓库（shell 模式）还是 v0.2 双写（generic）；非法值告警回退 generic。
6. **framework 白名单**：dsh-base/dsh-web-app/dsh-settings-ui/本插件禁止 toggle。
7. **沙箱/审批**：写 `$DSH_HOME`、`pnpm install`、跑 dsh CLI 都需 `danger-full-access`。
8. **git push**：沙箱走 HTTPS + `gh auth token` 内嵌（P5）。

---

## 10. 安全

- 客户端经浏览器信任围栏（loopback + 同源，与 `/api` 网关一致）访问路由；fence 非鉴权层（威胁模型 = 本机信任，官方一致）。
- 不读写凭据；不改 approval/sandbox/credentials 配置；`cordis.patch.yml` 只做 insert、无 `!!js`。
- 无 `eval`/`Function`/`child_process`/外部 `fetch`。
- 用户输入（pkg / 预设名）进文件系统路径前先白名单校验（pkg 必须命中 `dependencies` 键；预设名 `^[A-Za-z0-9_-]{1,32}$`）。
- 写 JSON 用 `fs.writeFileSync`（2 空格 + 尾换行 + 无 BOM），杜绝 PowerShell `Set-Content -Encoding UTF8` 的 BOM 事故。

---

## 11. 关联资源

- 快速入门：`README.md`
- 官方插件开发：`dsh-plugin-development` skill（deepseek-harness 文档）
- 运行时挂载范本：`<dsh checkout>/packages/host/directory-picker-auto/src/index.ts`
- 同型参考：`dsh-mcp-manager`（fenced 路由/kit 同形）
- 关键源码事实：`@deepseek-ai/cordis-plugin-loader`（`src/config/{tree,entry,group}.ts`）
