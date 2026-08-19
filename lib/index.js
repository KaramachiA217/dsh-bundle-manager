/**
 * dsh-bundle-manager host half (v0.5.0).
 *
 * Runtime mount manager for optional third-party plugin bundles. It keeps a
 * self-owned "mount table" (a registry.json — NOT the profile manifest, NOT
 * the shared settings.yaml) and reconciles it against the in-memory Loader
 * tree through the runtime Loader API (create/remove). Mounting/unmounting a
 * plugin is instant and never rewrites `dsh.profile.bundles`, never touches
 * `.dsh/profiles/<name>/package.json`, and never restarts dsh.
 *
 * v0.5.0 (对外双轨 + 卸载半边, see BM0.5-IMPLEMENTATION-PLAN):
 * - 官方共存（§2.4 三落点）：candidates 排除 = framework ∪ 当前 bundles；
 *   boot/apply/preset 的 create 前 `!bundles.includes(pkg)` 防双重挂载；
 *   registry 行状态机 managed-by-bm | superseded-by-static | pending-import。
 * - import/export（§2.5）：import-to-bm / export-to-bundles / export-all-to-bundles
 *   三类显式「写 manifest」操作（「永不写 manifest」铁律的唯一例外），全部走
 *   A 级安全冗余（原子写 + .bak + JSON.parse 回滚 / 预注册 + 失败可见 / 一键回滚
 *   快照 / 依赖组提示 / framework 白名单保留）。
 * - uninstall（§1.2）：先 bm 出库（清 registry 行）后引导官方 `dsh plugin remove`
 *   （不在此进程内自动 spawn）；boot 反应式 GC 清外部已删包的行 + 记 failed。
 *
 * Design (see HANDOFF.md, HANDOFF-v0.3.md):
 * - inject: ['webServer', 'loader'] — the fenced JSON route and the Loader.
 * - The registry records `presets[activePreset]` = the desired mount table
 *   (pkg -> { config, state }), plus a `failed` ledger for mount attempts that
 *   threw.
 * - On boot the plugin reconciles SYNCHRONOUSLY (awaited in apply, P8) so the
 *   ON plugins are created (and their client halves composed into
 *   __DSH_BOOT__) BEFORE the `dsh web:` readiness line prints. It removes
 *   boot-mounted third-party entries that the registry marks OFF and creates
 *   the ON ones that are not yet in the tree (each independently try/catch).
 * - The client reaches this plugin through the fenced /bundle-manager/api
 *   JSON route (same browser-trust fence + envelope as dsh-mcp-manager).
 *
 * v0.3 hardening (HANDOFF-v0.3.md):
 * - Registry layout: shell mode (DSH_PLUGIN_MANAGER_HOME injected by the
 *   desktop shells) keeps the mount table inside the shell repo and NEVER
 *   writes `.dsh`; generic mode keeps the v0.2 dual-write semantics. A
 *   one-time migration copies the legacy `.dsh` mirror into the shell dir.
 * - Atomic writes (.tmp + rename, .bak last-known-good), corrupt-file
 *   quarantine (.corrupt-<ts>), size caps and proto-key filtering.
 * - "Empty registry" always seeds from the current boot mount state — never
 *   unmounts everything (P2/W3).
 * - Broken package.json manifests stay visible as `broken-manifest` rows
 *   (untoggleable) instead of silently vanishing (W4).
 * - Every mount goes through a 20s watchdog; pending rows report their
 *   `waitingFor` services; failures are classified (kind/attempts) (W5/W8).
 * - Storage write failures surface as `storage-error` and a `storage` block
 *   in `list`; all mutating endpoints run through a serial mutation queue
 *   with a 30s cap (W6/W7).
 * - This plugin's own boot effect and route registration never reject, so
 *   plugin-manager can never fail-loud the whole profile (W9).
 *
 * NOTE: published DSH plugin packages are loaded by Node as plain ESM —
 * no TypeScript syntax allowed in lib/.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-bundle-manager'
export const inject = ['webServer', 'loader']

const API_PREFIX = '/bundle-manager/api'
const MANAGED_PREFIX = 'plugin-managed-'
const MAX_BODY_BYTES = 1 << 20
const PRESET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const SHELL_HOME_PATTERN = /^[A-Za-z]:[\\/]/
// 0.5.0：key 类用户输入白名单——每段（scope 或裸名）都匹配
// `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`；scoped 包形如 `@scope/name`（两段都校验）。
const PKG_KEY_PATTERN = /^(?:@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

const REGISTRY_VERSION = 1
const MAX_PRESETS = 64
const MAX_ENTRIES_PER_PRESET = 512
const MAX_FAILED_ENTRIES = 128
const MAX_ERROR_LENGTH = 240
const MOUNT_TIMEOUT_MS = 20000
const MUTATION_TIMEOUT_MS = 30000

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const FAILED_KINDS = new Set([
  'import-failed',
  'activate-failed',
  'pending-timeout',
  'config-invalid',
  'manifest-invalid',
  'not-a-bundle',
  'unknown',
])

// 0.5.0 registry 行状态机：managed-by-bm（bm 运行时挂）｜superseded-by-static
// （已固化到官方静态层，bm 不再 create、list 只读展示）｜pending-import（已导入 bm、
// 待重启接管——manifest 摘条只在下一次 boot 生效，重启后转 managed-by-bm）。
const ROW_STATES = new Set(['managed-by-bm', 'superseded-by-static', 'pending-import'])

/**
 * Framework bundles that must never be toggleable at runtime. These carry the
 * core facilities (sandbox/permission/credentials/settings/session for
 * dsh-base, the whole browser shell + client-modules scan for dsh-web-app,
 * the settings UI kit itself, and this very plugin). Turning any of them off
 * would kill the shell, so the API refuses with `framework-protected`.
 * Both spellings are covered because profiles may reference the shipped
 * template tuple (@deepseek-ai/dsh-base) or the short name.
 */
const FRAMEWORK_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  'dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-web-app',
  'dsh-settings-ui',
  'dsh-bundle-manager',
])

// ── Environment / path resolution ────────────────────────────────────────────

/** Absolute path of this file: <pkg>/lib/index.js. */
const MODULE_FILE = fileURLToPath(import.meta.url)
/** Plugin package root: <pkg>/ (one level above lib/). */
const PLUGIN_PACKAGE_DIR = dirname(dirname(MODULE_FILE))

/** DeepSeek Harness home — `$DSH_HOME` else `~/.dsh` (mirrors resolveDshHome). */
const DSH_HOME = resolve(
  (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '')
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh'),
)

/**
 * Current profile name. DSH does not expose the profile as a service/env, so
 * read `DSH_PROFILE` (set by the desktop shell's main.js); fall back to
 * deriving it from this module's path (`.../profiles/<name>/node_modules/...`),
 * then to 'web'. Used only to READ the profile directory — never to write the
 * manifest.
 */
function resolveProfileName() {
  const env = process.env.DSH_PROFILE
  if (typeof env === 'string' && PROFILE_NAME_PATTERN.test(env)) return env
  const match = MODULE_FILE.match(/[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/]/)
  if (match && match[1] && PROFILE_NAME_PATTERN.test(match[1])) return match[1]
  return 'web'
}

const PROFILE_NAME = resolveProfileName()
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME)

/**
 * Registry persistence layout (v0.3; v0.4 改名 dsh-bundle-manager):
 * - shell mode: the desktop shell injects `DSH_BUNDLE_MANAGER_HOME` (its own
 *   `plugins/dsh-bundle-manager/` dir). The mount table lives INSIDE the shell
 *   repo; `.dsh` is never written. The legacy `.dsh` mirror is read once for
 *   migration and then kept untouched (read-only backup).
 * - generic mode (no env): primary in the plugin package dir plus a dual-written
 *   mirror under the profile dir (`profiles/<name>/bundle-manager/registry.json`).
 * - v0.4 rename migration: old paths under `dsh-plugin-manager` (old mirror
 *   `profiles/<name>/plugin-manager/registry.json` and old primary inside the
 *   old package dir, if it is still installed) are read as fallback sources and
 *   merged into the new primary once (`migrateLegacyOnce`); old paths are kept
 *   untouched (read-only). `DSH_PLUGIN_MANAGER_HOME` (old env) still works as a
 *   read-only fallback so old deployments do not break.
 */
function resolveRegistryLayout() {
  const legacyMirror = join(PROFILE_DIR, 'bundle-manager', 'registry.json')
  const oldMirror = join(PROFILE_DIR, 'plugin-manager', 'registry.json')
  const oldPrimary = join(PROFILE_DIR, 'node_modules', 'dsh-plugin-manager', 'registry.json')
  // v0.4：新 env 优先，旧 `DSH_PLUGIN_MANAGER_HOME` 只读回退（旧部署不破）
  const env = process.env.DSH_BUNDLE_MANAGER_HOME || process.env.DSH_PLUGIN_MANAGER_HOME
  if (
    typeof env === 'string'
    && env.trim() !== ''
    && SHELL_HOME_PATTERN.test(env.trim())
    && !env.includes('\u0000')
  ) {
    return { mode: 'shell', primary: join(env.trim(), 'registry.json'), legacyMirror, oldMirror, oldPrimary }
  }
  if (typeof env === 'string' && env.trim() !== '') {
    console.error(`[dsh-bundle-manager] ignoring invalid DSH_BUNDLE_MANAGER_HOME="${env}", falling back to generic registry layout`)
  }
  return { mode: 'generic', primary: join(PLUGIN_PACKAGE_DIR, 'registry.json'), legacyMirror, oldMirror, oldPrimary }
}

const REGISTRY_LAYOUT = resolveRegistryLayout()

// ── Registry persistence (self-owned mount table) ────────────────────────────

function defaultRegistry() {
  return { version: 1, activePreset: 'default', presets: { default: {} }, failed: {} }
}

function clampErrorText(error) {
  if (typeof error !== 'string') return '未知错误'
  const line = error.split('\n')[0].trim()
  if (line === '') return '挂载失败（无错误详情）'
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH)}…` : line
}

/**
 * Normalize untrusted registry data into the canonical shape, with hard caps
 * so a pathological file can never blow up memory or the mount table, and
 * proto-key filtering so `__proto__`-style keys can never pollute objects.
 */
function normalizeRegistry(data) {
  const out = defaultRegistry()
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return out
  if (
    typeof data.activePreset === 'string'
    && data.activePreset !== ''
    && !PROTO_KEYS.has(data.activePreset)
  ) {
    out.activePreset = data.activePreset
  }
  if (data.presets && typeof data.presets === 'object') {
    let presetCount = 0
    for (const [presetName, entries] of Object.entries(data.presets)) {
      if (presetCount >= MAX_PRESETS) break
      presetCount += 1
      if (PROTO_KEYS.has(presetName)) continue
      if (!entries || typeof entries !== 'object') continue
      const table = {}
      let entryCount = 0
      for (const [pkg, rec] of Object.entries(entries)) {
        if (entryCount >= MAX_ENTRIES_PER_PRESET) break
        entryCount += 1
        if (PROTO_KEYS.has(pkg)) continue
        const config = rec && typeof rec === 'object' && !Array.isArray(rec)
          && rec.config && typeof rec.config === 'object'
          ? rec.config
          : null
        // 0.5.0：行状态字段——旧 registry 无 state 视为 managed-by-bm（向后兼容）
        const state = rec && typeof rec === 'object' && !Array.isArray(rec)
          && typeof rec.state === 'string' && ROW_STATES.has(rec.state)
          ? rec.state
          : 'managed-by-bm'
        table[pkg] = { config, state }
      }
      out.presets[presetName] = table
    }
  }
  if (!out.presets[out.activePreset] || PROTO_KEYS.has(out.activePreset)) {
    out.presets[out.activePreset] = {}
  }
  if (data.failed && typeof data.failed === 'object') {
    let failedCount = 0
    for (const [pkg, rec] of Object.entries(data.failed)) {
      if (failedCount >= MAX_FAILED_ENTRIES) break
      failedCount += 1
      if (PROTO_KEYS.has(pkg)) continue
      const record = rec && typeof rec === 'object' ? rec : {}
      const kind = typeof record.kind === 'string' && FAILED_KINDS.has(record.kind)
        ? record.kind
        : 'unknown'
      const attempts = typeof record.attempts === 'number' && Number.isFinite(record.attempts)
        ? Math.min(999, Math.max(1, Math.floor(record.attempts)))
        : 1
      out.failed[pkg] = {
        error: clampErrorText(record.error),
        // P2-D（0.3.1）：at 非有限数字归 0——损坏文件塞字符串会让淘汰排序 NaN、删错条目
        at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
        kind,
        attempts,
      }
    }
  }
  return out
}

/**
 * Best-effort quarantine of an unreadable registry file: rename it to
 * `.corrupt-<timestamp>` (never overwrite, never silently drop) and log.
 */
function quarantineCorrupt(path, reason) {
  const corruptPath = `${path}.corrupt-${Date.now()}`
  try {
    renameSync(path, corruptPath)
  } catch {
    // rename failed (locks/permissions) — the file stays in place; the next
    // write attempt will try the .bak path first.
  }
  console.error(`[dsh-bundle-manager] registry ${path} is corrupt (${reason}); renamed to ${corruptPath}`)
}

/** Read + validate one registry source file. Never throws. */
function tryReadRegistrySource(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error(`[dsh-bundle-manager] cannot read registry ${path}: ${err.message ?? err}`)
    }
    return { status: 'missing' }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    quarantineCorrupt(path, 'JSON parse failed')
    return { status: 'corrupt' }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    quarantineCorrupt(path, 'not a JSON object')
    return { status: 'corrupt' }
  }
  if (data.version !== REGISTRY_VERSION) {
    console.error(`[dsh-bundle-manager] registry ${path} has unsupported version (${JSON.stringify(data.version)}), treating as absent`)
    return { status: 'invalid-version' }
  }
  return { status: 'ok', data }
}

/**
 * Load the registry, also reporting whether it was actually persisted (vs. a
 * fresh fallback). `found: false` means no usable source exists — the caller
 * must seed the default preset from the current boot state so a first
 * install adopts "everything currently mounted = ON" instead of "OFF".
 */
function loadRegistryWithSource() {
  // v0.4 改名：新布局源优先（primary → .bak → 新 mirror），最后回退到旧改名路径
  // （旧 mirror → 旧 primary，若旧包目录仍在），保证 rename 后旧数据不丢。
  const sources = [
    REGISTRY_LAYOUT.primary,
    `${REGISTRY_LAYOUT.primary}.bak`,
    REGISTRY_LAYOUT.legacyMirror,
    REGISTRY_LAYOUT.oldMirror,
    REGISTRY_LAYOUT.oldPrimary,
  ]
  for (const path of sources) {
    if (!path) continue
    const result = tryReadRegistrySource(path)
    if (result.status === 'ok') return { registry: normalizeRegistry(result.data), found: true }
  }
  return { registry: defaultRegistry(), found: false }
}

function loadRegistry() {
  return loadRegistryWithSource().registry
}

/**
 * Atomic JSON write: write `<path>.tmp`, then rename over the target (atomic
 * on the same volume). Before overwriting, copy the current content to
 * `<path>.bak` as a last-known-good — but only when it still parses, so a
 * corrupt file can never be "backed up" over a good one. Returns
 * { ok, error } so callers can surface failures instead of swallowing them.
 */
function writeJsonFileAtomic(path, content) {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (err) {
    return { ok: false, error: `目录创建失败：${err.message ?? err}` }
  }
  if (existsSync(path)) {
    let current
    try {
      current = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      current = undefined
    }
    if (current !== undefined) {
      try {
        writeFileSync(`${path}.bak`, readFileSync(path, 'utf8'), 'utf8')
      } catch {
        // best-effort backup — not fatal
      }
    }
  }
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    try {
      renameSync(tmp, path)
    } catch {
      // rename failed (exotic fs / AV lock) — fall back to a direct write
      writeFileSync(path, content, 'utf8')
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message ?? err}` }
  }
}

/** Last registry write failure (null = last write succeeded / none yet). */
let lastStorageError = null

function saveRegistry(registry) {
  const json = `${JSON.stringify(registry, null, 2)}\n`
  const results = [writeJsonFileAtomic(REGISTRY_LAYOUT.primary, json)]
  if (REGISTRY_LAYOUT.mode === 'generic') {
    results.push(writeJsonFileAtomic(REGISTRY_LAYOUT.legacyMirror, json))
  }
  const failed = results.find(result => !result.ok)
  lastStorageError = failed ? failed.error : null
  if (failed) {
    console.error(`[dsh-bundle-manager] registry write failed: ${failed.error}`)
  }
  return { ok: failed === undefined, error: failed ? failed.error : null }
}

function assertStorageWriteOk(saveResult) {
  if (!saveResult.ok) {
    throw new ApiError(
      'storage-error',
      `挂载已生效，但挂载表写入失败（${saveResult.error}）。本次更改将在重启后失效。`,
    )
  }
}

/**
 * One-time migration (v0.4 改名后通用)：新 primary 不存在时，从可用旧源合并：
 * 新布局 mirror（`bundle-manager/`）> 旧改名 mirror（`plugin-manager/`）>
 * 旧改名 primary（旧包目录内，若未卸）。旧路径一律只读保留（不删不改）。
 * shell 模式先例（v0.3 把 `.dsh` mirror 迁进壳目录）被该通用实现覆盖。
 */
function migrateLegacyOnce() {
  if (existsSync(REGISTRY_LAYOUT.primary)) return
  let result = { status: 'missing' }
  let from = null
  for (const path of [REGISTRY_LAYOUT.legacyMirror, REGISTRY_LAYOUT.oldMirror, REGISTRY_LAYOUT.oldPrimary]) {
    if (!path || !existsSync(path)) continue
    const r = tryReadRegistrySource(path)
    if (r.status === 'ok') { result = r; from = path; break }
  }
  if (result.status !== 'ok') return
  const registry = normalizeRegistry(result.data)
  const write = writeJsonFileAtomic(REGISTRY_LAYOUT.primary, `${JSON.stringify(registry, null, 2)}\n`)
  if (write.ok) {
    console.error(`[dsh-bundle-manager] migrated registry ${from} → ${REGISTRY_LAYOUT.primary} (old paths kept as read-only)`)
  } else {
    console.error(`[dsh-bundle-manager] registry migration failed: ${write.error}`)
  }
}

// ── Profile manifest / package introspection ─────────────────────────────────

function readJsonFileSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** This plugin's own version (read from its package.json at module load). */
const PLUGIN_VERSION = readJsonFileSafe(join(PLUGIN_PACKAGE_DIR, 'package.json'))?.version ?? '未知'

function profileManifest() {
  return readJsonFileSafe(join(PROFILE_DIR, 'package.json'))
}

/**
 * A dependency package's package.json, tri-stated: parseable JSON object /
 * unparseable (bad JSON or not an object) / missing (ENOENT — declared but
 * not installed). Never throws.
 */
function packageManifest(pkg) {
  const path = join(PROFILE_DIR, 'node_modules', ...pkg.split('/'), 'package.json')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { manifest: undefined, parseable: false, missing: err && err.code === 'ENOENT' }
  }
  try {
    const data = JSON.parse(text)
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      return { manifest: data, parseable: true, missing: false }
    }
  } catch {
    // fall through to unparseable
  }
  return { manifest: undefined, parseable: false, missing: false }
}

function manifestState(pkg) {
  const { manifest, parseable, missing } = packageManifest(pkg)
  if (parseable) return manifest.dsh?.bundle?.patch !== undefined ? 'bundle' : 'not-bundle'
  return missing ? 'missing' : 'unparseable'
}

/** A dependency is a "bundle" iff its package.json declares `dsh.bundle.patch`. */
function isBundlePackage(pkg) {
  return manifestState(pkg) === 'bundle'
}

function isFramework(pkg) {
  return FRAMEWORK_BUNDLES.has(pkg)
}

/**
 * 0.5.0：物理存在于 profile `node_modules`（含 `@scope/pkg`）的包名集合。
 * 反应式 GC 用它判定「行对应包是否真的还在磁盘上」（不只看 package.json deps，
 * 兜住 deps 里被删但磁盘残留 / deps 里声明但未装的边界）。
 */
function physicalNodeModulesPackages() {
  const out = new Set()
  const dir = join(PROFILE_DIR, 'node_modules')
  let top = []
  try {
    top = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of top) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      let scoped = []
      try {
        scoped = readdirSync(join(dir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (child.isDirectory()) out.add(`${entry.name}/${child.name}`)
      }
    } else {
      out.add(entry.name)
    }
  }
  return out
}

/**
 * Discover every installed toggleable plugin: the union of (a) declared
 * dependencies that declare `dsh.bundle.patch`, and (b) packages physically
 * present under the profile's node_modules that declare `dsh.bundle.patch`.
 * The node_modules scan catches a plugin that is installed but not (or no
 * longer) declared in `package.json` — it still shows up and can be mounted
 * (P9).
 */
function discoverCandidates(dependencies) {
  const seen = new Set()
  const out = []

  // (a) declared dependencies that are bundles (canonical package names).
  for (const pkg of dependencies) {
    if (isFramework(pkg)) continue
    if (isBundlePackage(pkg)) {
      seen.add(pkg)
      out.push(pkg)
    }
  }

  // (b) scan node_modules for bundle packages not already covered. Only
  // packages declaring `dsh.bundle.patch` qualify, so plain/transitive deps
  // are ignored.
  const nodeModulesDir = join(PROFILE_DIR, 'node_modules')
  let top = []
  try {
    top = readdirSync(nodeModulesDir, { withFileTypes: true })
  } catch {
    top = []
  }
  for (const entry of top) {
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      let scoped = []
      try {
        scoped = readdirSync(join(nodeModulesDir, entry.name), { withFileTypes: true })
      } catch {
        scoped = []
      }
      for (const child of scoped) {
        if (!child.isDirectory()) continue
        const pkg = `${entry.name}/${child.name}`
        if (seen.has(pkg) || isFramework(pkg)) continue
        if (isBundlePackage(pkg)) {
          seen.add(pkg)
          out.push(pkg)
        }
      }
    } else if (entry.isDirectory()) {
      const pkg = entry.name
      if (seen.has(pkg) || isFramework(pkg)) continue
      if (isBundlePackage(pkg)) {
        seen.add(pkg)
        out.push(pkg)
      }
    }
  }

  return out
}

/**
 * Fresh snapshot of the profile's installed third-party universe:
 * `dependencies` (user-installed packages), `bundles` (dsh.profile.bundles,
 * read-only), `candidates` (installed packages declaring dsh.bundle — from
 * dependencies OR the node_modules scan — that are NOT framework and NOT
 * already in the official static layer's `dsh.profile.bundles`), and
 * `broken` (declared dependencies whose package.json cannot be parsed).
 *
 * 0.5.0：candidates 排除 = framework 白名单 ∪ 当前 `dsh.profile.bundles`
 * （现读 manifest，不缓存）——已在官方静态层的包不给「可管理 / toggle」入口，
 * 从而避免「官方静态层 + bm 运行时」双重挂载（§2.4-1）。
 */
function snapshot() {
  const manifest = profileManifest() ?? {}
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const bundleSet = new Set(bundles)
  const candidates = discoverCandidates(dependencies).filter(pkg => !bundleSet.has(pkg))
  const broken = dependencies.filter(pkg => !isFramework(pkg) && manifestState(pkg) === 'unparseable')
  return { dependencies, bundles, candidates, broken }
}

/**
 * Live read of the current `dsh.profile.bundles` array (fresh manifest read,
 * uncached — §2.4-1「现读 manifest，不缓存」). Never throws.
 */
function currentBundles() {
  const manifest = profileManifest()
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles : []
}

// ── Profile manifest write (0.5.0, A-level redundancy) ───────────────────────
//
// import-to-bm / export-to-bundles / export-all-to-bundles 是 bm「永不写
// manifest」铁律的三类显式例外（§1.1）。写前备份 → 临时文件 + rename 原子替换 →
// 写后 JSON.parse 校验失败自动回滚 .bak。后缀用 `.bm.bak` / `.bm.tmp` 避免与
// registry 的 `.bak` 或官方可能引入的文件混淆。

const MANIFEST_PATH = join(PROFILE_DIR, 'package.json')
const MANIFEST_BAK = `${MANIFEST_PATH}.bm.bak`

/** Fresh, parseable profile manifest data object, or undefined if unreadable. */
function readProfileManifestData() {
  return readJsonFileSafe(MANIFEST_PATH)
}

/**
 * Atomic + rollback write of the profile manifest. `bundles` is the exact new
 * `dsh.profile.bundles` array. The post-write JSON.parse check restores `.bak`
 * on failure so a single import/export operation can never corrupt the whole
 * manifest. Throws ApiError('manifest-write-error') on a write/validation
 * failure that could not be rolled back safely.
 */
function writeManifestBundles(bundles, { recordBackup = true } = {}) {
  const data = readProfileManifestData()
  if (data === undefined || data === null || typeof data !== 'object') {
    throw new ApiError('manifest-write-error', 'profile manifest 无法解析，拒绝写入（不覆盖坏文件）')
  }
  // normalize dsh.profile shape
  if (data.dsh === undefined || data.dsh === null || typeof data.dsh !== 'object') data.dsh = {}
  if (data.dsh.profile === undefined || data.dsh.profile === null || typeof data.dsh.profile !== 'object') {
    data.dsh.profile = {}
  }
  data.dsh.profile.bundles = Array.from(new Set(bundles))

  // 1) backup current (only when it parses — never back up a corrupt file)
  if (recordBackup && existsSync(MANIFEST_PATH)) {
    try {
      const cur = readFileSync(MANIFEST_PATH, 'utf8')
      const parsed = JSON.parse(cur)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        writeFileSync(MANIFEST_BAK, cur, 'utf8')
      }
    } catch { /* best-effort backup */ }
  }

  // 2) atomic write: tmp + rename (same volume); fall back to direct write
  const tmp = `${MANIFEST_PATH}.bm.tmp`
  const text = `${JSON.stringify(data, null, 2)}\n`
  try {
    writeFileSync(tmp, text, 'utf8')
    try {
      renameSync(tmp, MANIFEST_PATH)
    } catch {
      writeFileSync(MANIFEST_PATH, text, 'utf8')
    }
  } catch (err) {
    throw new ApiError('manifest-write-error', `profile manifest 写入失败：${err.message ?? err}`)
  }

  // 3) post-write validation + automatic rollback
  try {
    const check = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    if (check === null || typeof check !== 'object' || Array.isArray(check)) {
      throw new Error('written manifest is not a JSON object')
    }
  } catch (err) {
    if (recordBackup && existsSync(MANIFEST_BAK)) {
      try {
        const bakText = readFileSync(MANIFEST_BAK, 'utf8')
        const bakParsed = JSON.parse(bakText)
        if (bakParsed !== null && typeof bakParsed === 'object' && !Array.isArray(bakParsed)) {
          writeFileSync(MANIFEST_PATH, bakText, 'utf8')
        }
      } catch { /* best-effort restore */ }
    }
    throw new ApiError('manifest-write-error', `profile manifest 写后校验失败，已回滚：${err.message ?? err}`)
  }

  return { ok: true, bundles: data.dsh.profile.bundles }
}

// ── Import/export batch snapshot (0.5.0, §2.6-3 一键回滚) ─────────────────────
//
// 一个 import 批次写前生成快照（被改 manifest 片段 + 受影响插件行的 registry
// 前状态），失败/不满意可经 `import/rollback` 一键写回 bundles + 还原 registry
// 行并引导重启。快照存在 host 进程内存（导入本就需重启生效，回滚在重启前发生，
// 不依赖跨重启持久化）。保留最近 MAX_SNAPSHOTS 个。

const MAX_SNAPSHOTS = 20
const importSnapshots = new Map() // id -> { bundlesBefore, rowsBefore, pkgs, at }

function createImportSnapshot(bundlesBefore, rowsBefore, pkgs) {
  const id = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const snap = { id, bundlesBefore: [...bundlesBefore], rowsBefore, pkgs: [...pkgs], at: Date.now() }
  importSnapshots.set(id, snap)
  const keys = [...importSnapshots.keys()]
  for (let i = 0; i < keys.length - MAX_SNAPSHOTS; i++) importSnapshots.delete(keys[i])
  return snap
}


function readVersion(pkg) {
  const { manifest } = packageManifest(pkg)
  const version = manifest?.version
  return typeof version === 'string' && version !== '' ? version : '未知'
}

/**
 * Single adapter over Cordis's PRIVATE fiber internals. All reads of
 * `fiber.state` / `fiber._error` / `fiber.inject` / `fiber.ctx` are confined
 * here with defensive fallbacks and try/catch, so a cordis refactor that
 * renames/shifts these internals degrades to a conservative answer instead of
 * throwing or silently mis-reporting.
 *
 * ⚠️ DEPENDS ON CORDIS INTERNAL CONTRACT (not public API): the TS `const enum`
 * FiberState (2 = ACTIVE), and the `private` `_error` / `inject` fields.
 * Re-verify on every cordis / deepseek-harness rc upgrade.
 */
function inspectFiber(entry) {
  const out = { state: 'pending', error: null, waitingFor: [] }
  let fiber
  try {
    fiber = entry?.fiber
  } catch {
    fiber = undefined
  }
  if (fiber === undefined || fiber === null) return out
  try {
    const state = fiber.state
    if (state === 2) out.state = 'active'
    else if (state === 1) out.state = 'loading'
    else out.state = 'pending'
  } catch {
    out.state = 'pending'
  }
  try {
    if (fiber._error !== undefined && fiber._error !== null) {
      out.state = 'failed'
      out.error = fiber._error
    }
  } catch {
    /* no error info — keep current state */
  }
  try {
    const inject = fiber.inject
    const keys = (inject === undefined || inject === null)
      ? []
      : (Array.isArray(inject) ? inject : Object.keys(inject))
    const fiberCtx = fiber.ctx
    out.waitingFor = (fiberCtx === undefined || fiberCtx === null)
      ? keys
      : keys.filter(service => {
        try { return fiberCtx.get(service) === undefined } catch { return false }
      })
  } catch {
    out.waitingFor = []
  }
  return out
}

/** Live FiberState: 2 === ACTIVE (TS const enum, erased at runtime). */
function fiberStateOf(entry) {
  return inspectFiber(entry).state
}

/**
 * Services a pending/loading fiber is still waiting for — same shape as the
 * official boot audit (`packages/boot/app-boot/src/index.ts:711`).
 */
function waitingForOf(entry) {
  return inspectFiber(entry).waitingFor
}

function isManagedId(id) {
  return typeof id === 'string' && id.startsWith(MANAGED_PREFIX)
}

function errorMessage(err) {
  let message
  if (err instanceof Error) message = err.message
  else if (err !== undefined && err !== null) message = String(err)
  else message = '未知错误'
  const line = String(message).split('\n')[0].trim()
  if (line === '') return '挂载失败（无错误详情）'
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH)}…` : line
}

/** Heuristic failure classification (W8) — text-based, no extra imports. */
function classifyMountError(err) {
  const text = String(err instanceof Error ? err.message : (err ?? ''))
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package|Cannot find module/i.test(text)) return 'import-failed'
  if (/schema|schemastery|config/i.test(text)) return 'config-invalid'
  return 'activate-failed'
}

/**
 * Record (or bump) a failed-mount ledger entry: kind + attempts, error text
 * clamped, ledger capped at MAX_FAILED_ENTRIES entries evicting the oldest
 * by `at`.
 */
function recordFailure(registry, pkg, { error, kind, at = Date.now() }) {
  const prev = registry.failed[pkg]
  const attempts = Math.min(
    999,
    ((prev && typeof prev.attempts === 'number' && prev.attempts > 0) ? prev.attempts : 0) + 1,
  )
  registry.failed[pkg] = {
    error: clampErrorText(error),
    at,
    kind: (typeof kind === 'string' && FAILED_KINDS.has(kind)) ? kind : classifyMountError(error) || 'unknown',
    attempts,
  }
  const keys = Object.keys(registry.failed)
  if (keys.length > MAX_FAILED_ENTRIES) {
    keys.sort((a, b) => (registry.failed[a]?.at ?? 0) - (registry.failed[b]?.at ?? 0))
    for (const key of keys.slice(0, keys.length - MAX_FAILED_ENTRIES)) delete registry.failed[key]
  }
}

/**
 * Reject (rather than silently truncate) a registry that exceeds the same
 * hard caps the read path enforces in `normalizeRegistry`. Keeps the write
 * path from persisting data the next boot would silently drop (P1-2).
 */
function enforceCaps(registry) {
  if (Object.keys(registry.presets).length > MAX_PRESETS) {
    throw new ApiError('bad-request', `预设数量已达上限（${MAX_PRESETS}）`)
  }
  for (const [presetName, table] of Object.entries(registry.presets)) {
    if (table && typeof table === 'object' && !Array.isArray(table)
      && Object.keys(table).length > MAX_ENTRIES_PER_PRESET) {
      throw new ApiError('bad-request', `预设 "${presetName}" 条目数已达上限（${MAX_ENTRIES_PER_PRESET}）`)
    }
  }
  if (Object.keys(registry.failed ?? {}).length > MAX_FAILED_ENTRIES) {
    throw new ApiError('bad-request', `失败账本已达上限（${MAX_FAILED_ENTRIES}）`)
  }
}

// ── Mutation queue (W6) ──────────────────────────────────────────────────────

let mutationChain = Promise.resolve()

/**
 * Serialize all mutating operations (apply / preset switch / preset save) so
 * concurrent requests can never race the registry read-modify-write. Read-only
 * `list` does not go through the queue. Each queued op additionally gets a
 * MUTATION_TIMEOUT_MS cap (a second safety net beyond the mount watchdog).
 *
 * NOTE: the timeout only rejects the RETURNED promise — the underlying task()
 * keeps running on the queue (it is not cancellable). A `timeout` response
 * means "took too long to confirm", NOT "nothing happened"; the eventual
 * result is still applied, so re-read via `list` (P2-1).
 */
function runMutation(task) {
  const run = mutationChain.then(() => task())
  mutationChain = run.then(() => {}, () => {})
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new ApiError('timeout', '操作超时（30 秒未完成），请重试', 504))
    }, MUTATION_TIMEOUT_MS)
    run.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeError(res, error) {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

function requireString(payload, key) {
  const record = payload === null || typeof payload !== 'object' ? null : payload
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new ApiError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

// ── Browser-trust fence (behaviorally identical to the /api gateway's) ───────

function header(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(req, trustedHosts) {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** The connection row's resolved trustedHosts (live read; the /api fence's own list). */
function trustedHostsOf(ctx) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name === 'connection') {
      return entry.options.config?.trustedHosts ?? []
    }
  }
  return []
}

// ── Plugin body ──────────────────────────────────────────────────────────────

export async function apply(ctx) {
  const trustedHosts = trustedHostsOf(ctx)
  const fence = req => isTrustedApiRequest(req, trustedHosts)

  // ── Loader tree helpers (closed over ctx) ──────────────────────────────────
  const loaderEntries = () => [...ctx.loader.entries()]

  const findEntryByPkg = (pkg) => {
    for (const entry of loaderEntries()) {
      if (entry.options?.name === pkg) return entry
    }
    return undefined
  }

  const mountedThirdParty = (candidates) => {
    const candidateSet = new Set(candidates)
    const out = []
    for (const entry of loaderEntries()) {
      const pkg = entry.options?.name
      if (typeof pkg === 'string' && candidateSet.has(pkg)) {
        out.push({ pkg, entry, state: fiberStateOf(entry) })
      }
    }
    return out
  }

  /**
   * Mount a plugin row with a watchdog: resolves `{status:'created'} |
   * {status:'error', error} | {status:'timeout'}`. On timeout the row is
   * deliberately NOT removed — its fiber may still be booting; the caller
   * records a `pending-timeout` ledger entry and `list` keeps showing the
   * live fiber state.
   */
  const mountWithWatchdog = (options, timeoutMs = MOUNT_TIMEOUT_MS) => new Promise((resolvePromise) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    const timer = setTimeout(() => settle({ status: 'timeout' }), timeoutMs)
    ctx.loader.create(options).then(
      () => settle({ status: 'created' }),
      (error) => settle({ status: 'error', error }),
    )
  })

  /** Remove a possibly-partially-created row left behind by a failed create. */
  const removeResidualRow = async (pkg) => {
    const residual = findEntryByPkg(pkg)
    if (residual !== undefined) {
      try { await residual.parent.remove(residual.options.id) } catch {}
    }
  }

  const recordMountFailure = (registry, pkg, err) => {
    recordFailure(registry, pkg, { error: errorMessage(err), kind: classifyMountError(err) })
  }

  const mountOptionsFor = (pkg, activeTable) => {
    const config = activeTable[pkg]?.config
    const options = { id: MANAGED_PREFIX + pkg, name: pkg }
    if (config && typeof config === 'object') options.config = config
    return { options, config }
  }

  /**
   * Mount one desired row through the watchdog and update the registry
   * bookkeeping. `preserveOnFailure` keeps the pkg in the table on
   * failure/timeout (used by boot reconcile and preset switch, where the
   * table is authoritative); the apply path removes it so a failed row
   * becomes OFF instead of silently ON-but-broken.
   * @returns {'created'|'error'|'timeout'} — 0.3.1 起返回挂载结果（boot 分组调度器用）
   */
  const mountRow = async (registry, pkg, activeTable, { preserveOnFailure = false } = {}) => {
    const { options, config } = mountOptionsFor(pkg, activeTable)
    const prevState = activeTable[pkg]?.state
    const outcome = await mountWithWatchdog(options)
    if (outcome.status === 'created') {
      activeTable[pkg] = { config: config ?? null, state: 'managed-by-bm' }
      delete registry.failed[pkg]
      return 'created'
    }
    if (outcome.status === 'error') {
      if (!preserveOnFailure) delete activeTable[pkg]
      recordMountFailure(registry, pkg, outcome.error)
      await removeResidualRow(pkg)
      return 'error'
    }
    // timeout（P1-B，0.3.1）：保持用户意图——表行写入/保留。apply ON 路径
    // 的 diff 不预写表行，这里补写；boot/preset 路径本就有行，写幂等。
    // 行状态保留原值（pending-import 期间超时仍为 pending-import，重启后重试）。
    activeTable[pkg] = { config: config ?? null, state: (prevState && ROW_STATES.has(prevState)) ? prevState : 'managed-by-bm' }
    recordFailure(registry, pkg, {
      error: `挂载超时（${MOUNT_TIMEOUT_MS / 1000} 秒未完成启动）`,
      kind: 'pending-timeout',
    })
    return 'timeout'
  }

  // ── Mount operations ───────────────────────────────────────────────────────
  const reconcileAtBoot = async () => {
    migrateLegacyOnce()
    const { registry, found } = loadRegistryWithSource()
    const { candidates, dependencies, bundles } = snapshot()
    const bundleSet = new Set(bundles)

    const mountedThird = mountedThirdParty(candidates)
    const active = registry.presets[registry.activePreset] ?? {}

    // 0.5.0 反应式 GC（§1.2 保险丝）：registry 行对应包已不在 profile `dependencies`
    // 且不在 node_modules（被外部官方直删、绕过 bm）→ 清行 + 记 failed 账本提示。
    // 不依赖每次卸载都走 bm 入口。已固化到静态层的行（superseded-by-static）若仍在
    // bundles 则保留（静态层还引用它）；仅在确实消失时清理。
    const nodeModulesPkgs = physicalNodeModulesPackages()
    for (const pkg of Object.keys({ ...active })) {
      const stillInstalled = dependencies.includes(pkg) || nodeModulesPkgs.has(pkg)
      if (stillInstalled || bundleSet.has(pkg)) continue
      delete active[pkg]
      for (const table of Object.values(registry.presets)) delete table[pkg]
      recordFailure(registry, pkg, {
        error: '包已被外部移除（不再存在于 profile 依赖/磁盘），已自动清理挂载行',
        kind: 'not-a-bundle',
      })
      console.error(`[dsh-bundle-manager] 反应式 GC：清理 ${pkg}（外部已移除），记 failed 账本`)
    }

    // Seed: first install (no persisted registry yet) OR an existing-but-empty
    // registry while boot-mounted third-party plugins are present. "Empty"
    // always means "keep the current mount state" — never "unmount
    // everything" (P2/W3).
    const seedNeeded = !found
      || (Object.keys(active).length === 0
        && Object.keys(registry.failed ?? {}).length === 0
        && mountedThird.length > 0)
    if (seedNeeded) {
      for (const { pkg } of mountedThird) {
        active[pkg] = { config: null, state: 'managed-by-bm' }
      }
    }

    // (a) remove boot-mounted third-party entries the registry marks OFF.
    for (const entry of [...loaderEntries()]) {
      const pkg = entry.options?.name
      if (typeof pkg !== 'string' || !candidates.includes(pkg)) continue
      if (pkg in active) continue
      try {
        // Boot-mounted entries live nested under the root `include` subtree;
        // `loader.remove(entry.id)` passes the full path to the group's
        // bare-id remove and silently no-ops. Remove via the parent group.
        await entry.parent.remove(entry.options.id)
      } catch {
        // already gone / transactional teardown raced — nothing to do
      }
    }

    // (b) create registry-ON entries not already mounted — 分组并行 boot +
    //     串行单飞重试（C，0.3.1）：
    //     1. 确定性分片（第 i 项进第 i % G 组），组间并行、组内串行（同组
    //        相对顺序与旧串行一致）；G 可由 DSH_PM_BOOT_GROUPS 覆盖（=1 即
    //        旧串行行为，供并发可疑时对照复现）。
    //     2. 并行轮后，快速失败型（error）逐项串行单飞重试一次——并行副作用
    //        或依赖时序造成的「假失败」由此区分（重试成功 = 假失败、清账本）；
    //        真失败进账本并输出完整 debug 日志。
    //     3. 超时型（pending-timeout）绝不重试：fiber 仍在启动，重试 = 先杀
    //        掉可能即将成功的 fiber 再白等 20s；行保留，由 fiber 状态校正。
    // 0.5.0：表内 ON 但已在官方静态层（in bundles）→ bm 不 create（防双重挂载），
    // 行标 superseded-by-static（list 只读展示）。
    // 表内 ON 但非候选（未安装 / 坏清单）→ 进账本（可见，不静默）——与旧串行语义一致
    for (const pkg of Object.keys(active)) {
      if (bundleSet.has(pkg)) {
        if (active[pkg].state !== 'superseded-by-static') active[pkg].state = 'superseded-by-static'
        continue
      }
      if (candidates.includes(pkg)) continue
      const state = manifestState(pkg)
      recordFailure(registry, pkg, {
        error: state === 'unparseable' ? 'package.json 解析失败，无法挂载' : '未安装或不是可选 bundle（已从挂载表跳过）',
        kind: state === 'unparseable' ? 'manifest-invalid' : 'not-a-bundle',
      })
    }
    const bootTargets = Object.keys(active)
      .filter(pkg => !bundleSet.has(pkg) && candidates.includes(pkg) && findEntryByPkg(pkg) === undefined)
    const groupCount = Math.max(1, Math.min(8, Number(process.env.DSH_PM_BOOT_GROUPS) || 4))
    const groups = []
    for (let i = 0; i < bootTargets.length; i++) {
      const gi = i % groupCount
      groups[gi] = groups[gi] ?? []
      groups[gi].push(bootTargets[i])
    }
    const groupList = groups.filter(Boolean)

    const runGroup = async (group) => {
      const results = []
      for (const pkg of group) {
        try {
          results.push({ pkg, status: await mountRow(registry, pkg, active, { preserveOnFailure: true }) })
        } catch (err) {
          // mountRow 理论不抛（watchdog 消化一切）——防御：归类为 error 并记账
          recordMountFailure(registry, pkg, err)
          results.push({ pkg, status: 'error' })
        }
      }
      return results
    }

    const passResults = await Promise.allSettled(groupList.map(runGroup))
    const fastFails = []
    for (const settled of passResults) {
      if (settled.status !== 'fulfilled') {
        console.error(`[dsh-bundle-manager] boot group threw: ${settled.reason?.stack ?? settled.reason}`)
        continue
      }
      for (const r of settled.value) {
        if (r.status === 'error') fastFails.push(r.pkg)
      }
    }

    if (fastFails.length > 0) {
      console.log(`[dsh-bundle-manager] boot mount: ${bootTargets.length} 插件 / ${groupCount} 组并行 / ${fastFails.length} 个快速失败进入串行单飞重试`)
      for (const pkg of fastFails) {
        await removeResidualRow(pkg) // 幂等：快速失败行通常已被 create 回滚，保险再清一次
        let status = 'error'
        try {
          status = await mountRow(registry, pkg, active, { preserveOnFailure: true })
        } catch (err) {
          recordMountFailure(registry, pkg, err)
        }
        if (status === 'created') {
          console.log(`[dsh-bundle-manager] ${pkg} 并行失败 → 单飞重试成功（疑似并发干扰/依赖时序，账本已清）`)
        } else {
          console.error(`[dsh-bundle-manager] ${pkg} 单飞重试仍失败（真失败）：status=${status} 错误=${registry.failed[pkg]?.error ?? '未知'} kind=${registry.failed[pkg]?.kind ?? 'unknown'} attempts=${registry.failed[pkg]?.attempts ?? 1}`)
        }
      }
    } else if (bootTargets.length > 0) {
      console.log(`[dsh-bundle-manager] boot mount: ${bootTargets.length} 插件 / ${groupCount} 组并行，全部成功`)
    }

    const saveResult = saveRegistry(registry)
    if (!saveResult.ok) {
      console.error(`[dsh-bundle-manager] boot registry write failed: ${saveResult.error}`)
    }
  }

  /**
   * Apply a full desired mount table (pkg -> boolean) in one pass: create the
   * ON-not-mounted rows, remove the OFF-mounted rows, persist. The "save"
   * action awaits this, then the client hard-refreshes so the browser reloads
   * the (already-updated) __DSH_BOOT__ graph — the only reliable way to
   * reconcile client halves given the loader.unload stub + disabled HMR.
   */
  const applyMountTable = async (desired) => {
    const registry = loadRegistry()
    const active = registry.presets[registry.activePreset] ?? {}
    const { candidates, bundles } = snapshot()
    const candidateSet = new Set(candidates)
    const bundleSet = new Set(bundles)

    // Validate the whole table up front (fail-fast — no partial apply).
    for (const [pkg, desiredOn] of Object.entries(desired)) {
      if (isFramework(pkg)) {
        throw new ApiError('framework-protected', `"${pkg}" 是框架核心包，禁止运行时切换`)
      }
      // 0.5.0：已在官方静态层的包禁止运行时 create（双重挂载防线）——只能导入/导出
      if (bundleSet.has(pkg) && desiredOn === true) {
        throw new ApiError('superseded-by-static', `"${pkg}" 已在官方静态层（dsh.profile.bundles），禁止运行时挂载；如需 bm 管理请先「导入到 bm」`)
      }
      if (desiredOn === true && !candidateSet.has(pkg)) {
        if (manifestState(pkg) === 'unparseable') {
          throw new ApiError('bad-request', `"${pkg}" 的 package.json 解析失败，无法挂载`)
        }
        throw new ApiError('bad-request', `"${pkg}" 不是已安装的可选 bundle（依赖中不存在或无 dsh.bundle 声明）`)
      }
    }

    // Apply the diff (create ON-not-mounted, remove OFF-mounted).
    for (const [pkg, desiredOn] of Object.entries(desired)) {
      const existing = findEntryByPkg(pkg)
      const isFailed = existing !== undefined && inspectFiber(existing).state === 'failed'

      if (desiredOn === true) {
        if (existing !== undefined && !isFailed && fiberStateOf(existing) === 'active') {
          // already healthy-mounted — just record it ON
          active[pkg] = { config: active[pkg]?.config ?? null, state: 'managed-by-bm' }
          delete registry.failed[pkg]
          continue
        }
        // failed/pending/loading entry still occupying the tree — clear it,
        // then recreate
        if (existing !== undefined) {
          try { await existing.parent.remove(existing.options.id) } catch {}
        }
        await mountRow(registry, pkg, active)
      } else {
        if (existing !== undefined) {
          try { await existing.parent.remove(existing.options.id) } catch {}
        }
        delete active[pkg]
        delete registry.failed[pkg]
      }
    }

    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))
  }

  const switchPreset = async (presetName) => {
    const registry = loadRegistry()
    const target = registry.presets[presetName]
    if (!target) throw new ApiError('bad-request', `预设 "${presetName}" 不存在`)

    const { candidates, bundles } = snapshot()
    const bundleSet = new Set(bundles)
    const current = mountedThirdParty(candidates)
    const currentPkgs = new Set(current.map(item => item.pkg))
    const targetPkgs = new Set(Object.keys(target))

    // Diff: remove only plugins leaving the preset; keep the rest mounted so
    // plugins that register exact webServer routes (e.g. wechat-bridge) are
    // not needlessly removed+recreated (which trips "duplicate exact route").
    for (const { pkg, entry } of current) {
      if (targetPkgs.has(pkg)) continue
      try { await entry.parent.remove(entry.options.id) } catch {}
    }

    // Settle removed routes before creating new rows.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300))

    // Do NOT blank the whole failed ledger — preserve failure records for
    // packages unrelated to this switch. `mountRow` clears a package's record
    // only when it is actually re-mounted successfully (P1-3).
    registry.activePreset = presetName
    const active = registry.presets[presetName] ?? {}

    // Create only plugins entering the preset.
    for (const pkg of Object.keys(active)) {
      if (currentPkgs.has(pkg)) continue // already mounted — leave it be
      // 0.5.0：已在官方静态层的包 → 不 create（双重挂载防线），标 superseded-by-static
      if (bundleSet.has(pkg)) {
        if (active[pkg].state !== 'superseded-by-static') active[pkg].state = 'superseded-by-static'
        continue
      }
      if (!candidates.includes(pkg)) {
        const state = manifestState(pkg)
        recordFailure(registry, pkg, {
          error: state === 'unparseable' ? 'package.json 解析失败，无法挂载' : '未安装或不是可选 bundle',
          kind: state === 'unparseable' ? 'manifest-invalid' : 'not-a-bundle',
        })
        continue
      }
      try {
        await mountRow(registry, pkg, active, { preserveOnFailure: true })
      } catch (err) {
        recordMountFailure(registry, pkg, err)
      }
    }

    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))
  }

  /**
   * Save the current mount table as a named preset. When `draft` (the client's
   * uncommitted switch state, pkg -> bool) is provided, it is MERGED into the
   * snapshot WITHOUT applying it (0.4.2): `true` keeps/creates the row, `false`
   * removes it. This makes「勾选 → 保存预设」one step — the preset records the
   * desired combination, no need to「保存并刷新」first. `draft` undefined/null
   * keeps the old behavior (snapshot of the committed table only).
   */
  const savePreset = (presetName, draft) => {
    const registry = loadRegistry()
    const active = registry.presets[registry.activePreset] ?? {}
    const base = JSON.parse(JSON.stringify(active))
    if (draft !== undefined && draft !== null) {
      if (typeof draft !== 'object' || Array.isArray(draft)) {
        throw new ApiError('bad-request', '"draft" 须为对象（pkg → boolean）')
      }
      for (const [pkg, on] of Object.entries(draft)) {
        if (PROTO_KEYS.has(pkg)) continue
        if (on === true) { if (!base[pkg]) base[pkg] = { config: null, state: 'managed-by-bm' } }
        else delete base[pkg]
      }
    }
    const isNew = registry.presets[presetName] === undefined
    registry.presets[presetName] = base
    // 0.4.4：保存「新」预设 → 自动设为当前激活——后续「保存并刷新」应用的就是
    // 刚保存的预设（消除「保存了预设2、保存并刷新却改了预设1」的困惑）。
    // 覆盖已有预设不切换激活（只更新记录）。
    if (isNew) registry.activePreset = presetName
    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))
    return { ok: true, activated: isNew ? presetName : null }
  }

  /** 0.4.3：删除多个预设（default 与当前激活预设已在 API 层拒绝）。 */
  const deletePresets = (names) => {
    const registry = loadRegistry()
    if (names.includes(registry.activePreset)) {
      throw new ApiError('bad-request', '当前激活预设不可删除（请先切换再删）')
    }
    for (const name of names) delete registry.presets[name]
    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))
    return { ok: true }
  }

  // ── 0.5.0 对外双轨：import / export / export-all / uninstall / rollback ──────
  // 三处落点（FUTURE-DIRECTION §2.4）：candidates 过滤 + create 过滤已在上文；
  // 这三类写 manifest 的操作是「永不写 manifest」铁律的显式例外（§1.1），
  // 全部走 §2.6 A 级安全冗余。

  /** 校验并规范化 pkg 数组（key 白名单 + 去重 + 上限）。 */
  const normalizePkgList = (list) => {
    if (!Array.isArray(list) || list.length === 0) {
      throw new ApiError('bad-request', '"pkg" 须为非空数组')
    }
    if (list.length > 64) throw new ApiError('bad-request', '一次最多处理 64 个包')
    const out = []
    const seen = new Set()
    for (const p of list) {
      if (typeof p !== 'string' || p === '' || !PKG_KEY_PATTERN.test(p)) {
        throw new ApiError('bad-request', `"${String(p)}" 不是合法的包名`)
      }
      if (seen.has(p)) continue
      seen.add(p)
      out.push(p)
    }
    return out
  }

  /**
   * 依赖组感知（提示级，不强校验，§2.6-4）：导入前查导入包 package.json 的
   * 直接 dependencies——若含「已安装、是 bundle、同批未导入」的包，提示同批
   * 导入，防「A 归 bm、X 停官方」的 DI 断裂。进程内免 spawn 的轻量启发式
   * （近似 `pnpm why <pkg>` 的直接依赖层）。
   */
  const dependencyHints = (pkgs, depsSet) => {
    const hints = []
    const importedSet = new Set(pkgs)
    for (const pkg of pkgs) {
      const pkgManifest = packageManifest(pkg).manifest
      const pkgDeps = pkgManifest?.dependencies ?? {}
      const suggest = Object.keys(pkgDeps)
        .filter(d => !isFramework(d) && depsSet.has(d)
          && isBundlePackage(d) && !importedSet.has(d))
      if (suggest.length > 0) {
        hints.push({ pkg, suggest, message: `「${pkg}」直接依赖 bundle：${suggest.join('、')}——建议同批次导入，避免 DI 断裂` })
      }
    }
    return hints
  }

  /**
   * import-to-bm（官方 → bm）：白名单校验（必须是已装 dependencies）→ 从
   * `dsh.profile.bundles` 移除 → registry 行置 enabled（预注册，重启后 boot 一定
   * 尝试 create）→ 引导重启。走 A 级冗余：写前快照 + 原子写 + 写后校验回滚。
   */
  const importToBm = (pkgs) => {
    const registry = loadRegistry()
    const { dependencies, bundles } = snapshot()
    const depsSet = new Set(dependencies)
    const bundleSet = new Set(bundles)
    const active = registry.presets[registry.activePreset] ?? {}

    const imported = []
    const rejected = []
    const nextBundles = [...bundles]
    const rowsBefore = {}
    let manifestChanged = false

    for (const pkg of pkgs) {
      if (isFramework(pkg)) {
        rejected.push({ pkg, code: 'framework-protected', message: '框架核心包不可导入/导出（硬保护）' })
        continue
      }
      if (!depsSet.has(pkg)) {
        rejected.push({ pkg, code: 'not-a-bundle', message: '未在 profile dependencies 中（未安装或已被外部移除）' })
        continue
      }
      if (!isBundlePackage(pkg)) {
        rejected.push({ pkg, code: 'not-a-bundle', message: '非可选 bundle（package.json 无 dsh.bundle 声明）' })
        continue
      }
      // 记录写入前 registry 行（快照用：null = 之前没有行）
      rowsBefore[pkg] = active[pkg] ? JSON.parse(JSON.stringify(active[pkg])) : null
      if (bundleSet.has(pkg)) {
        const idx = nextBundles.indexOf(pkg)
        if (idx >= 0) nextBundles.splice(idx, 1)
        manifestChanged = true
      }
      imported.push(pkg)
    }

    if (imported.length === 0) {
      return { imported: [], rejected, needsRestart: false, snapshotId: null, hints: [] }
    }

    // A 级冗余 3：写前快照（被改 manifest 片段 + 受影响行前状态）——供一键回滚
    const snapshotId = manifestChanged ? createImportSnapshot(bundles, rowsBefore, imported).id : null

    // A 级冗余 1：先原子写 manifest（跳过则 mutate），失败即抛（未 mutate，快照作废）
    if (manifestChanged) writeManifestBundles(nextBundles)

    // A 级冗余 2：预注册 + 失败可见——置 enabled 行（bundles → pending-import 待重启接管；
    // 已是 deps-only → managed-by-bm 立即接管）
    for (const pkg of imported) {
      const wasInBundles = bundleSet.has(pkg)
      active[pkg] = { config: active[pkg]?.config ?? null, state: wasInBundles ? 'pending-import' : 'managed-by-bm' }
      delete registry.failed[pkg]
    }

    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))

    const hints = dependencyHints(imported, depsSet)
    return { imported, rejected, needsRestart: manifestChanged, snapshotId, hints }
  }

  /**
   * export-to-bundles（bm → 官方固化）：加进 `dsh.profile.bundles` → registry 行
   * 标 `superseded-by-static` → 引导重启（永久随 dsh 启动）。
   */
  const exportToBundles = (pkgs) => {
    const registry = loadRegistry()
    const { bundles } = snapshot()
    const active = registry.presets[registry.activePreset] ?? {}
    const nextBundles = [...bundles]
    const exported = []
    const rejected = []
    let manifestChanged = false

    for (const pkg of pkgs) {
      if (isFramework(pkg)) {
        rejected.push({ pkg, code: 'framework-protected', message: '框架核心包不可导出（硬保护）' })
        continue
      }
      if (!(pkg in active)) {
        rejected.push({ pkg, code: 'not-managed', message: '该包不是 bm 托管行（无可固化，请先导入）' })
        continue
      }
      if (!nextBundles.includes(pkg)) nextBundles.push(pkg)
      if (!bundles.includes(pkg)) manifestChanged = true
      exported.push(pkg)
    }

    if (exported.length === 0) return { exported: [], rejected, needsRestart: false }

    if (manifestChanged) writeManifestBundles(nextBundles)
    for (const pkg of exported) active[pkg].state = 'superseded-by-static'
    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))

    return { exported, rejected, needsRestart: manifestChanged }
  }

  /**
   * export-all-to-bundles（§2.5 卸载安全网）：批量把全部托管写回官方静态层 ——
   * 随后用户 `dsh plugin remove dsh-bundle-manager` 可全身而退、功能不丢。
   */
  const exportAllToBundles = () => {
    const registry = loadRegistry()
    const { bundles } = snapshot()
    const active = registry.presets[registry.activePreset] ?? {}
    const nextBundles = [...bundles]
    const exported = []
    let manifestChanged = false

    for (const pkg of Object.keys(active)) {
      if (isFramework(pkg)) continue
      if (active[pkg].state === 'superseded-by-static') continue
      if (!nextBundles.includes(pkg)) nextBundles.push(pkg)
      if (!bundles.includes(pkg)) manifestChanged = true
      active[pkg].state = 'superseded-by-static'
      exported.push(pkg)
    }

    if (manifestChanged) writeManifestBundles(nextBundles)
    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))

    return { exported, needsRestart: manifestChanged }
  }

  /**
   * import/rollback（A 级冗余 3 的一键回滚）：写回 bundles + 还原受影响行的 registry
   * 前状态 + 引导重启。快照在 host 内存（导入需重启生效，回滚在重启前发生）。
   */
  const rollbackImport = (id) => {
    if (typeof id !== 'string' || id === '') throw new ApiError('bad-request', '"id" 须为导入快照号')
    const snap = importSnapshots.get(id)
    if (snap === undefined) {
      throw new ApiError('not-found', '导入快照不存在或已过期（可能已重启）')
    }
    writeManifestBundles(snap.bundlesBefore)
    const registry = loadRegistry()
    for (const [pkg, rowOrNull] of Object.entries(snap.rowsBefore)) {
      if (rowOrNull === null) {
        for (const table of Object.values(registry.presets)) delete table[pkg]
        delete registry.failed[pkg]
      } else {
        for (const table of Object.values(registry.presets)) {
          table[pkg] = JSON.parse(JSON.stringify(rowOrNull))
        }
      }
    }
    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))
    importSnapshots.delete(id)
    return { ok: true, rolledBack: Object.keys(snap.rowsBefore), needsRestart: true }
  }

  /**
   * uninstall（§1.2 卸载半边）：**先 bm 出库**（清 registry 行，batch，只动 bm 自有
   * 文件，不碰 manifest）→ **引导**官方 `dsh plugin remove pkg...`（官方透传 pnpm、
   * 支持批量、reconcile 自动收 bundles）。顺序论证：先出库后 remove——官方失败退化
   * 成 dormant dependency（可逆：registry 行写回 enabled 即恢复管理）；反向会复现
   * registry 悬空。
   *
   * 官方 remove 不在此进程内自动 spawn：进程内跑 pnpm / dsh plugin remove 会动共享
   * `profiles\node_modules` 并可能杀死运行中的实例（全局 HANDOFF §5 纪律⑦），风险
   * > 收益；故返回确切命令 + 引导用户手动执行。
   */
  const uninstall = (pkgs) => {
    const registry = loadRegistry()
    const { bundles } = snapshot()
    const bundleSet = new Set(bundles)
    const active = registry.presets[registry.activePreset] ?? {}
    const cleared = []
    const rejected = []
    const dormant = []

    for (const pkg of pkgs) {
      if (isFramework(pkg)) {
        rejected.push({ pkg, code: 'framework-protected', message: '框架核心包不可卸载（硬保护）' })
        continue
      }
      const wasManaged = pkg in active
      const wasInBundles = bundleSet.has(pkg)
      // bm 出库：清 registry 行（激活表 + 所有预设 + failed 账本）
      for (const table of Object.values(registry.presets)) delete table[pkg]
      delete registry.failed[pkg]
      cleared.push(pkg)
      // 曾是 bm 托管、且非静态层 → 出库后成为 dormant dependency（官方 remove 前）
      if (wasManaged && !wasInBundles) dormant.push(pkg)
    }

    enforceCaps(registry)
    assertStorageWriteOk(saveRegistry(registry))

    const command = cleared.length > 0
      ? `dsh plugin --profile ${PROFILE_NAME} remove ${cleared.join(' ')}`
      : ''
    return {
      uninstalled: cleared,
      rejected,
      dormant,
      needsRestart: cleared.some(pkg => bundleSet.has(pkg)),
      command,
      guide: cleared.length > 0
        ? `bm 出库已生效（registry 行已清）。请手动执行官方命令完成物理卸载：${command}（官方透传 pnpm、支持批量，reconcile 自动收 bundles）。若官方命令失败，包退化为 dormant dependency——在设置页重新勾选该插件（写回 registry 行）即可恢复管理。`
        : '无可卸载的包。',
    }
  }

  const api = {
    list: () => {
      const registry = loadRegistry()
      const { candidates, bundles, broken } = snapshot()
      const bundleSet = new Set(bundles)
      const active = registry.presets[registry.activePreset] ?? {}

      // visible universe = candidates ∪ registry-row pkgs（非框架）∪ broken——
      // 涵盖 normal toggleable 候选 + superseded-by-static / pending-import 只读行。
      const visible = new Set(candidates)
      for (const pkg of Object.keys(active)) {
        if (!isFramework(pkg)) visible.add(pkg)
      }
      for (const pkg of broken) visible.add(pkg)

      const failedMap = { ...(registry.failed ?? {}) }
      const mountedMap = new Map()
      for (const entry of loaderEntries()) {
        const pkg = entry.options?.name
        if (typeof pkg !== 'string' || !visible.has(pkg) || isFramework(pkg)) continue
        const state = fiberStateOf(entry)
        if (state === 'failed') {
          failedMap[pkg] = {
            ...(failedMap[pkg] ?? {}),
            error: errorMessage(inspectFiber(entry).error),
            kind: failedMap[pkg]?.kind ?? 'activate-failed',
          }
        } else {
          mountedMap.set(pkg, { entry, state })
        }
      }

      const rows = []
      const seen = new Set()
      const addRow = (row) => { if (!seen.has(row.pkg)) { seen.add(row.pkg); rows.push(row) } }
      const regStateOf = (pkg) => {
        const rec = active[pkg]
        return (rec && typeof rec.state === 'string' && ROW_STATES.has(rec.state)) ? rec.state : 'managed-by-bm'
      }

      // 1) registry-row pkgs 已固化/待接管（不在 toggleable 候选内）→ 只读展示
      for (const [pkg, rec] of Object.entries(active)) {
        if (isFramework(pkg)) continue
        const regState = (rec && ROW_STATES.has(rec.state)) ? rec.state : 'managed-by-bm'
        if (regState !== 'superseded-by-static' && regState !== 'pending-import') continue
        if (candidates.includes(pkg)) continue // 候选中由下方普通行承载
        const mounted = mountedMap.get(pkg)
        addRow({
          pkg,
          version: readVersion(pkg),
          mounted: mounted !== undefined,
          state: regState,
          regState,
          error: null,
          managed: mounted !== undefined ? isManagedId(mounted.entry.id) : false,
          waitingFor: [],
        })
      }

      // 2) 可管理候选（toggleable）——含其 registry 状态
      for (const pkg of candidates) {
        const regState = regStateOf(pkg)
        const mounted = mountedMap.get(pkg)
        if (mounted !== undefined) {
          const waiting = (mounted.state === 'pending' || mounted.state === 'loading')
            ? waitingForOf(mounted.entry)
            : []
          addRow({
            pkg,
            version: readVersion(pkg),
            mounted: true,
            state: mounted.state,
            regState,
            error: null,
            managed: isManagedId(mounted.entry.id),
            waitingFor: waiting,
          })
        } else {
          const failed = failedMap[pkg]
          if (failed !== undefined) {
            addRow({
              pkg,
              version: readVersion(pkg),
              mounted: false,
              state: 'failed',
              regState,
              error: typeof failed.error === 'string' ? failed.error : '未知错误',
              kind: typeof failed.kind === 'string' && FAILED_KINDS.has(failed.kind) ? failed.kind : 'unknown',
              attempts: typeof failed.attempts === 'number' ? failed.attempts : 1,
              managed: false,
              waitingFor: [],
            })
          } else {
            addRow({
              pkg,
              version: readVersion(pkg),
              mounted: false,
              state: 'unmounted',
              regState,
              error: null,
              managed: false,
              waitingFor: [],
            })
          }
        }
      }

      // 3) Broken-manifest packages stay visible but untoggleable (W4).
      for (const pkg of broken) {
        addRow({
          pkg,
          version: '未知',
          mounted: false,
          state: 'broken-manifest',
          regState: null,
          error: 'package.json 解析失败，无法判定是否为可选插件',
          managed: false,
          waitingFor: [],
        })
      }

      return {
        profile: PROFILE_NAME,
        version: PLUGIN_VERSION,
        activePreset: registry.activePreset ?? 'default',
        presets: Object.keys(registry.presets ?? {}),
        // 0.5.0：官方静态层（只读展示，供「官方共存 / 双轨」UI 用）
        bundles,
        storage: {
          path: REGISTRY_LAYOUT.primary,
          mode: REGISTRY_LAYOUT.mode,
          writable: lastStorageError === null,
          lastError: lastStorageError,
        },
        plugins: rows,
      }
    },

    apply: async (payload) => {
      const entries = payload?.entries
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
        throw new ApiError('bad-request', 'missing or invalid "entries"')
      }
      await runMutation(() => applyMountTable(entries))
      return { ok: true }
    },

    'preset/switch': async (payload) => {
      const presetName = requireString(payload, 'name')
      if (!PRESET_NAME_PATTERN.test(presetName)) {
        throw new ApiError('bad-request', '预设名须为 1-32 位字母、数字、下划线或连字符')
      }
      await runMutation(() => switchPreset(presetName))
      return { ok: true }
    },

    'preset/save': async (payload) => {
      const presetName = requireString(payload, 'name')
      if (!PRESET_NAME_PATTERN.test(presetName)) {
        throw new ApiError('bad-request', '预设名须为 1-32 位字母、数字、下划线或连字符')
      }
      // 0.4.2：draft（客户端未提交勾选表）可选——合并进快照，不实际应用
      const draft = payload?.draft
      return await runMutation(() => savePreset(presetName, draft))
    },

    'preset/delete': async (payload) => {
      const names = payload?.names
      if (!Array.isArray(names) || names.length === 0) {
        throw new ApiError('bad-request', '"names" 须为非空数组')
      }
      if (names.length > MAX_PRESETS) {
        throw new ApiError('bad-request', `一次最多删除 ${MAX_PRESETS} 个预设`)
      }
      for (const n of names) {
        if (typeof n !== 'string' || !PRESET_NAME_PATTERN.test(n)) {
          throw new ApiError('bad-request', '预设名含非法字符')
        }
        // default 恒存在（播种/回退），不可删
        if (n === 'default') throw new ApiError('bad-request', '默认预设不可删除')
      }
      return await runMutation(() => deletePresets(names))
    },

    // 0.5.0 对外双轨 / 卸载半边
    'import-to-bm': async (payload) => {
      const pkgs = normalizePkgList(payload?.pkg)
      return await runMutation(() => importToBm(pkgs))
    },
    'export-to-bundles': async (payload) => {
      const pkgs = normalizePkgList(payload?.pkg)
      return await runMutation(() => exportToBundles(pkgs))
    },
    'export-all-to-bundles': async () => {
      return await runMutation(() => exportAllToBundles())
    },
    'import/rollback': async (payload) => {
      const id = payload?.id
      return await runMutation(() => rollbackImport(id))
    },
    uninstall: async (payload) => {
      const pkgs = normalizePkgList(payload?.pkg)
      return await runMutation(() => uninstall(pkgs))
    },
  }

  // Boot-time remount, AWAITED so the ON plugins are created (and their client
  // halves composed into __DSH_BOOT__) BEFORE the Loader tree settles and the
  // `dsh web:` readiness line prints (P8). The whole body is try/catch'd so
  // this plugin's fiber can never fail-loud the profile (W9). Disposer removes
  // every row this plugin created.
  await ctx.effect(async () => {
    try {
      await reconcileAtBoot()
    } catch (err) {
      console.error(`[dsh-bundle-manager] boot reconcile failed (plugin stays active): ${err?.stack ?? err}`)
    }
    return async () => {
      for (const entry of [...ctx.loader.entries()].reverse()) {
        if (isManagedId(entry.id)) {
          try { await entry.parent.remove(entry.options.id) } catch {}
        }
      }
    }
  }, 'dsh-bundle-manager: mount registry entries')

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (!fence(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${API_PREFIX}/`)
            ? pathname.slice(`${API_PREFIX}/`.length)
            : undefined
          if (method === undefined || method === '') {
            writeError(res, new ApiError('not-found', `unknown plugin-manager API method "${String(method)}"`, 404))
            return
          }
          try {
            const payload = await readJsonBody(req)
            const handler = api[method]
            if (handler === undefined) {
              throw new ApiError('not-found', `unknown plugin-manager API method "${method}"`, 404)
            }
            const value = await handler(payload)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, value }))
          } catch (error) {
            writeError(res, error)
          }
        },
      })
    } catch (err) {
      console.error(`[dsh-bundle-manager] route registration failed: ${err?.stack ?? err}`)
      return undefined
    }
  }, 'dsh-bundle-manager: /bundle-manager/api routes')
}
