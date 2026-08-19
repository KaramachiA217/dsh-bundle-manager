/**
 * dsh-bundle-manager client half: the "插件挂载管理" settings section.
 *
 * Served as a classic script at /plugins/dsh-bundle-manager/client.js and
 * registered through window.__ModuleLoader__.load(...) — the DSH client bundle
 * contract. The factory returns a Cordis plugin object; the kernel adopts it
 * and calls apply(ctx) with the client services.
 *
 * UX model (v0.2): switches edit a LOCAL draft; nothing is applied until the
 * user clicks「保存并刷新」, which POSTs the whole desired table to the host,
 * awaits the host-side apply, then hard-refreshes the page. A single
 * save+reload for both ON and OFF makes the client halves reconcile reliably
 * (dsh's client has no unload chain and shared HMR is disabled, so the only
 * trustworthy way to sync the browser is to reload the __DSH_BOOT__ graph).
 *
 * v0.3 additions (HANDOFF-v0.3.md task 4):
 * - `broken-manifest` rows: yellow dot, error text, switch disabled.
 * - pending/loading rows show their `waitingFor` services.
 * - failed rows show the failure kind (Chinese label) + attempt count + error.
 * - storage warning banner when the registry is not writable.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bundle-manager',
  factory: (require) => {
    const React = require('react')
    const { useEffect } = React

    // ── API client ──────────────────────────────────────────────────────────
    async function call(method, payload = {}) {
      const res = await fetch(`/bundle-manager/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let json
      try {
        json = await res.json()
      } catch {
        throw new Error(`插件管理 API ${method} 返回了非 JSON 响应（HTTP ${res.status}）`)
      }
      if (!json.ok) {
        const message = json.error?.message ?? '未知错误'
        const err = new Error(message)
        err.code = json.error?.code
        throw err
      }
      return json.value
    }

    const STATUS = {
      active: { key: 'stActive', color: '#22c55e' },
      loading: { key: 'stLoading', color: '#eab308' },
      pending: { key: 'stPending', color: '#9ca3af' },
      unmounted: { key: 'stUnmounted', color: '#9ca3af' },
      failed: { key: 'stFailed', color: '#ef4444' },
      'broken-manifest': { key: 'stBroken', color: '#eab308' },
      // 0.5.0 双轨状态（只读行）
      'superseded-by-static': { key: 'stSuperseded', color: '#6366f1' },
      'pending-import': { key: 'stPendingImport', color: '#eab308' },
    }

    // 0.5.0：只读行（不可 toggle）——官方静态层固化 / 待重启接管
    const READONLY_STATES = new Set(['superseded-by-static', 'pending-import', 'broken-manifest'])

    const KIND_LABELS = {
      'import-failed': 'kindImportFailed',
      'activate-failed': 'kindActivateFailed',
      'pending-timeout': 'kindPendingTimeout',
      'config-invalid': 'kindConfigInvalid',
      'manifest-invalid': 'kindManifestInvalid',
      'not-a-bundle': 'kindNotBundle',
      unknown: 'kindUnknown',
    }

    // ===== 0.5.6 双语字典（zh/en，走官方 locale 服务：register + bind(ns) → t）=====
    const DICT_ZH = {
      sectionLabel: '插件挂载管理',
      headerTitle: '插件挂载管理 v{version}',
      headerDesc: '当前 profile：{profile}。勾选要挂载的插件，点击「保存并刷新」应用（会自动刷新页面）。',
      dtButton: '导入/导出',
      dtImportTitle: '导入到 bm（官方静态层 {n} 个）：',
      dtSelectAll: '全选',
      dtImportBtn: '导入到 bm（{n}）',
      dtBatchTitle: '批量操作（bm 托管 {n} 个）：',
      dtBatchExport: '批量导出（{n}）',
      dtBatchUninstall: '批量卸载（{n}）',
      dtExportAll: '导出全部（安全网）',
      dtRollback: '回滚上次导入',
      presetTitle: '预设管理',
      presetCurrent: '当前：{name}',
      presetSwitchLabel: '切换预设（应用后自动刷新）',
      presetSaveLabel: '保存当前挂载为预设',
      presetPlaceholder: '输入新预设名',
      presetSave: '保存为预设',
      presetDelete: '删除预设',
      presetHint: '保存预设只记录组合、不应用挂载；应用当前勾选请点「保存并刷新」。',
      rowExport: '导出',
      rowUninstall: '卸载',
      rowPending: '待保存',
      rowStatic: '官方静态层',
      rowPendingImport: '待重启接管',
      stActive: '已挂载',
      stLoading: '挂载中',
      stPending: '待挂载',
      stUnmounted: '未挂载',
      stFailed: '挂载失败',
      stBroken: '清单解析失败',
      stSuperseded: '官方静态层（已固化）',
      stPendingImport: '待重启接管',
      kindImportFailed: '导入失败',
      kindActivateFailed: '激活失败',
      kindPendingTimeout: '挂载超时',
      kindConfigInvalid: '配置无效',
      kindManifestInvalid: '清单无效',
      kindNotBundle: '不是可选 bundle',
      kindUnknown: '未知',
      waitingFor: '等待服务：{svc}',
      failedTimes: '{kind} · 第 {n} 次失败',
      saveRefresh: '保存并刷新',
      saving: '保存中…',
      discard: '放弃更改',
      dirtyBanner: '有未保存的更改，点击「保存并刷新」应用并自动刷新页面。',
      loadFailed: '加载失败：',
      retry: '重试拉取',
      loading: '加载中…',
      empty: '没有可管理的可选插件（依赖里没有声明 dsh.bundle 的第三方包）。',
      storageWarn: '挂载表写入失败（{path}）：{err}。本次更改重启后可能失效。',
      storageWarnShort: '挂载表写入失败（{path}），本次更改重启后可能失效。',
      switchReadonly: '该插件当前不归 bm 运行时管理（官方静态层 / 待重启接管），只读',
      switchBroken: '该包的 package.json 解析失败，无法挂载',
      switchOn: '点击取消挂载',
      switchOff: '点击挂载',
      cancel: '取消',
      confirm: '确认',
      processing: '处理中…',
      overwrite: '覆盖',
      overrideTitle: '覆盖预设',
      overrideBody: '预设「{name}」已存在，覆盖将替换它的挂载组合。确定继续？',
      deleteMenuTitle: '删除预设（可多选）',
      deleteNext: '下一步（已选 {n} 个）',
      deleteNone: '没有可删除的预设（默认与当前激活预设不可删除）。',
      deleteConfirmTitle: '确认删除',
      deleteConfirmBody: '确定删除所选 {n} 个预设？该操作不可逆，将永久移除：{names}。',
      confirmDelete: '确认删除',
      actImportTitle: '导入到 bm',
      actExportTitle: '导出到官方',
      actExportAllTitle: '导出全部到官方',
      actUninstallTitle: '卸载插件',
      promptImport: '把该插件从官方静态层移交给 bm 运行时管理（重启后生效）。',
      promptExport: '把该插件固化回官方静态层，永久随 dsh 启动（重启后生效）。',
      promptExportAll: '把所有 bm 托管的插件批量写回官方静态层（安全网，重启后生效）。',
      promptUninstall: '先 bm 出库（清 registry 行），再引导你手动执行官方卸载命令。',
      imported: '已导入 {n} 个：{list}',
      needsRestartImport: '⚠️ 已从官方静态层摘条，请【重启 dsh】后 bm 尝试接管挂载。',
      rejectedImport: '未导入 {n} 个：{list}',
      importNone: '无可导入的包。',
      exported: '已固化 {n} 个到官方静态层：{list}',
      needsRestartExport: '⚠️ 请【重启 dsh】后随官方静态层永久启动。',
      rejectedExport: '未导出：{list}',
      uninstalled: 'bm 出库已完成：{list}',
      dormant: '以下包已退化为 dormant dependency（未被管理）：{list}',
      officialCmd: '请手动执行官方卸载命令完成物理移除：\n{cmd}',
      rejectedUninstall: '未卸载：{list}',
      rollbackDone: '已回滚导入',
      rollbackBody: '已还原上次导入批次（写回 bundles + 还原 registry 行）。请【重启 dsh】生效。',
      rollbackFailed: '回滚失败',
      actionFailed: '操作失败',
      saved: '已保存',
      busyHint: '操作中…',
      presetSavedActivated: '预设「{name}」已保存并设为当前激活。应用挂载请点「保存并刷新」。',
      presetSaved: '预设已更新（当前激活不变）。应用挂载请点「保存并刷新」。',
      presetsDeleted: '已删除 {n} 个预设。',
      savedEffective: '已保存并生效',
      unknown: '未知',
      staticPendingSuffix: '（待重启接管）',
    }
    const DICT_EN = {
      sectionLabel: 'Plugin Manager',
      headerTitle: 'Plugin Manager v{version}',
      headerDesc: 'Profile: {profile}. Toggle plugins to mount, then click "Save & refresh" to apply (the page reloads automatically).',
      dtButton: 'Import/Export',
      dtImportTitle: 'Import to BM (official static layer · {n}):',
      dtSelectAll: 'Select all',
      dtImportBtn: 'Import to BM ({n})',
      dtBatchTitle: 'Batch actions (BM-managed · {n}):',
      dtBatchExport: 'Batch export ({n})',
      dtBatchUninstall: 'Batch uninstall ({n})',
      dtExportAll: 'Export all (safety net)',
      dtRollback: 'Rollback last import',
      presetTitle: 'Presets',
      presetCurrent: 'Current: {name}',
      presetSwitchLabel: 'Switch preset (applies with refresh)',
      presetSaveLabel: 'Save current mounts as preset',
      presetPlaceholder: 'Enter a new preset name',
      presetSave: 'Save as preset',
      presetDelete: 'Delete preset',
      presetHint: 'Saving a preset only records the combination; click "Save & refresh" to apply it.',
      rowExport: 'Export',
      rowUninstall: 'Uninstall',
      rowPending: 'Unsaved',
      rowStatic: 'Official static layer',
      rowPendingImport: 'Awaiting restart takeover',
      stActive: 'Mounted',
      stLoading: 'Mounting',
      stPending: 'Pending',
      stUnmounted: 'Unmounted',
      stFailed: 'Failed',
      stBroken: 'Broken manifest',
      stSuperseded: 'Official static layer (fixed)',
      stPendingImport: 'Awaiting restart takeover',
      kindImportFailed: 'Import failed',
      kindActivateFailed: 'Activate failed',
      kindPendingTimeout: 'Mount timeout',
      kindConfigInvalid: 'Invalid config',
      kindManifestInvalid: 'Invalid manifest',
      kindNotBundle: 'Not an optional bundle',
      kindUnknown: 'Unknown',
      waitingFor: 'Waiting for: {svc}',
      failedTimes: '{kind} · attempt {n}',
      saveRefresh: 'Save & refresh',
      saving: 'Saving…',
      discard: 'Discard changes',
      dirtyBanner: 'You have unsaved changes. Click "Save & refresh" to apply (page reloads automatically).',
      loadFailed: 'Failed to load: ',
      retry: 'Retry',
      loading: 'Loading…',
      empty: 'No manageable optional plugins (no third-party package in dependencies declares dsh.bundle).',
      storageWarn: 'Registry write failed ({path}): {err}. Changes may not survive a restart.',
      storageWarnShort: 'Registry write failed ({path}); changes may not survive a restart.',
      switchReadonly: 'This plugin is not BM-managed (official static layer / awaiting restart), read-only',
      switchBroken: 'This package manifest failed to parse; cannot mount',
      switchOn: 'Click to unmount',
      switchOff: 'Click to mount',
      cancel: 'Cancel',
      confirm: 'Confirm',
      processing: 'Working…',
      overwrite: 'Overwrite',
      overrideTitle: 'Overwrite preset',
      overrideBody: 'Preset "{name}" already exists. Overwriting replaces its mount combination. Continue?',
      deleteMenuTitle: 'Delete presets (multi-select)',
      deleteNext: 'Next ({n} selected)',
      deleteNone: 'No presets to delete (default and the active preset cannot be deleted).',
      deleteConfirmTitle: 'Confirm deletion',
      deleteConfirmBody: 'Delete the {n} selected presets? This cannot be undone and will permanently remove: {names}.',
      confirmDelete: 'Delete',
      actImportTitle: 'Import to BM',
      actExportTitle: 'Export to official',
      actExportAllTitle: 'Export all to official',
      actUninstallTitle: 'Uninstall plugin',
      promptImport: 'Moves this plugin from the official static layer to BM runtime management (effective after restart).',
      promptExport: 'Fixes this plugin back into the official static layer, starting with dsh permanently (effective after restart).',
      promptExportAll: 'Writes every BM-managed plugin back to the official static layer in bulk (safety net, effective after restart).',
      promptUninstall: 'BM de-registers first (clears the registry row), then guides you to run the official uninstall command.',
      imported: 'Imported {n}: {list}',
      needsRestartImport: '⚠️ Removed from the official static layer — restart dsh and BM will take over mounting.',
      rejectedImport: 'Not imported ({n}): {list}',
      importNone: 'Nothing to import.',
      exported: 'Fixed {n} into the official static layer: {list}',
      needsRestartExport: '⚠️ Restart dsh to start permanently with the official static layer.',
      rejectedExport: 'Not exported: {list}',
      uninstalled: 'BM de-registered: {list}',
      dormant: 'The following became dormant dependencies (no longer managed): {list}',
      officialCmd: 'Run the official uninstall command to physically remove:\n{cmd}',
      rejectedUninstall: 'Not uninstalled: {list}',
      rollbackDone: 'Import rolled back',
      rollbackBody: 'Restored the last import batch (bundles written back + registry rows restored). Restart dsh to apply.',
      rollbackFailed: 'Rollback failed',
      actionFailed: 'Operation failed',
      saved: 'Saved',
      busyHint: 'Working…',
      presetSavedActivated: 'Preset "{name}" saved and set active. Click "Save & refresh" to apply mounts.',
      presetSaved: 'Preset updated (active unchanged). Click "Save & refresh" to apply mounts.',
      presetsDeleted: 'Deleted {n} presets.',
      savedEffective: 'Saved and applied',
      unknown: 'Unknown',
      staticPendingSuffix: ' (awaiting restart takeover)',
    }

    // ── Section component ────────────────────────────────────────────────────

    // 0.5.6：官方卡壳模型区块卡（预设/双轨用）——pcard 外观 + 头部（title/desc/
    // 官方 chevron）+ 可折叠体（体内容纵向 12px stack）。默认收起 = layer-3 亮面。
    function OfficialSectionCard(props) {
      const { ui, title, desc, open, onToggle, children } = props
      const Chevron = (ui.official && ui.official.IconChevronDownOutline14) || null
      return ui.h('div', { className: 'sui-pcard' + (open ? ' sui-pcard-open' : '') },
        ui.h('button', {
          type: 'button',
          className: 'sui-pcard-head',
          'aria-expanded': open,
          onClick: onToggle,
        },
          ui.h('span', { className: 'sui-pcard-headtext' },
            ui.h('span', { className: 'sui-pcard-name' }, title),
            desc ? ui.h('span', { className: 'sui-pcard-desc' }, desc) : null,
          ),
          Chevron
            ? ui.h(Chevron, { className: 'sui-pcard-chevron' + (open ? ' sui-pcard-chevron-open' : '') })
            : ui.h('span', { className: 'sui-pcard-chevron' + (open ? ' sui-pcard-chevron-open' : '') }, open ? '▲' : '▼'),
        ),
        open
          ? ui.h('div', { className: 'sui-pcard-body' },
            ui.h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, children),
          )
          : null,
      )
    }

    // 0.5.6：行卡恢复 v0.4.4 样式（见渲染处），不再使用独立的 PluginRowCard 组件。

    function PluginManagerSection(props) {
      const { ui, store, api, t } = props
      const tk = (key, params) => {
        try {
          if (typeof t === 'function') {
            const v = t(key, params)
            if (v != null && v !== key) return v
          }
        } catch {}
        let text = DICT_ZH[key] ?? key
        if (params) for (const [k, val] of Object.entries(params)) text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(val))
        return text
      }
      const s = ui.useSettings(store)
      const [draft, setDraft] = React.useState(null) // { pkg: bool } | null
      const [presetName, setPresetName] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saveError, setSaveError] = React.useState('')
      const [confirmOverride, setConfirmOverride] = React.useState(null) // { name, draft } | null（同名覆盖确认）
      // 0.4.3 删除预设流程：menuOpen=选择器弹窗、sel=多选中的预设名、confirm=待确认删除的名单
      const [deleteMenuOpen, setDeleteMenuOpen] = React.useState(false)
      const [deleteSel, setDeleteSel] = React.useState([])
      const [deleteConfirm, setDeleteConfirm] = React.useState(null)
      // 0.5.0 双轨管理：coexistAction=待确认操作 {kind:'import'|'export'|'exportAll'|'uninstall', pkgs, message}；
      // coexistResult=结果/引导弹窗 {title, body}（含 needsRestart / official command 指引）
      const [coexistAction, setCoexistAction] = React.useState(null)
      const [coexistResult, setCoexistResult] = React.useState(null)
      const [coexistBusy, setCoexistBusy] = React.useState(false)
      // 0.5.6：双轨操作收进头部下拉菜单
      const [dtOpen, setDtOpen] = React.useState(false)
      // 0.5.1：双轨多选——selStatic=静态层待导入、selManaged=托管待导出/卸载
      const [selStatic, setSelStatic] = React.useState([])
      const [selManaged, setSelManaged] = React.useState([])
      // 0.5.3：折叠卡（A）——预设/双轨默认收起，展开状态存 localStorage
      const COLLAPSE_KEY = 'dsh-bundle-manager.ui.collapsed.v1'
      const [collapsed, setCollapsed] = React.useState(() => {
        try {
          const raw = window.localStorage.getItem(COLLAPSE_KEY)
          if (raw) {
            const j = JSON.parse(raw)
            return { preset: j.preset !== false, coexist: j.coexist !== false }
          }
        } catch {}
        return { preset: true, coexist: true }
      })
      const toggleCollapse = (which) => {
        setCollapsed((prev) => {
          const next = { ...prev, [which]: !prev[which] }
          try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)) } catch {}
          return next
        })
      }

      useEffect(() => { void store.refresh() }, [store])

      const doc = s.doc ?? {}
      const profile = doc.profile ?? '未知'
      const version = doc.version ?? ''
      const activePreset = doc.activePreset ?? 'default'
      const presets = Array.isArray(doc.presets) ? doc.presets : ['default']
      const plugins = doc.plugins ?? []
      const bundles = Array.isArray(doc.bundles) ? doc.bundles : []
      const storage = doc.storage
      const storageWritable = !storage || storage.writable !== false
      const busy = s.busy
      const error = s.error

      // 0.5.0 双轨：框架白名单（服务端已排除出 candidates；这里再剔出 bundles 展示）
      const FRAMEWORK = new Set(['dsh-base', '@deepseek-ai/dsh-base', 'dsh-web-app', '@deepseek-ai/dsh-web-app', 'dsh-settings-ui', 'dsh-bundle-manager'])
      const staticLayerPkgs = bundles.filter(pkg => !FRAMEWORK.has(pkg))
      const managedPkgs = plugins.filter(p =>
        (p.regState === 'managed-by-bm' || p.regState === 'pending-import') && !FRAMEWORK.has(p.pkg))

      // 0.5.1：双轨多选辅助（全选/单行切换）
      const toggleSel = (list, setList, pkg) =>
        setList(prev => prev.includes(pkg) ? prev.filter(x => x !== pkg) : [...prev, pkg])
      const toggleAllStatic = () =>
        setSelStatic(prev => prev.length === staticLayerPkgs.length ? [] : [...staticLayerPkgs])
      const toggleAllManaged = () =>
        setSelManaged(prev => prev.length === managedPkgs.length ? [] : [...managedPkgs])

      // Seed the draft from the committed state once the list arrives.
      useEffect(() => {
        if (draft === null && plugins.length > 0) {
          const next = {}
          for (const p of plugins) next[p.pkg] = p.mounted === true
          setDraft(next)
        }
      }, [plugins, draft])

      const draftOn = (pkg) => {
        if (draft !== null && Object.hasOwn(draft, pkg)) return draft[pkg] === true
        return plugins.find(p => p.pkg === pkg)?.mounted === true
      }

      const isDirty = (pkg) => {
        if (draft === null) return false
        return (draft[pkg] === true) !== (plugins.find(p => p.pkg === pkg)?.mounted === true)
      }

      const anyDirty = plugins.some(p => isDirty(p.pkg))

      const toggle = (pkg) => {
        if (draft === null) return
        setDraft({ ...draft, [pkg]: !(draft[pkg] === true) })
      }

      const discard = () => {
        const next = {}
        for (const p of plugins) next[p.pkg] = p.mounted === true
        setDraft(next)
      }

      // Apply + hard reload (the unified ON/OFF commit path).
      const applyAndReload = async (fn) => {
        setSaving(true)
        setSaveError('')
        try {
          await fn()
          window.location.reload()
        } catch (err) {
          const code = err && err.code
          if (code === 'storage-error') {
            // Host already applied the mount change in-memory; only the
            // registry write failed. Reload so the UI reflects the real state,
            // then the storage warning banner (list.storage.writable=false)
            // surfaces after reload — no stale "error" page left behind (P1-4).
            window.location.reload()
            return
          }
          setSaveError(err && err.message ? err.message : String(err))
          setSaving(false)
        }
      }

      const save = () => {
        if (draft === null) return
        void applyAndReload(() => api.apply({ entries: draft }))
      }

      const switchPreset = (name) => {
        void applyAndReload(() => api.switchPreset({ name }))
      }

      // 0.4.2：「保存为预设」把当前草稿勾选（含未提交）一并存进快照——预设 = 想要的
      // 组合，无需先「保存并刷新」；host 只合并快照、不实际挂载。
      const doSavePreset = (name, draftToSave) => {
        setConfirmOverride(null)
        void store.run(async () => {
          const result = await api.savePreset({ name, draft: draftToSave ?? undefined })
          setPresetName('')
          // 0.4.3/0.4.4：保存成功提示——新预设已自动设为当前激活，应用挂载仍需保存并刷新
          if (result && result.activated) {
            ui.toast(tk('presetSavedActivated', { name: result.activated }), { kind: 'saved', ttlMs: 6000 })
          } else {
            ui.toast(tk('presetSaved'), { kind: 'saved', ttlMs: 6000 })
          }
        })
      }
      const savePreset = () => {
        const name = presetName.trim()
        if (name === '') return
        // 0.4.2：同名覆盖需确认（预设名已存在）
        if (presets.includes(name)) setConfirmOverride({ name, draft })
        else doSavePreset(name, draft ?? undefined)
      }

      // 0.4.3 删除预设流程：选择器（多选）→ 不可逆确认 → 删除
      const deletablePresets = presets.filter((p) => p !== 'default' && p !== activePreset)
      const openDeleteMenu = () => { setDeleteSel([]); setDeleteMenuOpen(true) }
      const toggleDeleteSel = (name) => {
        setDeleteSel((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]))
      }
      const startDelete = () => { setDeleteMenuOpen(false); setDeleteConfirm(deleteSel) }
      const doDelete = () => {
        const names = deleteConfirm
        setDeleteConfirm(null)
        setDeleteSel([])
        void store.run(async () => {
          await api.deletePresets({ names })
          ui.toast(tk('presetsDeleted', { n: names.length }), { kind: 'saved' })
        })
      }

      // ── 0.5.0 双轨管理：导入 / 导出 / 导出全部 / 卸载 / 回滚 ─────────────────
      const [importSnapshotId, setImportSnapshotId] = React.useState(null)

      /** 统一执行双轨操作 + 构建结果/引导弹窗 + 刷新列表。 */
      const finishCoexistResult = (title, lines) => {
        setCoexistResult({ title, body: lines.join('\n') })
      }
      const promptFor = () => {
        const desc = {
          import: 'promptImport',
          export: 'promptExport',
          exportAll: 'promptExportAll',
          uninstall: 'promptUninstall',
        }
        return tk(desc[coexistAction.kind])
      }

      const runCoexist = async () => {
        const action = coexistAction
        setCoexistAction(null)
        setCoexistBusy(true)
        try {
          let result
          if (action.kind === 'import') result = await api.importToBm({ pkg: action.pkgs })
          else if (action.kind === 'export') result = await api.exportToBundles({ pkg: action.pkgs })
          else if (action.kind === 'exportAll') result = await api.exportAllToBundles()
          else if (action.kind === 'uninstall') result = await api.uninstall({ pkg: action.pkgs })

          if (action.kind === 'import') {
            if (result && result.snapshotId) setImportSnapshotId(result.snapshotId)
            const lines = []
            if (result.imported && result.imported.length > 0) {
              lines.push(tk('imported', { n: result.imported.length, list: result.imported.join('、') }))
              if (result.needsRestart) lines.push(tk('needsRestartImport'))
            }
            if (result.hints && result.hints.length > 0) {
              for (const h of result.hints) lines.push(`💡 ${h.message}`)
            }
            if (result.rejected && result.rejected.length > 0) {
              lines.push(tk('rejectedImport', { n: result.rejected.length, list: result.rejected.map(r => `${r.pkg}（${r.message}）`).join('；') }))
            }
            finishCoexistResult(tk('actImportTitle'), lines.length ? lines : [tk('importNone')])
          } else if (action.kind === 'export' || action.kind === 'exportAll') {
            const list = action.kind === 'exportAll' ? (result.exported ?? []) : (result.exported ?? [])
            const lines = [tk('exported', { n: list.length, list: list.join('、') || '（无）' })]
            if (result.needsRestart) lines.push(tk('needsRestartExport'))
            if (result.rejected && result.rejected.length > 0) {
              lines.push(tk('rejectedExport', { list: result.rejected.map(r => `${r.pkg}（${r.message}）`).join('；') }))
            }
            finishCoexistResult(tk('actExportTitle'), lines)
          } else if (action.kind === 'uninstall') {
            const lines = [tk('uninstalled', { list: (result.uninstalled || []).join('、') || '（无）' })]
            if ((result.dormant || []).length > 0) {
              lines.push(tk('dormant', { list: result.dormant.join('、') }))
            }
            if (result.command) lines.push(tk('officialCmd', { cmd: result.command }))
            if (result.guide) lines.push(`\n${result.guide}`)
            if ((result.rejected || []).length > 0) {
              lines.push(tk('rejectedUninstall', { list: result.rejected.map(r => `${r.pkg}（${r.message}）`).join('；') }))
            }
            finishCoexistResult(tk('actUninstallTitle'), lines)
          }
          void store.refresh()
        } catch (err) {
          finishCoexistResult(tk('actionFailed'), [String(err && err.message ? err.message : err)])
        } finally {
          setCoexistBusy(false)
          setSelStatic([])
          setSelManaged([])
        }
      }

      const startRollback = () => {
        setCoexistBusy(true)
        void api.rollbackImport({ id: importSnapshotId }).then(() => {
          setImportSnapshotId(null)
          finishCoexistResult(tk('rollbackDone'), [tk('rollbackBody')])
          void store.refresh()
          setCoexistBusy(false)
        }).catch((err) => {
          finishCoexistResult(tk('rollbackFailed'), [String(err && err.message ? err.message : err)])
          setCoexistBusy(false)
        })
      }

      return ui.h(React.Fragment, null,
        ui.h(ui.ToastHost),   // 0.4.3：toast 提示（保存预设/删除预设）承载
        ui.h('div', { className: 'sui-header-row' },
          ui.h(ui.SectionHeader, {
            title: tk('headerTitle', { version }),
            desc: tk('headerDesc', { profile }),
          }),
          // 0.5.6：导入/导出下拉菜单（导入列表 / 批量导出·卸载 / 导出全部安全网 / 回滚）
          ui.h('div', { style: { position: 'relative', marginLeft: 'auto' } },
            ui.h(ui.Button, {
              kind: 'primary',
              disabled: busy || saving || coexistBusy,
              onClick: () => setDtOpen(!dtOpen),
            }, tk('dtButton')),
            dtOpen
              ? ui.h(React.Fragment, null,
                ui.h('div', { style: { position: 'fixed', inset: 0, zIndex: 40 }, onClick: () => setDtOpen(false) }),
                ui.h('div', {
                  className: 'sui-pcard sui-pcard-open',
                  style: { position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, width: 340 },
                },
                  ui.h('div', { className: 'sui-pcard-body' },
                    ui.h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                      // 导入区块（官方静态层 → bm）
                      staticLayerPkgs.length > 0
                        ? ui.h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                          ui.h('div', { className: 'sui-pcard-desc' }, tk('dtImportTitle', { n: staticLayerPkgs.length })),
                          ui.h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px' } },
                            ui.h('input', {
                              type: 'checkbox',
                              checked: selStatic.length === staticLayerPkgs.length && selStatic.length > 0,
                              onChange: toggleAllStatic,
                            }),
                            tk('dtSelectAll'),
                          ),
                          staticLayerPkgs.map((pkg) => ui.h('label', { key: pkg, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' } },
                            ui.h('input', {
                              type: 'checkbox',
                              checked: selStatic.includes(pkg),
                              onChange: () => toggleSel(selStatic, setSelStatic, pkg),
                              disabled: busy || saving || coexistBusy,
                            }),
                            ui.h('span', {}, pkg),
                          )),
                          ui.h('button', {
                            type: 'button',
                            className: 'sui-btn',
                            disabled: selStatic.length === 0 || busy || saving || coexistBusy,
                            onClick: () => { setDtOpen(false); setCoexistAction({ kind: 'import', pkgs: selStatic }) },
                          }, tk('dtImportBtn', { n: selStatic.length })),
                        )
                        : null,
                      // 托管批量区块（bm → 官方 / 卸载）
                      managedPkgs.length > 0
                        ? ui.h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                          ui.h('div', { className: 'sui-pcard-desc' }, tk('dtBatchTitle', { n: managedPkgs.length })),
                          ui.h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px' } },
                            ui.h('input', {
                              type: 'checkbox',
                              checked: selManaged.length === managedPkgs.length && selManaged.length > 0,
                              onChange: toggleAllManaged,
                            }),
                            tk('dtSelectAll'),
                          ),
                          managedPkgs.map((row) => ui.h('label', { key: row.pkg, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' } },
                            ui.h('input', {
                              type: 'checkbox',
                              checked: selManaged.includes(row.pkg),
                              onChange: () => toggleSel(selManaged, setSelManaged, row.pkg),
                              disabled: busy || saving || coexistBusy,
                            }),
                            ui.h('span', {}, row.pkg),
                          )),
                          ui.h('div', { className: 'sui-actions' },
                            ui.h('button', {
                              type: 'button',
                              className: 'sui-btn',
                              disabled: selManaged.length === 0 || busy || saving || coexistBusy,
                              onClick: () => { setDtOpen(false); setCoexistAction({ kind: 'export', pkgs: selManaged }) },
                            }, tk('dtBatchExport', { n: selManaged.length })),
                            ui.h('button', {
                              type: 'button',
                              className: 'sui-btn sui-btn-danger',
                              disabled: selManaged.length === 0 || busy || saving || coexistBusy,
                              onClick: () => { setDtOpen(false); setCoexistAction({ kind: 'uninstall', pkgs: selManaged }) },
                            }, tk('dtBatchUninstall', { n: selManaged.length })),
                          ),
                        )
                        : null,
                      // 安全网 + 回滚
                      ui.h('div', { className: 'sui-actions' },
                        ui.h('button', {
                          type: 'button',
                          className: 'sui-btn',
                          disabled: managedPkgs.length === 0 || busy || saving || coexistBusy,
                          onClick: () => { setDtOpen(false); setCoexistAction({ kind: 'exportAll', pkgs: [] }) },
                        }, tk('dtExportAll')),
                        importSnapshotId !== null
                          ? ui.h('button', {
                            type: 'button',
                            className: 'sui-btn sui-btn-danger',
                            disabled: coexistBusy,
                            onClick: () => { setDtOpen(false); startRollback() },
                          }, tk('dtRollback'))
                          : null,
                      ),
                    ),
                  ),
                ),
              )
              : null,
          ),
        ),

        // 0.4.1：移除顶部「刷新」按钮（语义=放弃草稿+重拉，与「放弃更改」重叠且无反馈；
        // 挂载表唯一写者是本 UI+保存后硬刷新，重拉场景不存在）。
        // 首拉失败走这里：错误横幅 + 明确「重试拉取」（有反馈、语义精确）。
        error !== '' ? ui.h(ui.Banner, { kind: 'error' }, error) : null,
        error !== ''
          ? ui.h('div', { className: 'sui-actions' },
            ui.h('span', {}, tk('loadFailed')),
            ui.h(ui.Button, { disabled: busy || saving, onClick: () => void store.refresh() }, tk('retry')),
          )
          : null,
        saveError !== '' ? ui.h(ui.Banner, { kind: 'error' }, saveError) : null,

        // Storage health (v0.3): surface registry write failures.
        !storageWritable
          ? ui.h(ui.Banner, { kind: 'warn' },
            storage && storage.lastError
              ? tk('storageWarn', { path: storage.path, err: storage.lastError })
              : tk('storageWarnShort', { path: storage ? storage.path : tk('unknown') }))
          : null,

        // Preset controls（0.5.6：官方卡壳模型 pcard；A 折叠默认收起 + B 切换器仅预设数>1 时显示）
        ui.h(OfficialSectionCard, {
          ui,
          title: tk('presetTitle'),
          desc: tk('presetCurrent', { name: activePreset }),
          open: !collapsed.preset,
          onToggle: () => toggleCollapse('preset'),
        },
          presets.length > 1
            ? ui.h(ui.Field, { label: tk('presetSwitchLabel') },
              ui.h(ui.Select, {
                value: activePreset,
                disabled: busy || saving,
                onChange: (value) => switchPreset(value),
              },
                presets.map((preset) => ui.h('option', { key: preset, value: preset }, preset)),
              ),
            )
            : null,
          ui.h(ui.Field, { label: tk('presetSaveLabel') },
            ui.h(ui.TextInput, {
              value: presetName,
              placeholder: tk('presetPlaceholder'),
              onChange: (value) => setPresetName(value),
            }),
          ),
          // 0.4.4：两按钮横排平分整行（flex:1）；删除用危险红（sui-btn-danger）
          ui.h('div', { style: { display: 'flex', gap: '8px' } },
            ui.h('button', {
              type: 'button',
              className: 'sui-btn',
              style: { flex: 1 },
              disabled: busy || saving || presetName.trim() === '',
              onClick: savePreset,
            }, tk('presetSave')),
            ui.h('button', {
              type: 'button',
              className: 'sui-btn sui-btn-danger',
              style: { flex: 1 },
              disabled: busy || saving || deletablePresets.length === 0,
              onClick: openDeleteMenu,
            }, tk('presetDelete')),
          ),
          ui.h('div', { className: 'sui-hint' }, tk('presetHint')),
        ),

        // 0.5.6：官方共存（双轨）整卡移除——双轨操作收进头部「导入/导出」下拉菜单
        //（导入列表 / 批量导出·卸载 / 导出全部安全网 / 回滚上次导入）与托管行行内按钮。


        // loading / empty states
        !s.loaded && error === ''
          ? ui.h('div', { className: 'sui-empty' }, tk('loading'))
          : null,
        s.loaded && plugins.length === 0
          ? ui.h('div', { className: 'sui-empty' }, tk('empty'))
          : null,

        // One editable row per candidate: switch = desired (draft) state.
        // 0.5.0：superseded-by-static / pending-import 为只读行（不可 toggle）。
        // 0.5.6：恢复 v0.4.4 行样式（sui-card 行 + 右侧开关）；托管行加行内导出/卸载。
        plugins.map((row) => {
          const meta = STATUS[row.state] ?? STATUS.unmounted
          const on = draftOn(row.pkg)
          const dirty = isDirty(row.pkg)
          const readonly = READONLY_STATES.has(row.state)
          const waiting = (row.state === 'pending' || row.state === 'loading')
            && Array.isArray(row.waitingFor) && row.waitingFor.length > 0
            ? tk('waitingFor', { svc: row.waitingFor.join('、') })
            : ''
          const failedExtra = row.state === 'failed'
            ? tk('failedTimes', { kind: tk(KIND_LABELS[row.kind] ?? KIND_LABELS.unknown), n: row.attempts ?? 1 })
            : ''
          const regBadge = row.regState === 'superseded-by-static'
            ? ui.h(ui.Badge, null, tk('rowStatic'))
            : row.regState === 'pending-import'
              ? ui.h(ui.Badge, null, tk('rowPendingImport'))
              : null
          const managedRow = row.regState === 'managed-by-bm' || row.regState === 'pending-import'
          return ui.h(ui.Card, { key: row.pkg, row: true },
            ui.h('div', { className: 'sui-card-main' },
              ui.h('div', { className: 'sui-card-title' },
                row.pkg,
                row.version && row.version !== tk('unknown')
                  ? ui.h(ui.Badge, null, `v${row.version}`)
                  : null,
                regBadge,
                dirty ? ui.h(ui.Badge, null, tk('rowPending')) : null,
              ),
              row.error
                ? ui.h('div', { className: 'sui-card-error' }, row.error)
                : null,
              failedExtra !== ''
                ? ui.h('div', { className: 'sui-card-meta' }, failedExtra)
                : null,
              waiting !== ''
                ? ui.h('div', { className: 'sui-card-meta' }, waiting)
                : null,
              ui.h(ui.StatusDot, { color: meta.color, text: tk(meta.key) }),
            ),
            // 0.5.6：托管行行内小按钮（导出/卸载）
            managedRow && !readonly
              ? ui.h('div', { style: { display: 'flex', gap: '6px', flex: 'none' } },
                ui.h('button', {
                  type: 'button',
                  className: 'sui-btn',
                  disabled: busy || saving || coexistBusy,
                  onClick: () => setCoexistAction({ kind: 'export', pkgs: [row.pkg] }),
                }, tk('rowExport')),
                ui.h('button', {
                  type: 'button',
                  className: 'sui-btn sui-btn-danger',
                  disabled: busy || saving || coexistBusy,
                  onClick: () => setCoexistAction({ kind: 'uninstall', pkgs: [row.pkg] }),
                }, tk('rowUninstall')),
              )
              : null,
            ui.h(ui.Switch, {
              checked: readonly ? false : on,
              disabled: busy || saving || readonly,
              title: readonly
                ? tk('switchReadonly')
                : (row.state === 'broken-manifest'
                  ? tk('switchBroken')
                  : (on ? tk('switchOn') : tk('switchOff'))),
              onChange: () => toggle(row.pkg),
            }),
          )
        }),

        // Commit bar.
        ui.h('div', { className: 'sui-actions' },
          ui.h(ui.Button, {
            kind: 'primary',
            disabled: busy || saving || !anyDirty,
            onClick: save,
          }, saving ? tk('saving') : tk('saveRefresh')),
          ui.h(ui.Button, {
            disabled: busy || saving || !anyDirty,
            onClick: discard,
          }, tk('discard')),
        ),
        anyDirty
          ? ui.h(ui.Banner, { kind: 'warn' }, tk('dirtyBanner'))
          : null,

        // 0.4.2：同名预设覆盖确认（不覆盖就不会静默丢旧组合）
        confirmOverride !== null
          ? ui.h(ui.Dialog, {
            open: true,
            title: tk('overrideTitle'),
            onClose: () => setConfirmOverride(null),
            footer: [
              ui.h(ui.Button, { onClick: () => setConfirmOverride(null) }, tk('cancel')),
              ui.h(ui.Button, { kind: 'primary', onClick: () => doSavePreset(confirmOverride.name, confirmOverride.draft) }, tk('overwrite')),
            ],
          },
          ui.h('p', {}, tk('overrideBody', { name: confirmOverride.name })),
          )
          : null,

        // 0.4.3：删除预设第一步——多选选择器（default/当前激活不可选；host 也拒）
        deleteMenuOpen
          ? ui.h(ui.Dialog, {
            open: true,
            title: tk('deleteMenuTitle'),
            onClose: () => setDeleteMenuOpen(false),
            footer: [
              ui.h(ui.Button, { onClick: () => setDeleteMenuOpen(false) }, tk('cancel')),
              ui.h(ui.Button, { kind: 'danger', disabled: deleteSel.length === 0, onClick: startDelete }, tk('deleteNext', { n: deleteSel.length })),
            ],
          },
          deletablePresets.length === 0
            ? ui.h('p', {}, tk('deleteNone'))
            : ui.h(ui.Rows, {
              fields: deletablePresets.map((p) => ({ key: p, type: 'checkbox', label: p })),
              values: Object.fromEntries(deleteSel.map((p) => [p, true])),
              onChange: (key) => toggleDeleteSel(key),
            }),
          )
          : null,

        // 0.4.3：删除预设第二步——不可逆确认
        deleteConfirm !== null
          ? ui.h(ui.Dialog, {
            open: true,
            title: tk('deleteConfirmTitle'),
            onClose: () => setDeleteConfirm(null),
            footer: [
              ui.h(ui.Button, { onClick: () => setDeleteConfirm(null) }, tk('cancel')),
              ui.h(ui.Button, { kind: 'danger', onClick: doDelete }, tk('confirmDelete')),
            ],
          },
          ui.h('p', {}, tk('deleteConfirmBody', { n: deleteConfirm.length, names: deleteConfirm.join('、') })),
          )
          : null,

        // 0.5.0 双轨操作确认
        coexistAction !== null
          ? ui.h(ui.Dialog, {
            open: true,
            title: {
              import: 'actImportTitle',
              export: 'actExportTitle',
              exportAll: 'actExportAllTitle',
              uninstall: 'actUninstallTitle',
            }[coexistAction.kind] ?? 'actImportTitle',
            onClose: () => { if (!coexistBusy) setCoexistAction(null) },
            footer: [
              ui.h(ui.Button, { disabled: coexistBusy, onClick: () => setCoexistAction(null) }, tk('cancel')),
              ui.h(ui.Button, {
                kind: coexistAction.kind === 'uninstall' ? 'danger' : 'primary',
                disabled: coexistBusy,
                onClick: runCoexist,
              }, coexistBusy ? tk('processing') : tk('confirm')),
            ],
          },
          ui.h('p', {},
            `${coexistAction.pkgs.length > 0 ? `${coexistAction.pkgs.join('、')}。` : ''}${promptFor()}`,
          ),
          )
          : null,

        // 0.5.0 双轨操作结果 / 引导
        coexistResult !== null
          ? ui.h(ui.Dialog, {
            open: true,
            title: coexistResult.title,
            onClose: () => setCoexistResult(null),
            footer: [
              ui.h(ui.Button, { kind: 'primary', onClick: () => setCoexistResult(null) }, tk('confirm')),
            ],
          },
          ui.h('p', { style: { whiteSpace: 'pre-wrap' } }, coexistResult.body),
          )
          : null,
      )
    }

    const plugin = {
      name: 'dsh-bundle-manager',
      inject: ['slots', 'settingsUi'],
      apply(ctx) {
        // 0.5.6 双语：注册字典 + 绑定 t（locale 服务缺席时回退中文）
        let t = (key, params) => {
          let text = DICT_ZH[key] ?? key
          if (params) for (const [k, v] of Object.entries(params)) text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v))
          return text
        }
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.locale.register('dsh-bundle-manager', { zh: DICT_ZH, en: DICT_EN })
            const bound = ctx.locale.bind('dsh-bundle-manager')
            if (bound) t = bound
          }
        } catch (err) { /* locale 缺席：保持中文回退 */ }

        // The store must be created once here (never inside the render
        // function) and passed to the component through the inject face.
        const store = ctx.settingsUi.createSettingsStore({ get: () => call('list') })
        ctx.settingsUi.section({
          id: 'dsh-bundle-manager',
          order: 300,
          label: () => t('sectionLabel'),
          locale: 'dsh-bundle-manager',
          inject: () => ({
            api: {
              list: () => call('list'),
              apply: (payload) => call('apply', payload),
              switchPreset: (payload) => call('preset/switch', payload),
              savePreset: (payload) => call('preset/save', payload),
              deletePresets: (payload) => call('preset/delete', payload),
              // 0.5.0 对外双轨 / 卸载半边
              importToBm: (payload) => call('import-to-bm', payload),
              exportToBundles: (payload) => call('export-to-bundles', payload),
              exportAllToBundles: () => call('export-all-to-bundles', {}),
              rollbackImport: (payload) => call('import/rollback', payload),
              uninstall: (payload) => call('uninstall', payload),
            },
            ui: ctx.settingsUi,
            store,
            t,
          }),
          render: PluginManagerSection,
        })
      },
    }

    return plugin
  },
})
