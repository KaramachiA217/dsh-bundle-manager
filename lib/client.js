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
      active: { text: '已挂载', color: '#22c55e' },
      loading: { text: '挂载中', color: '#eab308' },
      pending: { text: '待挂载', color: '#9ca3af' },
      unmounted: { text: '未挂载', color: '#9ca3af' },
      failed: { text: '挂载失败', color: '#ef4444' },
      'broken-manifest': { text: '清单解析失败', color: '#eab308' },
    }

    const KIND_LABELS = {
      'import-failed': '导入失败',
      'activate-failed': '激活失败',
      'pending-timeout': '挂载超时',
      'config-invalid': '配置无效',
      'manifest-invalid': '清单无效',
      'not-a-bundle': '不是可选 bundle',
      unknown: '未知',
    }

    // ── Section component ────────────────────────────────────────────────────
    function PluginManagerSection(props) {
      const { ui, store, api } = props
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

      useEffect(() => { void store.refresh() }, [store])

      const doc = s.doc ?? {}
      const profile = doc.profile ?? '未知'
      const version = doc.version ?? ''
      const activePreset = doc.activePreset ?? 'default'
      const presets = Array.isArray(doc.presets) ? doc.presets : ['default']
      const plugins = doc.plugins ?? []
      const storage = doc.storage
      const storageWritable = !storage || storage.writable !== false
      const busy = s.busy
      const error = s.error

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
            ui.toast(`预设「${result.activated}」已保存并设为当前激活。应用挂载请点「保存并刷新」。`, { kind: 'saved', ttlMs: 6000 })
          } else {
            ui.toast('预设已更新（当前激活不变）。应用挂载请点「保存并刷新」。', { kind: 'saved', ttlMs: 6000 })
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
          ui.toast(`已删除 ${names.length} 个预设。`, { kind: 'saved' })
        })
      }

      return ui.h(React.Fragment, null,
        ui.h(ui.ToastHost),   // 0.4.3：toast 提示（保存预设/删除预设）承载
        ui.h('div', { className: 'sui-header-row' },
          ui.h(ui.SectionHeader, {
            title: version ? `插件挂载管理 v${version}` : '插件挂载管理',
            desc: `当前 profile：${profile}。勾选要挂载的插件，点击「保存并刷新」应用（会自动刷新页面）。`,
          }),
        ),

        // 0.4.1：移除顶部「刷新」按钮（语义=放弃草稿+重拉，与「放弃更改」重叠且无反馈；
        // 挂载表唯一写者是本 UI+保存后硬刷新，重拉场景不存在）。
        // 首拉失败走这里：错误横幅 + 明确「重试拉取」（有反馈、语义精确）。
        error !== '' ? ui.h(ui.Banner, { kind: 'error' }, error) : null,
        error !== ''
          ? ui.h('div', { className: 'sui-actions' },
            ui.h('span', {}, '加载失败：'),
            ui.h(ui.Button, { disabled: busy || saving, onClick: () => void store.refresh() }, '重试拉取'),
          )
          : null,
        saveError !== '' ? ui.h(ui.Banner, { kind: 'error' }, saveError) : null,

        // Storage health (v0.3): surface registry write failures.
        !storageWritable
          ? ui.h(ui.Banner, { kind: 'warn' },
            storage && storage.lastError
              ? `挂载表写入失败（${storage.path}）：${storage.lastError}。本次更改重启后可能失效。`
              : `挂载表写入失败（${storage ? storage.path : '未知路径'}），本次更改重启后可能失效。`)
          : null,

        // Preset controls (vertical card).
        ui.h(ui.Card, null,
          ui.h('div', { className: 'sui-card-title' }, `当前激活预设：${activePreset}`),
          ui.h(ui.Field, { label: '切换预设（应用后自动刷新）' },
            ui.h(ui.Select, {
              value: activePreset,
              disabled: busy || saving,
              onChange: (value) => switchPreset(value),
            },
              presets.map((preset) => ui.h('option', { key: preset, value: preset }, preset)),
            ),
          ),
          ui.h(ui.Field, { label: '保存当前挂载为预设' },
            ui.h(ui.TextInput, {
              value: presetName,
              placeholder: '输入新预设名',
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
            }, '保存为预设'),
            ui.h('button', {
              type: 'button',
              className: 'sui-btn sui-btn-danger',
              style: { flex: 1 },
              disabled: busy || saving || deletablePresets.length === 0,
              onClick: openDeleteMenu,
            }, '删除预设'),
          ),
          ui.h('div', { className: 'sui-hint' }, '保存预设只记录组合、不应用挂载；应用当前勾选请点「保存并刷新」。'),
        ),

        // loading / empty states
        !s.loaded && error === ''
          ? ui.h('div', { className: 'sui-empty' }, '加载中…')
          : null,
        s.loaded && plugins.length === 0
          ? ui.h('div', { className: 'sui-empty' }, '没有可管理的可选插件（依赖里没有声明 dsh.bundle 的第三方包）。')
          : null,

        // One editable row per candidate: switch = desired (draft) state.
        plugins.map((row) => {
          const meta = STATUS[row.state] ?? STATUS.unmounted
          const on = draftOn(row.pkg)
          const dirty = isDirty(row.pkg)
          const brokenManifest = row.state === 'broken-manifest'
          const waiting = (row.state === 'pending' || row.state === 'loading')
            && Array.isArray(row.waitingFor) && row.waitingFor.length > 0
            ? `等待服务：${row.waitingFor.join('、')}`
            : ''
          const failedExtra = row.state === 'failed'
            ? `${KIND_LABELS[row.kind] ?? KIND_LABELS.unknown} · 第 ${row.attempts ?? 1} 次失败`
            : ''
          return ui.h(ui.Card, { key: row.pkg, row: true },
            ui.h('div', { className: 'sui-card-main' },
              ui.h('div', { className: 'sui-card-title' },
                row.pkg,
                row.version && row.version !== '未知'
                  ? ui.h(ui.Badge, null, `v${row.version}`)
                  : null,
                dirty ? ui.h(ui.Badge, null, '待保存') : null,
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
              ui.h(ui.StatusDot, { color: meta.color, text: meta.text }),
            ),
            ui.h(ui.Switch, {
              checked: brokenManifest ? false : on,
              disabled: busy || saving || brokenManifest,
              title: brokenManifest
                ? '该包的 package.json 解析失败，无法挂载'
                : (on ? '点击取消挂载' : '点击挂载'),
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
          }, saving ? '保存中…' : '保存并刷新'),
          ui.h(ui.Button, {
            disabled: busy || saving || !anyDirty,
            onClick: discard,
          }, '放弃更改'),
        ),
        anyDirty
          ? ui.h(ui.Banner, { kind: 'warn' }, '有未保存的更改，点击「保存并刷新」应用并自动刷新页面。')
          : null,

        // 0.4.2：同名预设覆盖确认（不覆盖就不会静默丢旧组合）
        confirmOverride !== null
          ? ui.h(ui.Dialog, {
            open: true,
            title: '覆盖预设',
            onClose: () => setConfirmOverride(null),
            footer: [
              ui.h(ui.Button, { onClick: () => setConfirmOverride(null) }, '取消'),
              ui.h(ui.Button, { kind: 'primary', onClick: () => doSavePreset(confirmOverride.name, confirmOverride.draft) }, '覆盖'),
            ],
          },
          ui.h('p', {}, `预设「${confirmOverride.name}」已存在，覆盖将替换它的挂载组合。确定继续？`),
          )
          : null,

        // 0.4.3：删除预设第一步——多选选择器（default/当前激活不可选；host 也拒）
        deleteMenuOpen
          ? ui.h(ui.Dialog, {
            open: true,
            title: '删除预设（可多选）',
            onClose: () => setDeleteMenuOpen(false),
            footer: [
              ui.h(ui.Button, { onClick: () => setDeleteMenuOpen(false) }, '取消'),
              ui.h(ui.Button, { kind: 'danger', disabled: deleteSel.length === 0, onClick: startDelete }, `下一步（已选 ${deleteSel.length} 个）`),
            ],
          },
          deletablePresets.length === 0
            ? ui.h('p', {}, '没有可删除的预设（默认与当前激活预设不可删除）。')
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
            title: '确认删除',
            onClose: () => setDeleteConfirm(null),
            footer: [
              ui.h(ui.Button, { onClick: () => setDeleteConfirm(null) }, '取消'),
              ui.h(ui.Button, { kind: 'danger', onClick: doDelete }, '确认删除'),
            ],
          },
          ui.h('p', {}, `确定删除所选 ${deleteConfirm.length} 个预设？该操作不可逆，将永久移除：${deleteConfirm.join('、')}。`),
          )
          : null,
      )
    }

    const plugin = {
      name: 'dsh-bundle-manager',
      inject: ['slots', 'settingsUi'],
      apply(ctx) {
        // The store must be created once here (never inside the render
        // function) and passed to the component through the inject face.
        const store = ctx.settingsUi.createSettingsStore({ get: () => call('list') })
        ctx.settingsUi.section({
          id: 'dsh-bundle-manager',
          order: 300,
          label: () => '插件挂载管理',
          inject: () => ({
            api: {
              list: () => call('list'),
              apply: (payload) => call('apply', payload),
              switchPreset: (payload) => call('preset/switch', payload),
              savePreset: (payload) => call('preset/save', payload),
              deletePresets: (payload) => call('preset/delete', payload),
            },
            ui: ctx.settingsUi,
            store,
          }),
          render: PluginManagerSection,
        })
      },
    }

    return plugin
  },
})
