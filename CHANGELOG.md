# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.6] - 2026-08-20

### Changed（全 UI 双语 + 双轨操作收口 + 行/预设卡样式回归）

- **全 UI 中英双语（locale.register + bind）**：新增 `DICT_ZH` / `DICT_EN` 双字典，`apply` 时 `ctx.locale.register('dsh-bundle-manager', { zh, en })` + `bind` 出 `t`，`section()` 声明 `locale` 命名空间；locale 服务缺席时回退中文。全部文案（状态 / 失败分类 / 按钮 / 对话框 / toast / 提示）走字典 + `{param}` 插值。
- **双轨整卡移除 → 头部「导入/导出」下拉菜单**：官方共存双轨整卡删除，改为设置卡头部「导入/导出」下拉（官方静态层导入列表 + 全选、bm 托管批量导出 / 卸载、导出全部安全网、回滚上次导入）。
- **托管行行内导出/卸载**：`managed-by-bm` / `pending-import` 托管行右侧新增「导出 / 卸载」小按钮，无需先勾选即可单行操作。
- **预设卡改官方卡壳模型（pcard，可收起）**：`OfficialSectionCard`——默认收起 layer-3 亮面 + 官方 `IconChevronDownOutline14` 旋转，展开 layer-2 页面同色 + 切换器 / 保存 / 删除 / hint；折叠状态沿用 localStorage。
- **行卡恢复 v0.4.4 样式**：0.5.4 行卡官方卡壳模型回退——恢复 `ui.Card row:true` + `sui-card-title/main/meta` + 右侧 Switch 的 v0.4.4 行样式，不再使用独立 `PluginRowCard` 组件。

### Fixed

- **版本徽章判断改走字典**：`row.version !== tk('unknown')`（替换硬编码中文「未知」），行卡版本徽章跟随当前语言。
- **broken-manifest 开关提示改 `row.state` 直判**：移除旧 `brokenManifest` 局部变量路径，提示语走字典 `switchBroken`。

## [0.5.5] - 2026-08-20

### Fixed

- **PluginRowCard 全部改用 `ui.h`**（0.5.4 误用未定义的裸 `h` → 行卡渲染抛 `h is not defined`，点击导入/任何行卡挂载触发「该设置页渲染出错」错误边界）。

## [0.5.4] - 2026-08-20

### Changed（挂载行卡转官方卡壳模型，配套 kit 0.4.0）

- **插件行卡 = 官方 PluginCard 模型**（对齐 kit `pluginCard` official chrome）：收起 `layer-3` 亮面 + 名称/状态描述（版本·状态·失败分类·等待服务）+ 官方 `IconChevronDownOutline14` 旋转；展开 `layer-2` 页面同色 + 挂载开关行 + 错误信息。图标经 `settingsUi.official` 指针复用官方基元。
- 依赖 kit `>=0.3.0` 不变（官方卡壳 CSS 随 kit 0.4.0 提供）。

## [0.5.3] - 2026-08-19

### Changed（壳窗②用户实测 UI 批次：折叠 + 显隐 + 节奏统一）

- **双轨/预设卡折叠（A）**：两卡默认收起为一行标题（带计数/当前预设 + ▸/▾），展开状态存 localStorage（`dsh-bundle-manager.ui.collapsed.v1`）。
- **按状态显隐（B）**：官方共存卡在「无静态层包且无托管包」时整卡隐藏；预设切换器仅在预设数 >1 时显示。
- **多选批量**（0.5.1 延续）：静态层/托管行复选框 + 卡头全选 + 批量导入/导出/卸载按钮。
- **导出放行未托管候选**（0.5.1 延续）：已装可选 bundle 无需 bm 托管行即可固化到官方静态层。
- **官方核心 scope 排除候选**（0.5.2 延续）：`@deepseek-ai` scope 不再进入候选列表（headless 事故修复）。
- **垂直节奏统一交给 kit**：删除 bm 全部 ad-hoc 间距（卡 margin / 行 marginBottom / 动作栏 marginTop），间距由 kit 0.3.0 的节奏规则集（卡间 8px、区块 12px、卡体 stack 10px，对齐官方设置页）统一控制；**peer 依赖升 `dsh-settings-ui >=0.3.0`**——消费方不再各自手调 UI 间距，未来 UI 问题改 kit 即可。

### 其他

- `test/harness.mjs`：T20 扩展（未托管候选导出）+ 新增 T24（官方 scope 排除 + 非核心孤儿保留），**216 断言全绿**。

## [0.5.2] - 2026-08-19

### Changed（壳窗②实测事故修复：候选发现混入官方核心包）

- **候选发现排除整个 `@deepseek-ai` 官方 scope**：node_modules 扫描（P9 孤儿捕获）不再把官方核心家族包当候选——其中 runner 型 bundle（如 `dsh-headless`，patch 含 `code-runtime` 行）被误导出进静态层会与基础层重复行 ID 直接 brick boot（2026-08-19 rc7-bm 实测：`duplicate loader entry id: code-runtime`）。非 `@deepseek-ai` scope 的孤儿插件仍可发现（P9 保留）。

### 其他

- `test/harness.mjs` 新增 T24：`@deepseek-ai/dsh-core-x`（官方 scope bundle）不进候选列表；非核心孤儿 `dsh-orphan` 仍可发现。

## [0.5.1] - 2026-08-19

### Changed（壳窗②用户实测反馈修复）

- **`export-to-bundles` 放行未托管候选**：已装可选 bundle（候选、无 registry 行）也可直接「导出到官方」固化——不再要求 bm 托管行（此前未挂载插件导出报 `not-managed`）。有行则同时标 `superseded-by-static`；无行仅加进 `dsh.profile.bundles`。未安装/非候选仍拒绝。
- **双轨 UI 多选批量**：官方静态层卡与 bm 托管卡的行加复选框 + 卡头全选；勾选后出现「批量导入到 bm（n）」「批量导出到官方（n）」「批量卸载（n）」；操作完成后清空选择。
- **双轨行垂直间距**：`sui-row` 在 kit CSS 未定义（行无间距、按钮上下紧贴）→ 行样式补 `marginBottom: 8px`，批量按钮栏补 `marginTop: 8px`。

### 其他

- `test/harness.mjs` T20 扩展：未托管候选导出断言（`dsh-plain` 已装未托管 → 导出成功加入 bundles）；未安装包导出仍 rejected。

## [0.5.0] - 2026-08-19

### Added（对外双轨 + 卸载半边，见 BM0.5-IMPLEMENTATION-PLAN）

- **官方共存（三处落点）**：
  - `candidates` 排除集 = framework 白名单 ∪ 当前 `dsh.profile.bundles`（现读 manifest、不缓存）——已在官方静态层的包不再给「可管理/toggle」入口。
  - boot / apply / preset 的 create 前 `!bundles.includes(pkg)` 过滤——防「官方静态层 + bm 运行时」**双重挂载**；静态层包的行自动收敛为 `superseded-by-static`。
  - registry 行状态机：`managed-by-bm`（bm 运行时挂）｜`superseded-by-static`（已固化，bm 不 create、list 只读展示、禁止 toggle）｜`pending-import`（已导入、待重启接管）。旧格式行（无 state）向后兼容归一化为 `managed-by-bm`。
- **导入 / 写回（FUTURE-DIRECTION §2.5，fenced 路由 + 引导重启生效）**：
  - `import-to-bm { pkg[] }`：官方 → bm——白名单校验（必须在 dependencies）→ 从 `dsh.profile.bundles` 摘条 → registry 行预注册（原静态层包标 `pending-import`、deps-only 包标 `managed-by-bm`）→ 引导重启接管。
  - `export-to-bundles { pkg[] }`：bm → 官方固化——加进 `dsh.profile.bundles` → 行标 `superseded-by-static` → 引导重启（永久随 dsh 启动）。
  - `export-all-to-bundles`：卸载安全网——批量写回全部托管，随后 `dsh plugin remove dsh-bundle-manager` 可全身而退、功能不丢。
- **A 级安全冗余（§2.6 五条，导入/导出全走）**：
  1. 原子写 + 备份 + JSON.parse 回滚：写 profile manifest（临时文件 + rename）前备份 `package.json.bm.bak`，写后解析失败自动回滚；坏 manifest 拒绝写入。
  2. 预注册 + 失败可见：导入先置 registry 行 enabled，失败进 `failed` 账本 + UI 明示「未接管 n 个」；`import-to-bm` 返回 `imported` / `rejected`（含 code+message）。
  3. 一键回滚批次：写前生成快照（被改 manifest 片段 + 受影响行前状态），`import/rollback { id }` 写回 bundles + 还原行 + 引导重启。
  4. 依赖组感知（提示级）：导入前查导入包的直接 dependencies，提示「A 还依赖 X，建议同批次导入」（进程内轻量启发式，近似 `pnpm why` 直接层）。
  5. framework 白名单保留：import / export / export-all / uninstall 均拒框架核心包。
- **卸载半边（§1.2）**：
  - `uninstall { pkg[] }`：**先 bm 出库**（清 registry 行，batch，只动 bm 自有文件、不碰 manifest）→ **引导**官方 `dsh plugin remove pkg...`（官方透传 pnpm、支持批量、reconcile 自动收 bundles）。顺序论证：先出库后 remove——官方失败退化成 dormant dependency（可逆：registry 行写回 enabled 即恢复管理）。
  - **反应式 GC（保险丝）**：boot 后扫 registry，行对应包已不在 deps 且不在 node_modules（被外部官方直删、绕过 bm）→ 清行 + 记 `failed`（kind `not-a-bundle`、提示「外部移除」）。
- `list` 返回新增：顶层 `bundles`（官方静态层只读）；每行 `regState`；新增只读行 `superseded-by-static` / `pending-import`。
- 新增错误码 `superseded-by-static`（对静态层包 apply ON 被拒）。

### 其他

- `test/harness.mjs` 新增 T17–T23（状态机迁移 / create 过滤防双重挂载 / import 原子写+.bm.bak+失败可见 / export 固化 / 一键回滚批次 / uninstall 顺序+dormant 可逆 / 反应式 GC），共 **210 断言全绿**。

## [0.4.5] - 2026-08-17

### Changed

- README 重构为 dsh-market 风格：**主 README.md 英文** + 新增 `README.zh.md` 中文（原 README.en.md 移除，npm/GitHub 均以英文为默认展示）；加 npm/stars 徽章。

## [0.4.4] - 2026-08-17

### Changed

- **保存「新」预设自动设为当前激活**（`preset/save` 返回 `activated`）：随后「保存并刷新」应用的就是刚保存的预设——消除「保存了预设2、保存并刷新却改了预设1」的时序困惑；**覆盖已有预设不切换激活**（只更新记录，仍弹覆盖确认）。toast 文案区分两种结果。
- **预设卡按钮横排平分整行**（`flex:1`，保存/删除各占一半）；**「删除预设」按钮改用危险红**（`sui-btn-danger`）。
- MANUAL/README：预设语义（新预设自动激活 + 覆盖不切换）与按钮说明同步。
- `test/harness.mjs`：T8 适配新语义（保存后显式切回再操作）、T15 补激活/覆盖断言，共 **159 断言全绿**。

## [0.4.3] - 2026-08-17

### Added

- **`preset/delete` API**：多选删除预设（`names` 数组）；防御：拒删 `default`、拒删**当前激活预设**（先切换再删）、拒非法名/空数组/超量。
- **「删除预设」UI**：预设卡新增「删除预设」按钮 → 弹**多选选择器**（`ui.Rows` checkbox，`default` 与当前激活预设不可选）→「下一步」→ **不可逆确认 Dialog**（列出将永久移除的预设名）→ 删除后自动刷新列表。
- **保存预设成功 toast 提示**：「预设已保存。若需应用当前挂载组合，请点击『保存并刷新』。」（`ui.ToastHost` 承载）——消除「保存预设后到底要不要再刷新」的歧义。
- `test/harness.mjs` +T16（多选删除/拒 default/拒激活/非法输入），共 **148 断言全绿**。

### Changed

- MANUAL/README：预设区新增「删除预设」说明与「保存预设不应用挂载」提示。

## [0.4.2] - 2026-08-17

### Added

- **`preset/save` 支持 `draft` 合并**：客户端把当前草稿勾选（未提交）一并存入预设快照（`true` 保留/新增、`false` 移除），**不实际挂载**——「勾选 → 保存预设」一步到位，预设 = 想要的组合，无需先「保存并刷新」后再存（消除先保存预设还是先刷新的时序困惑）。
- **同名预设覆盖确认**：保存已存在的预设名时弹确认 Dialog（取消/覆盖），杜绝静默覆盖旧组合。
- `test/harness.mjs` +T15（draft 合并不实际应用 + 草稿 OFF 项移除 + 非法 draft 拒绝），共 **138 断言全绿**。

### Changed

- MANUAL/README：「保存为预设」语义更新（含草稿合并 + 覆盖确认）。

## [0.4.1] - 2026-08-17

### Changed（UI / UX）

- **移除顶部「刷新」按钮**：其语义（放弃草稿 + 重拉列表）与「放弃更改」重叠且无操作反馈；挂载表唯一写者是本 UI 的「保存并刷新」（保存后硬刷新页面），手动重拉场景在本架构（单实例 + 唯一写者）下不存在，且「刷新」命名易被误读为「重载页面」。防误读/减困惑。
- **列表拉取失败 → 错误横幅 + 「重试拉取」按钮**（语义精确、有反馈；非静默、非盲点）。
- 说明（MANUAL §3/README §3.3）：启动列表完整性由架构保证（boot 同步 reconcile 晚于就绪行前完成 + client 后于 host 激活），挂载中的插件以「挂载中/等待服务」状态行呈现并自行 settle——**不存在「需二次点击补全」的场景**。

## [0.4.0] - 2026-08-17

### BREAKING（改名）

- **改名：`dsh-plugin-manager` → `dsh-bundle-manager`**（对外身份全链路：`package.json` name / cordis id+name / host `export name` / client `__ModuleLoader__` id / fenced API 前缀 `/bundle-manager/api` / console 与 effect 日志前缀 / `DSH_PLUGIN_MANAGER_HOME` → `DSH_BUNDLE_MANAGER_HOME`）。裸名 `dsh-plugin-manager` 已被第三方（liqichen@0.1.0）占用，且「plugin-manager」语义与社区同类撞车；`dsh-bundle-manager` 名副其实（bundle 运行时挂载/卸载）且 npm 实测可注册。
- `FRAMEWORK_BUNDLES` 白名单：`'dsh-plugin-manager'` → `'dsh-bundle-manager'`（移除旧裸名——防止误保护同名第三方包）。
- **registry 持久层迁移（保持挂载表）**：新包首启若新 primary 不存在，自动从**旧改名路径**合并——旧 mirror `profiles/<name>/plugin-manager/registry.json` > 旧 primary（旧包目录内）——写入新布局 primary；旧路径只读保留。新布局 mirror 路径改为 `profiles/<name>/bundle-manager/registry.json`。
- **兼容**：旧环境变量 `DSH_PLUGIN_MANAGER_HOME` 仍作为只读回退生效（旧部署不破）；旧 registry 路径可读（读源兼容）。

### 其他

- 本轮还同步携带既有 0.3.1 能力（boot 分组并行挂载 + 串行单飞重试、挂载超时保持用户意图、failed.at 校验）——历史条目见 0.3.1/0.3.0。
- `test/harness.mjs` 新增 T14 改名迁移用例（旧→新路径合并 + 旧 env 回退），共 **131 断言全绿**。

## [0.3.1] - 2026-08-17

### 新增
- **boot 分组并行挂载**：待挂载插件按 `DSH_PM_BOOT_GROUPS`（默认 4，1–8）确定性分片，组间并行、组内串行；最坏启动延迟从 20s×N 降到 20s×ceil(N/G)；`=1` 即旧串行行为（并发可疑时对照复现）。
- **串行单飞重试**：并行轮的快速失败项逐项单飞重试一次——区分「并发干扰/依赖时序假失败」（重试成功、清账本、留日志）与「真失败」（attempts+1、完整 debug 日志）；**超时型（pending-timeout）绝不重试**（fiber 仍在启动，重试=先杀可能即将成功的 fiber）。
- 启动汇总日志：`boot mount: N 插件 / G 组并行 / 失败 X / 单飞成功 Y / 真失败 Z`。

### 变更
- **挂载超时语义统一（P1-B）**：timeout ≠ 失败——三路径（boot/apply/preset）统一为「保持用户意图」：表行补写/保留（apply ON 路径原本无行，超时也写入）、账本记 `pending-timeout`、fiber 继续启动后由实际状态校正；消除「树里有行、表里无行 → 重启后被当表外挂载移除（用户开了却没了）」的分叉。
- `mountRow` 返回挂载结果（`created|error|timeout`）供 boot 调度器使用（对外行为不变）。
- `normalizeRegistry` 校验 failed 记录的 `at`（非有限数字归 0），防损坏文件破坏账本淘汰排序。

## [0.3.0] - 2026-08-16

### 新增
- registry 迁壳目录：桌面壳注入 `DSH_BUNDLE_MANAGER_HOME` 时采用 **shell 布局**——挂载表只写壳仓库 `plugins/dsh-bundle-manager/registry.json`，零写 `.dsh`；旧 `.dsh` mirror 首启一次性迁移后只读保留；无 env 的通用 dsh 保持 v0.2 双写语义（generic 布局）不回归。
- 原子写（`.tmp` + 同卷 rename，写前拷 `.bak` last-known-good）；坏 registry 改名 `.corrupt-<ts>` 隔离并从 `.bak` 恢复。
- 空 registry 播种语义修正：空表 + failed 为空 + 树里有 boot 挂载第三方 → 播种全 ON，永不解释为全 OFF（P2/W3）。
- 坏 package.json 清单的依赖以 `broken-manifest` 行可见（黄色点、开关禁用、toggle 拒绝）。
- 20 秒挂载看门狗：挂载永不 settle 时 HTTP 照常返回，行保留（fiber 可能仍在启动），进 failed 账本 `kind:'pending-timeout'`；pending 行附 `waitingFor` 服务名。
- failed 账本分类：`{error, at, kind, attempts}`，kind ∈ import-failed/activate-failed/pending-timeout/config-invalid/manifest-invalid/not-a-bundle/unknown，账本 ≤128 条按时间淘汰。
- 变更互斥：apply / preset/switch / preset/save 经串行队列执行（30s 上限 → `code:'timeout'`）；写盘失败可见（响应 `storage-error` + `list.storage` 状态块 + 设置页警示条）。
- 本插件自身永不拖垮启动：boot effect 与路由注册 effect 整体 try/catch，fiber 永不 FAILED。
- client UI：broken-manifest 状态点、pending waitingFor、failed 分类+次数、存储状态警示条。
- 离线回归 harness：`test/harness.mjs`（46 断言，mock ctx 直驱 fenced API；覆盖迁移/坏文件恢复/播种/看门狗/storage-error/框架保护/预设 diff/generic 双写/env 校验）。

### 变更
- `list` 返回结构扩展：每行增加 `waitingFor` / `kind` / `attempts`；顶层增加 `storage:{path,mode,writable,lastError}`；`state` 增加 `broken-manifest`。
- 错误码新增 `storage-error`、`timeout`。
- 挂载失败时表语义：apply 路径失败转 OFF；boot/preset 路径保留重试。

## [0.2.3] - 2026-08-16

### 新增
- node_modules 扫描探测：候选 = `dependencies` 声明 + `node_modules` 物理扫描的并集，「已装未声明」的 bundle 插件也能被发现并挂载（P9）。

## [0.2.2] - 2026-08-16

### 修复
- 启动期重挂改为 `apply` 内 `await` 同步执行（去掉 800ms 延迟），ON 插件在 `dsh web:` 就绪行打印前进入 `__DSH_BOOT__` 图，首屏即显示（P8）。

## [0.2.1] - 2026-08-16

### 新增
- 设置页标题显示插件自身版本号。

## [0.2.0] - 2026-08-16

### 新增
- framework-only bundles 架构：第三方插件移出 `dsh.profile.bundles`（只留 base/web-app/settings-ui/plugin-manager），全部由本插件运行时挂载。
- 草稿式「保存并刷新」UX：开关只改本地草稿，`apply` 端点一次性 diff 应用 + 客户端硬刷新（统一装载/取消装载，规避 client 无卸载链，P7）。
- `list` 返回统一 `plugins[]` 列表。

## [0.1.5] - 2026-08-16

### 修复
- 预设卡片改竖排布局（row 卡挤压导致状态文字逐字换行）。

## [0.1.4] - 2026-08-16

### 修复
- 预设切换改 **diff** 语义（只卸离开项、只挂进入项，共有项不折腾），规避 `duplicate exact route`（P6）。

## [0.1.3] - 2026-08-16

### 尝试（未解决，见 0.1.4）
- 预设切换 remove/create 之间加 300ms settle 延迟（对精确路由残留无效）。

## [0.1.2] - 2026-08-16

### 修复
- 卸载统一走 `entry.parent.remove(裸id)`，修复 `loader.remove(完整路径)` 对嵌套条目静默 no-op（P3）。

## [0.1.1] - 2026-08-16

### 尝试（未解决，见 0.1.2）
- 卸载改传 `entry.id` 完整路径（仍 no-op）。

## [0.1.0] - 2026-08-15

### 新增
- 首版：运行时挂载层 + registry 持久 + fenced 路由（/bundle-manager/api）+ kit 设置页。
