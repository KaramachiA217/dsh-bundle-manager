/**
 * dsh-bundle-manager host half (v0.3).
 *
 * Runtime mount manager for optional third-party plugin bundles. It keeps a
 * self-owned "mount table" (a registry.json — NOT the profile manifest, NOT
 * the shared settings.yaml) and reconciles it against the in-memory Loader
 * tree through the runtime Loader API (create/remove). Mounting/unmounting a
 * plugin is instant and never rewrites `dsh.profile.bundles`, never touches
 * `.dsh/profiles/<name>/package.json`, and never restarts dsh.
 *
 * Design (see HANDOFF.md, HANDOFF-v0.3.md):
 * - inject: ['webServer', 'loader'] — the fenced JSON route and the Loader.
 * - The registry records `presets[activePreset]` = the desired mount table
 *   (pkg -> { config }), plus a `failed` ledger for mount attempts that threw.
 * - On boot the plugin reconciles SYNCHRONOUSLY (awaited in apply, P8) so the
 *   ON plugins are created (and their client halves composed into
 *   __DSH_BOOT__) BEFORE the `dsh web:` readiness line prints. It removes
 *   boot-mounted third-party entries that the registry marks OFF and creates
 *   the ON ones that are not yet in the tree (each independently try/catch).
 * - The client reaches this plugin through the fenced /plugin-manager/api
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
        table[pkg] = { config }
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
 * dependencies OR the node_modules scan — that are not framework), and
 * `broken` (declared dependencies whose package.json cannot be parsed).
 */
function snapshot() {
  const manifest = profileManifest() ?? {}
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const candidates = discoverCandidates(dependencies)
  const broken = dependencies.filter(pkg => !isFramework(pkg) && manifestState(pkg) === 'unparseable')
  return { dependencies, bundles, candidates, broken }
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
    const outcome = await mountWithWatchdog(options)
    if (outcome.status === 'created') {
      activeTable[pkg] = { config: config ?? null }
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
    // timeout ≠ 失败：fiber 可能仍在启动；删表行会造成「树里有行、表里无行」
    // 分叉（list 显示已挂载、重启后被 reconcile 当表外挂载移除 = 用户「开了
    // 却没了」）。保留后由 fiber 实际状态校正（apply 的 isFailed 分支重建 /
    // 重启 reconcile 跳过已挂载）。
    activeTable[pkg] = { config: config ?? null }
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
    const { candidates } = snapshot()

    const mountedThird = mountedThirdParty(candidates)
    const active = registry.presets[registry.activePreset] ?? {}

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
        active[pkg] = { config: null }
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
    // 表内 ON 但非候选（未安装 / 坏清单）→ 进账本（可见，不静默）——与旧串行语义一致
    for (const pkg of Object.keys(active)) {
      if (candidates.includes(pkg)) continue
      const state = manifestState(pkg)
      recordFailure(registry, pkg, {
        error: state === 'unparseable' ? 'package.json 解析失败，无法挂载' : '未安装或不是可选 bundle（已从挂载表跳过）',
        kind: state === 'unparseable' ? 'manifest-invalid' : 'not-a-bundle',
      })
    }
    const bootTargets = Object.keys(active)
      .filter(pkg => candidates.includes(pkg) && findEntryByPkg(pkg) === undefined)
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
    const { candidates } = snapshot()
    const candidateSet = new Set(candidates)

    // Validate the whole table up front (fail-fast — no partial apply).
    for (const [pkg, desiredOn] of Object.entries(desired)) {
      if (isFramework(pkg)) {
        throw new ApiError('framework-protected', `"${pkg}" 是框架核心包，禁止运行时切换`)
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
          active[pkg] = { config: active[pkg]?.config ?? null }
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

    const { candidates } = snapshot()
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
        if (on === true) { if (!base[pkg]) base[pkg] = { config: null } }
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

  const api = {
    list: () => {
      const registry = loadRegistry()
      const { candidates, broken } = snapshot()

      const failedMap = { ...(registry.failed ?? {}) }
      const mountedMap = new Map()
      for (const { pkg, entry, state } of mountedThirdParty(candidates)) {
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

      // One unified row per candidate: the client renders a single switch list.
      const plugins = candidates.map(pkg => {
        const mounted = mountedMap.get(pkg)
        if (mounted !== undefined) {
          const waiting = (mounted.state === 'pending' || mounted.state === 'loading')
            ? waitingForOf(mounted.entry)
            : []
          return {
            pkg,
            version: readVersion(pkg),
            mounted: true,
            state: mounted.state,
            error: null,
            managed: isManagedId(mounted.entry.id),
            waitingFor: waiting,
          }
        }
        const failed = failedMap[pkg]
        if (failed !== undefined) {
          return {
            pkg,
            version: readVersion(pkg),
            mounted: false,
            state: 'failed',
            error: typeof failed.error === 'string' ? failed.error : '未知错误',
            kind: typeof failed.kind === 'string' && FAILED_KINDS.has(failed.kind) ? failed.kind : 'unknown',
            attempts: typeof failed.attempts === 'number' ? failed.attempts : 1,
            managed: false,
            waitingFor: [],
          }
        }
        return {
          pkg,
          version: readVersion(pkg),
          mounted: false,
          state: 'unmounted',
          error: null,
          managed: false,
          waitingFor: [],
        }
      })

      // Broken-manifest packages stay visible but untoggleable (W4).
      for (const pkg of broken) {
        plugins.push({
          pkg,
          version: '未知',
          mounted: false,
          state: 'broken-manifest',
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
        storage: {
          path: REGISTRY_LAYOUT.primary,
          mode: REGISTRY_LAYOUT.mode,
          writable: lastStorageError === null,
          lastError: lastStorageError,
        },
        plugins,
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
