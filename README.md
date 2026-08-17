> **English**: [README.en.md](./README.en.md) · 完整手册：[MANUAL.md](./MANUAL.md)

# dsh-bundle-manager

DSH Web/桌面端插件：在设置页提供一个「插件挂载管理」section，对**可选第三方插件 bundle** 做运行时挂载/卸载——**瞬时生效、零重启、不写 profile manifest**。

## 0. 关键架构要求（必读）

第三方插件必须**移出 `dsh.profile.bundles`、只留在 `dependencies`**，让 plugin-manager 成为唯一挂载入口：

```jsonc
// profiles/<name>/package.json —— bundles 只留框架核心
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-settings-ui",
  "dsh-bundle-manager"
] } }
// 其余第三方插件（better-sidebar / mcp-manager / conversation-search …）只在 dependencies 里
```

**为什么**：若第三方插件仍写在 bundles 里，boot 时它们的 client 半边会被扫进初始 `__DSH_BOOT__` 图，而 dsh 客户端没有卸载链（`loader.unload` 是 stub）+ 共享 HMR 关闭 → 运行时「取消挂载」无法把已加载的 client UI 撤掉。移出 bundles 后，OFF 插件从不进图、首屏就不加载；ON 插件由 `loader.create` 挂上后进图。

## 1. 它做什么 / 不做什么

| | 说明 |
|---|---|
| ✅ 做 | 列出所有可选插件（统一列表 + 当前状态）；**草稿式开关**：勾选要挂载的插件 → 点「保存并刷新」一次性应用并自动刷新页面；预设保存/切换；坏插件挂载失败进 Failed + 可重试 |
| ❌ 不做 | **安装/卸载插件**（`dsh plugin add/remove` 的事）；**改写 `dsh.profile.bundles`**；重启 dsh；碰 `.dsh/profiles/<name>/package.json` |

**交互模型（v0.2）**：开关只改**本地草稿**，不做任何即时生效；点「保存并刷新」才把整张表 POST 给 host → host diff 应用（create/remove）+ 持久化 → 客户端硬刷新页面。装载与取消装载走同一条「保存 + 刷新」流程，避免 client 无卸载链带来的混乱。

## 2. 安装

```sh
dsh plugin --profile <name> add <path-to-this-package>
```

然后按 §0 把第三方插件移出 bundles，重启该 profile 的 dsh 实例，设置 → 插件挂载管理。

## 3. 结构与原理

```
dsh-bundle-manager/
├── cordis.patch.yml    # 单行 insert（id: plugin-manager, name: dsh-bundle-manager）
├── package.json        # name/version/exports/dsh.bundle/dsh.client
├── lib/
│   ├── index.js        # host 半：读 profile / 自管持久层 / 启动期重挂 / fenced 路由 / disposer
│   └── client.js       # client 半：window.__ModuleLoader__.load CJS 工厂 / kit Section UI
├── test/harness.mjs    # 离线回归（mock ctx 直驱 fenced API，159 断言；scratch 自动清理）
├── README.md / MANUAL.md / CHANGELOG.md
└── registry.json       # （运行时生成，勿提交）挂载表：shell 模式在壳仓库，generic 在包内+profile mirror
```

### 3.1 运行时挂载机制

- host 半 `inject: ['webServer', 'loader']`，用 `ctx.loader.create({ id, name, config })` / `entry.parent.remove(裸id)` 挂载/卸载别的插件包（范本：官方 `directory-picker-auto`）。
- 「保存并刷新」= host 一次性 diff 应用 → 客户端 `location.reload()` 重新拉取已更新的 `__DSH_BOOT__` 图 → ON 插件 client UI 加载、OFF 插件 client UI 消失。**不依赖 client-hmr / 不依赖 client 卸载链**。

### 3.2 持久层（v0.3：shell / generic 双布局，零 .dsh manifest）

挂载表 schema：

```json
{
  "version": 1,
  "activePreset": "default",
  "presets": {
    "default": { "dsh-balance": { "config": null } },
    "work": { "…": { "config": null } }
  },
  "failed": { "some-bad-plugin": { "error": "…", "at": 1700000000000, "kind": "activate-failed", "attempts": 2 } }
}
```

- `presets[activePreset]` = 当前要挂的表（pkg → `{ config }`）；不在表内 = OFF。
- **shell 模式**（桌面壳注入 `DSH_BUNDLE_MANAGER_HOME`，指向壳仓库 `plugins/dsh-bundle-manager/`）：挂载表只写在壳仓库，**零写 `.dsh`**；旧的 `.dsh/profiles/<name>/bundle-manager/registry.json` 首启一次性迁移后**只读保留**。
- **generic 模式**（无 env 的通用 dsh）：写包内 `registry.json` + 双写 `.dsh` 下 mirror（v0.2 语义）。
- 写入为**原子写**（`.tmp` + rename，`.bak` 保底）；坏文件改名 `.corrupt-<ts>` 后从 `.bak` 恢复，**不静默丢弃**。
- 两处都**不写** `dsh.profile.bundles`。

### 3.3 回退自愈

挂载一个坏插件 → `loader.create` 的 fiber 启动抛错（或 20 秒看门狗超时）→ host catch → 进 Failed 组（带失败分类 kind + 次数）、其它插件照常。因为不写 manifest，**挂载不成功就不生效**，无需回退物。

- **挂载超时 = 保持用户意图**（不是失败）：表行保留、fiber 继续启动、账本记 `pending-timeout`，由实际状态校正——不会「开了却重启后没了」。
- **boot 并发可调**：启动挂载默认 4 组并行（可设环境变量 `DSH_PM_BOOT_GROUPS`，1=完全串行，1–8 有效），快速失败项自动串行单飞重试一次以区分「并发假失败」与「真失败」；详见 MANUAL §6.4。
- **UI 无「刷新」按钮（0.4.1）**：挂载表唯一写者是本页「保存并刷新」（保存后硬刷新），手动重拉场景不存在；列表拉取失败会显示错误横幅 + 「重试拉取」（语义精确、有反馈）；挂载中的插件显示「挂载中/等待服务」，会自行 settle。

## 4. 边界

- **framework 白名单不可下放**：`dsh-base` / `dsh-web-app` / `dsh-settings-ui` / 本插件自己禁止 toggle（`framework-protected`）。
- **「可选插件」判定** = `dependencies` 里、`package.json` 有 `dsh.bundle.patch` 且不在 framework 白名单的包。纯库（无 `dsh.bundle`）不算候选。
- **假设每个受管 bundle 的主入口 entry 名 == 包名**（所有单 plugin 单行 `insert` 的 bundle 都满足）。

## 5. 已知限制（务必阅读）

1. **「保存并刷新」的硬刷新是唯一的 client 同步手段**：dsh 客户端 `loader.unload` 是 stub、共享 HMR 关闭，所以本插件用「应用 + 刷新页面」统一装载与取消装载，而不是运行时卸载 client 模块。
2. **带精确路由的 host 插件，卸载后立即重挂可能报「duplicate exact route」**（如 `dsh-wechat-bridge` 用 `disposers.push(webServer.register({kind:'exact'}))` 注册路由，卸载时路由未即时释放）。会进 Failed 组、其余照常，重启可恢复；走 `ctx.effect(() => webServer.register(...))` 的插件无此问题。预设切换已用「diff」避免对共有插件做无谓 remove+recreate。
3. **环境变量**：`DSH_PROFILE`（读 profile 目录用，桌面壳 main.js 注入，缺失从包路径推导再回退 `'web'`）；`DSH_BUNDLE_MANAGER_HOME`（v0.3，桌面壳注入，挂载表落壳仓库、零写 `.dsh`；缺失/非法回退 generic 双写）。
4. **config 编辑未实现**：挂载表里的 `config` 预留（默认 `null`）。带 config 的插件后续 UI 再补。
5. **写盘失败会明示**（v0.3）：registry 写失败时，操作响应返回 `storage-error`、设置页顶部出现黄色警示条（「本次更改重启后可能失效」）；挂载本身在内存已生效。
6. **兼容性**：开发/实测基准为 deepseek-harness **0.1.0-rc.5**（`@deepseek-ai/cordis` 4.x rc、`dsh-host-webserver`/`dsh-client-runtime`/`dsh-client-ui-slots` 0.1.x rc）。**rc.6 实测通过（2026-08-17）**：rc5 与 rc6 源码同 commit（`47f9438`，仅 npm bump），rc6 内核下运行时挂载/卸载、framework 白名单、坏插件隔离（Failed 组 + kind/attempts）、预设切换、registry 落盘、client 半全部通过，**零代码适配**。已知差异：`link:` 挂载因 ESM 解析失败，须用 `file:` tgz；plugin-manager 用自有 fenced 路由，不依赖 rc5 的 `WEB_SETTINGS_NAMESPACES` 本地补丁。升级 dsh 版本后请重跑 `npm test` 与 dev 壳两阶验证。

## 6. 安全

- 客户端经浏览器信任围栏（loopback + 同源，与 `/api` 网关一致）访问 `/bundle-manager/api`；fence 非鉴权层（威胁模型 = 本机信任，官方一致）。
- 不读写凭据；不改 approval/sandbox/credentials；cordis.patch.yml 只做 insert、无 `!!js`；无 `eval`/`Function`/`child_process`/外部 `fetch`。
- 用户输入（pkg / preset 名）进文件系统路径前先白名单校验；写 JSON 用 Node `fs`（原子写 + 无 BOM）。
- 许可证：MIT（见 `LICENSE`）。参考实现致谢：官方 `packages/host/directory-picker-auto`（运行时挂载范本）与 `dsh-mcp-manager`（fenced 路由/kit 同形）。

## 7. 开发验证

```sh
node --check lib/index.js lib/client.js     # 纯 JS，无构建步骤
node test/harness.mjs                       # 离线回归：46 断言（迁移/坏文件/播种/看门狗/存储错误/框架保护/预设 diff）
npm pack --cache <npm-cache-dir>            # 出 tgz（file: 挂载，禁 link:）
```

- dev 壳（`dsh-desktop-shell-dev`，挂 `desktop-dev` profile）验证；报错只在 dev、稳定 desktop 永远可用。
- 参考实现：`dsh-mcp-manager`（同型列表 + kit）、官方 `packages/host/directory-picker-auto`（运行时挂载范本）、`dsh-settings-ui`（kit）。
