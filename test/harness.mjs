/**
 * test/harness.mjs — deterministic offline tests for the dsh-bundle-manager
 * host half (v0.3 hardening).
 *
 * Strategy: copy lib/index.js + package.json into a per-case scratch tree,
 * point DSH_HOME / DSH_PROFILE / DSH_BUNDLE_MANAGER_HOME at scratch paths,
 * import a FRESH module instance (unique query suffix defeats the ESM cache),
 * then drive the plugin's own fenced /bundle-manager/api handlers through a
 * mocked Cordis ctx. No real dsh, no network, no side effects outside
 * `test/.scratch/`.
 *
 * Run:  node test/harness.mjs
 * Exit code 1 on any failure. `test/.scratch/` is wiped on start and end.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(dirname(HERE))
const SCRATCH = join(HERE, '.scratch')

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) {
    passed += 1
    console.log('  ok  -', label)
  } else {
    failed += 1
    console.error('  FAIL-', label)
  }
}

/** Recursive delete, hard-guarded to stay under test/.scratch/. */
function wipeScratch() {
  const target = resolve(SCRATCH)
  if (!target.startsWith(resolve(join(HERE, '.scratch')))) {
    throw new Error('unsafe delete target: ' + target)
  }
  rmSync(target, { recursive: true, force: true })
}

// ── Mock ctx ─────────────────────────────────────────────────────────────────

/**
 * Mock Cordis ctx: an in-memory loader entry map, a webServer.register that
 * captures the route options, and an effect() that runs the callback
 * immediately. `createBehavior` controls loader.create:
 *   'ok' (default) | 'hang' (never settles) | 'throw:<message>' | Error instance
 *   | fn(options, callCount) — per-package call counting (0.3.1 boot group tests)
 */
function makeCtx(createBehavior = 'ok') {
  const entries = new Map() // bareId -> entry
  const ctx = {
    capturedRoute: null,
    createCounts: {},
    webServer: {
      register: (options) => {
        ctx.capturedRoute = options
        return () => {}
      },
    },
    loader: {
      entries() {
        return (function* entriesGen() {
          for (const entry of entries.values()) yield entry
        })()
      },
      create: async (options) => {
        if (createBehavior === 'hang') {
          return await new Promise(() => {}) // never settles — watchdog path
        }
        if (typeof createBehavior === 'function') {
          const count = (ctx.createCounts[options.name] = (ctx.createCounts[options.name] ?? 0) + 1)
          const decision = createBehavior(options, count)
          if (decision === 'hang') return await new Promise(() => {})
          if (decision instanceof Error) throw decision
          if (typeof decision === 'string' && decision.startsWith('throw:')) {
            throw new Error(decision.slice('throw:'.length))
          }
          // fall through to normal creation
        } else if (createBehavior instanceof Error) {
          throw createBehavior
        } else if (typeof createBehavior === 'string' && createBehavior.startsWith('throw:')) {
          throw new Error(createBehavior.slice('throw:'.length))
        }
        const entry = ctx.makeEntry(options.name, options.id, options.id, options.config)
        entries.set(options.id, entry)
        return options.id
      },
    },
    effect: (fn) => {
      const result = fn()
      return result && typeof result.then === 'function' ? result : (result ?? (() => {}))
    },
    makeEntry(name, bareId, fullId, config) {
      const entry = {
        options: { id: bareId, name, config },
        id: fullId ?? bareId,
        fiber: { state: 2, _error: null, inject: {}, ctx: null },
        parent: {
          remove: async (id) => {
            entries.delete(id)
            return true
          },
        },
      }
      return entry
    },
    /** Seed boot-mounted third-party entries (nested, id `include:<pkg>`). */
    bootEntries(list) {
      for (const pkg of list) {
        const entry = ctx.makeEntry(pkg, pkg, `include:${pkg}`, undefined)
        entries.set(pkg, entry)
      }
    },
  }
  return ctx
}

// ── HTTP mock ────────────────────────────────────────────────────────────────

function makeReq(bodyText) {
  return {
    method: 'POST',
    url: undefined, // filled per call
    headers: { host: '127.0.0.1:9999' },
    [Symbol.asyncIterator]: async function* bodyGen() {
      if (bodyText !== undefined) yield Buffer.from(bodyText, 'utf8')
    },
  }
}

function makeRes() {
  const res = { status: 0, headers: {}, body: '', json: null }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (chunk) => {
    res.body = String(chunk)
    try {
      res.json = JSON.parse(res.body)
    } catch {
      res.json = null
    }
  }
  return res
}

async function callApi(ctx, method, body) {
  const res = makeRes()
  const req = makeReq(body === undefined ? '{}' : JSON.stringify(body))
  req.url = `/bundle-manager/api/${method}`
  await ctx.capturedRoute.handler(req, res)
  return res
}

// ── Scratch layout helpers ───────────────────────────────────────────────────

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/** Valid candidate bundle manifest. */
function goodManifest(version = '1.0.0') {
  return {
    name: 'dsh-good',
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
}

function profileManifest(deps, bundles) {
  return {
    name: 'dsh-profile-pmtest',
    private: true,
    dependencies: deps,
    dsh: {
      profile: {
        bundles: bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-bundle-manager'],
      },
    },
  }
}

/** Build one case's scratch tree; returns its paths. */
function buildCase(name) {
  const root = join(SCRATCH, name)
  mkdirSync(root, { recursive: true })
  const pkgDir = join(root, 'pkg')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  const sourceLib = join(REPO, 'lib', 'index.js')
  writeFileSync(join(pkgDir, 'lib', 'index.js'), readFileSync(sourceLib, 'utf8'), 'utf8')
  writeFileSync(join(pkgDir, 'package.json'), readFileSync(join(REPO, 'package.json'), 'utf8'), 'utf8')
  const dshHome = join(root, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'pmtest')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  const shellHome = join(root, 'shell-home')
  mkdirSync(shellHome, { recursive: true })
  return { root, pkgDir, dshHome, profileDir, shellHome }
}

/** Install a fake package into the scratch profile's node_modules. */
function installFake(profileDir, pkgName, packageJsonText) {
  const dir = join(profileDir, 'node_modules', ...pkgName.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), packageJsonText, 'utf8')
}

/**
 * Import a fresh module instance for one case.
 * Returns { apply, ctx } after running apply(ctx) so the boot reconcile and
 * route registration have already happened.
 */
async function bootCase({ name, dshHome, profileDir, pkgDir, shellHome, env, ctx, profileDeps, profileBundles }) {
  // profile manifest
  writeJson(join(profileDir, 'package.json'), profileManifest(profileDeps ?? {}, profileBundles))
  // env for THIS module instance
  process.env.DSH_HOME = dshHome
  process.env.DSH_PROFILE = 'pmtest'
  if (env?.pluginManagerHome === null) {
    delete process.env.DSH_BUNDLE_MANAGER_HOME
  } else if (env?.pluginManagerHome !== undefined) {
    process.env.DSH_BUNDLE_MANAGER_HOME = env.pluginManagerHome
  } else {
    delete process.env.DSH_BUNDLE_MANAGER_HOME
  }
  const url = pathToFileURL(join(pkgDir, 'lib', 'index.js')).href + `?case=${encodeURIComponent(name)}`
  const mod = await import(url)
  await mod.apply(ctx)
  return mod
}

// ── Cases ────────────────────────────────────────────────────────────────────

async function caseShellMigration() {
  console.log('\n[T1] shell 模式：legacy mirror 一次性迁移，mirror 只读保留')
  const { dshHome, profileDir, shellHome, pkgDir } = buildCase('t1-shell-migration')
  // legacy mirror with a mount table + failed record
  const mirror = join(profileDir, 'plugin-manager', 'registry.json')
  writeJson(mirror, {
    version: 1,
    activePreset: 'default',
    presets: { default: { 'dsh-good': { config: null } } },
    failed: { 'dsh-bad': { error: 'boom', at: 1700000000000 } },
  })
  const mirrorBefore = readFileSync(mirror, 'utf8')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  const ctx = makeCtx()
  ctx.bootEntries(['dsh-good'])
  await bootCase({
    name: 't1', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
  })
  const primary = join(shellHome, 'registry.json')
  assert(existsSync(primary), 'primary registry.json 生成于壳目录')
  assert(readFileSync(mirror, 'utf8') === mirrorBefore, 'legacy mirror 内容未被改写')
  const primaryData = JSON.parse(readFileSync(primary, 'utf8'))
  assert(primaryData.presets.default['dsh-good'] !== undefined, '挂载表（dsh-good ON）随迁移保留')
  assert(primaryData.failed['dsh-bad'] !== undefined, 'failed 账本随迁移保留')
  const res = await callApi(ctx, 'list', {})
  const value = res.json.value
  assert(value.storage.mode === 'shell', 'list.storage.mode === shell')
  assert(value.storage.path === primary, 'list.storage.path === 壳目录 registry.json')
  const good = value.plugins.find(p => p.pkg === 'dsh-good')
  assert(good && good.mounted === true && good.state === 'active', 'dsh-good 保持挂载（未被误卸）')
  assert(value.plugins.every(p => p.state !== 'failed'), '迁移后无失败行')
}

async function caseCorruptPrimaryBakRecovery() {
  console.log('\n[T2] 坏 primary → 隔离 .corrupt-*，从 .bak 恢复（generic 双写）')
  const root = join(SCRATCH, 't2-corrupt')
  const { pkgDir, dshHome, profileDir } = buildCase('t2-corrupt')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  // corrupt primary + valid bak
  writeFileSync(join(pkgDir, 'registry.json'), '{ not json !!!', 'utf8')
  writeJson(join(pkgDir, 'registry.json.bak'), {
    version: 1,
    activePreset: 'default',
    presets: { default: { 'dsh-good': { config: null } } },
    failed: {},
  })
  const ctx = makeCtx()
  await bootCase({
    name: 't2', dshHome, profileDir, pkgDir, shellHome: join(root, 'shell-home'),
    env: { pluginManagerHome: null }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
  })
  const corrupts = readdirSync(pkgDir).filter(f => f.startsWith('registry.json.corrupt-'))
  assert(corrupts.length === 1, '坏 primary 被改名 .corrupt-*（不覆盖不丢弃）')
  const recovered = JSON.parse(readFileSync(join(pkgDir, 'registry.json'), 'utf8'))
  assert(recovered.presets.default['dsh-good'] !== undefined, '从 .bak 恢复挂载表（未全卸载）')
  assert(existsSync(join(profileDir, 'bundle-manager', 'registry.json')), 'generic 模式 mirror 双写（bundle-manager/ 布局）')
  const res = await callApi(ctx, 'list', {})
  assert(res.json.value.storage.mode === 'generic', 'list.storage.mode === generic')
}

async function caseSeedEmptyRegistry() {
  console.log('\n[T3] 存在但空表 + boot 已挂第三方 → 播种全 ON，不卸载')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t3-seed-empty')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  // registry EXISTS but the active preset table is empty (W3 regression case)
  writeJson(join(shellHome, 'registry.json'), {
    version: 1,
    activePreset: 'default',
    presets: { default: {} },
    failed: {},
  })
  const ctx = makeCtx()
  ctx.bootEntries(['dsh-good'])
  await bootCase({
    name: 't3', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
  })
  const data = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(data.presets.default['dsh-good'] !== undefined, '空表被播种为 dsh-good ON')
  const res = await callApi(ctx, 'list', {})
  const good = res.json.value.plugins.find(p => p.pkg === 'dsh-good')
  assert(good && good.mounted === true, 'boot 挂载的 dsh-good 仍在树中（未被卸载）')
}

async function caseBrokenManifest() {
  console.log('\n[T4] 坏 package.json 依赖 → broken-manifest 行可见且不可 toggle')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t4-broken-manifest')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  installFake(profileDir, 'dsh-broken', '{ "name": "dsh-broken", "version": "1.0.0", }') // invalid JSON
  const ctx = makeCtx()
  await bootCase({
    name: 't4', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx,
    profileDeps: { 'dsh-good': '1.0.0', 'dsh-broken': '1.0.0' },
  })
  const res = await callApi(ctx, 'list', {})
  const broken = res.json.value.plugins.find(p => p.pkg === 'dsh-broken')
  assert(broken !== undefined, '坏清单包出现在列表（不再消失）')
  assert(broken && broken.state === 'broken-manifest', 'state === broken-manifest')
  assert(broken && typeof broken.error === 'string' && broken.error.includes('解析失败'), '带解析失败文案')
  const apply = await callApi(ctx, 'apply', { entries: { 'dsh-broken': true } })
  assert(apply.json.ok === false && apply.json.error?.code === 'bad-request', 'ON 坏清单包被拒绝（bad-request）')
}

async function caseWatchdogTimeout() {
  console.log('\n[T5] 挂载看门狗：apply 永不 settle → 20s 超时进 failed(pending-timeout)（需 ~20s）')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t5-watchdog')
  installFake(profileDir, 'dsh-hang', JSON.stringify(goodManifest()))
  const ctx = makeCtx('hang')
  await bootCase({
    name: 't5', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: { 'dsh-hang': '1.0.0' },
  })
  const started = Date.now()
  const apply = await callApi(ctx, 'apply', { entries: { 'dsh-hang': true } })
  const elapsed = Date.now() - started
  assert(apply.json.ok === true, '超时后响应照常返回 ok（HTTP 不挂死）')
  assert(elapsed >= 19000 && elapsed < 30000, `耗时 ${elapsed}ms ≈ 20s 看门狗`)
  const res = await callApi(ctx, 'list', {})
  const hang = res.json.value.plugins.find(p => p.pkg === 'dsh-hang')
  assert(hang && hang.state === 'failed', 'list 显示 failed')
  assert(hang && hang.kind === 'pending-timeout', 'kind === pending-timeout')
  assert(hang && hang.attempts === 1, 'attempts === 1')
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg.failed['dsh-hang']?.kind === 'pending-timeout', '账本持久化 pending-timeout')
  // P1-B（0.3.1）：超时后表行保留（timeout ≠ 失败；fiber 可能仍在启动）——
  // 树/表不再分叉，重启后 reconcile 不会把「用户已开启」的插件当表外挂载移除
  assert(reg.presets?.default?.['dsh-hang'] !== undefined, 'apply 超时后表行保留（不再删行）')
  // attempts===1 同时证明 timeout 型在 boot/apply 路径均不被单飞重试
}

async function caseStorageError() {
  console.log('\n[T6] 写盘失败 → storage-error 响应 + list.storage 告警')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t6-storage-error')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  // make the registry dir impossible: DSH_BUNDLE_MANAGER_HOME points INSIDE a file
  writeFileSync(join(shellHome, 'blocker.txt'), 'file, not dir', 'utf8')
  const badHome = join(shellHome, 'blocker.txt')
  const ctx = makeCtx()
  await bootCase({
    name: 't6', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: badHome }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
  })
  const apply = await callApi(ctx, 'apply', { entries: { 'dsh-good': true } })
  assert(apply.json.ok === false && apply.json.error?.code === 'storage-error', 'apply 返回 storage-error（不再静默）')
  const res = await callApi(ctx, 'list', {})
  assert(res.json.value.storage.writable === false, 'list.storage.writable === false')
  assert(typeof res.json.value.storage.lastError === 'string', 'list.storage.lastError 有值')
  // mount itself still took effect in-memory
  const good = res.json.value.plugins.find(p => p.pkg === 'dsh-good')
  assert(good && good.mounted === true, '挂载本身已在内存生效（错误只影响持久化）')
}

async function caseFrameworkProtected() {
  console.log('\n[T7] framework 白名单拒绝 toggle')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t7-framework')
  const ctx = makeCtx()
  await bootCase({
    name: 't7', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: {},
  })
  const apply = await callApi(ctx, 'apply', { entries: { 'dsh-base': true } })
  assert(apply.json.ok === false && apply.json.error?.code === 'framework-protected', 'framework-protected 拒绝')
}

async function casePresetDiff() {
  console.log('\n[T8] 预设 diff 切换往返 + save')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t8-preset')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  const ctx = makeCtx()
  await bootCase({
    name: 't8', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
  })
  // ON
  let res = await callApi(ctx, 'apply', { entries: { 'dsh-good': true } })
  assert(res.json.ok === true, 'apply ON ok')
  // save preset 'full'（0.4.4：保存新预设 → 自动激活 full）
  res = await callApi(ctx, 'preset/save', { name: 'full' })
  assert(res.json.ok === true, 'preset/save full ok')
  assert(res.json.value?.activated === 'full', 'save full 激活 full')
  // 回到 default 再改挂载（新语义下 apply 写入当前激活；想保持快照独立需显式切换）
  res = await callApi(ctx, 'preset/switch', { name: 'default' })
  assert(res.json.ok === true, 'switch back default ok')
  // OFF
  res = await callApi(ctx, 'apply', { entries: { 'dsh-good': false } })
  assert(res.json.ok === true, 'apply OFF ok')
  // save preset 'empty'（快照 default 的 OFF 态）
  res = await callApi(ctx, 'preset/save', { name: 'empty' })
  assert(res.json.ok === true, 'preset/save empty ok')
  // switch full -> empty -> full, expect 0 failed and correct mount states
  res = await callApi(ctx, 'preset/switch', { name: 'full' })
  assert(res.json.ok === true, 'switch → full ok')
  let value = (await callApi(ctx, 'list', {})).json.value
  assert(value.activePreset === 'full', 'activePreset === full')
  assert(value.plugins.find(p => p.pkg === 'dsh-good')?.mounted === true, 'dsh-good ON in full')
  res = await callApi(ctx, 'preset/switch', { name: 'empty' })
  assert(res.json.ok === true, 'switch → empty ok')
  value = (await callApi(ctx, 'list', {})).json.value
  assert(value.activePreset === 'empty', 'activePreset === empty')
  assert(value.plugins.find(p => p.pkg === 'dsh-good')?.mounted === false, 'dsh-good OFF in empty')
  assert(value.plugins.every(p => p.state !== 'failed'), '往返 0 failed（P6 回归）')
}

async function caseInvalidEnv() {
  console.log('\n[T9] 非法 DSH_BUNDLE_MANAGER_HOME → 告警并回退 generic')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t9-invalid-env')
  const ctx = makeCtx()
  await bootCase({
    name: 't9', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: 'relative/not/absolute' }, ctx, profileDeps: {},
  })
  const res = await callApi(ctx, 'list', {})
  assert(res.json.value.storage.mode === 'generic', '相对路径 → generic 回退')
  assert(res.json.value.storage.path === join(pkgDir, 'registry.json'), 'generic primary = 包内 registry.json')
}

async function caseGenericDualWrite() {
  console.log('\n[T10] generic 模式行为与 v0.2 一致（primary+mirror 双写）')
  const { pkgDir, dshHome, profileDir } = buildCase('t10-generic')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  const ctx = makeCtx()
  await bootCase({
    name: 't10', dshHome, profileDir, pkgDir, shellHome: join(SCRATCH, 't10-generic', 'shell-home'),
    env: { pluginManagerHome: null }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
  })
  const res = await callApi(ctx, 'apply', { entries: { 'dsh-good': true } })
  assert(res.json.ok === true, 'apply ON ok')
  assert(existsSync(join(pkgDir, 'registry.json')), 'primary（包内）已写')
  assert(existsSync(join(profileDir, 'bundle-manager', 'registry.json')), 'mirror（.dsh 下 bundle-manager/ 布局）已写')
  const mirror = JSON.parse(readFileSync(join(profileDir, 'bundle-manager', 'registry.json'), 'utf8'))
  assert(mirror.presets.default['dsh-good'] !== undefined, 'mirror 内容一致')
}

async function caseSwitchPresetKeepsFailed() {
  console.log('\n[T11] 预设切换保留无关包的 failed 账本（P1-3）')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t11-switch-keeps-failed')
  installFake(profileDir, 'dsh-bad', JSON.stringify(goodManifest()))
  const ctx = makeCtx(new Error('ERR_MODULE_NOT_FOUND: Cannot find package'))
  await bootCase({
    name: 't11', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: { 'dsh-bad': '1.0.0' },
  })
  // Mount a broken package → failed ledger records it.
  const apply = await callApi(ctx, 'apply', { entries: { 'dsh-bad': true } })
  assert(apply.json.ok === true, 'apply 正常返回（挂载失败但响应 ok）')
  // Save current (empty) table as a preset, then switch to it — the switch
  // must NOT blank the ledger (regression: `registry.failed = {}`).
  await callApi(ctx, 'preset/save', { name: 'empty' })
  const sw = await callApi(ctx, 'preset/switch', { name: 'empty' })
  assert(sw.json.ok === true, 'preset/switch ok')
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg.failed['dsh-bad'] !== undefined, '切预设后 failed 账本保留')
  assert(reg.failed['dsh-bad']?.kind === 'import-failed', '保留的账本 kind 不变')
}

async function casePresetCap() {
  console.log('\n[T12] 预设数量上限：第 65 个预设被拒（P1-2）')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t12-preset-cap')
  const ctx = makeCtx()
  await bootCase({
    name: 't12', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: {},
  })
  // default 预设恒占一位：再存 63 个 → 总计 64，第 64 个新增（p63）应被拒。
  for (let i = 0; i < 63; i += 1) {
    const res = await callApi(ctx, 'preset/save', { name: `p${String(i).padStart(2, '0')}` })
    assert(res.json.ok === true, `保存第 ${i + 1} 个预设 ok`)
  }
  const over = await callApi(ctx, 'preset/save', { name: 'p63' })
  assert(over.json.ok === false && over.json.error?.code === 'bad-request', '第 64 个新增预设（含 default 共 65）被拒')
}

async function caseBootGroupedParallel() {
  console.log('\n[T13] boot 分组并行 + 单飞重试（0.3.1）：flaky 假失败被单飞救回、bad 真失败 attempts=2')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t13-boot-groups')
  for (const pkg of ['dsh-ok1', 'dsh-ok2', 'dsh-ok3', 'dsh-ok4', 'dsh-flaky', 'dsh-bad']) {
    installFake(profileDir, pkg, JSON.stringify(goodManifest()))
  }
  // 预写 registry：表内 6 个 ON、树里无行 → boot (b) 必须 create 全部 6 个
  writeJson(join(shellHome, 'registry.json'), {
    version: 1,
    activePreset: 'default',
    presets: { default: {
      'dsh-ok1': { config: null }, 'dsh-ok2': { config: null }, 'dsh-ok3': { config: null },
      'dsh-ok4': { config: null }, 'dsh-flaky': { config: null }, 'dsh-bad': { config: null },
    } },
    failed: {},
  })
  // per-package behavior: bad always throws; flaky throws only on the first
  // create (parallel pass), succeeding on the serial retry pass.
  const behavior = (options, count) => {
    if (options.name === 'dsh-bad') return new Error('boom-bad')
    if (options.name === 'dsh-flaky' && count === 1) return new Error('boom-flaky-1')
    return 'ok'
  }
  const ctx = makeCtx(behavior)
  await bootCase({
    name: 't13', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx,
    profileDeps: {
      'dsh-ok1': '1.0.0', 'dsh-ok2': '1.0.0', 'dsh-ok3': '1.0.0', 'dsh-ok4': '1.0.0',
      'dsh-flaky': '1.0.0', 'dsh-bad': '1.0.0',
    },
  })
  // 4 个正常插件：并行轮成功，create 各 1 次
  for (const pkg of ['dsh-ok1', 'dsh-ok2', 'dsh-ok3', 'dsh-ok4']) {
    assert(ctx.createCounts[pkg] === 1, `${pkg} create 1 次（并行轮成功）`)
  }
  // flaky：并行轮失败 1 次 + 单飞轮成功 1 次 = create 2 次，账本已清
  assert(ctx.createCounts['dsh-flaky'] === 2, 'flaky create 2 次（并行 1 + 单飞 1）')
  const res = await callApi(ctx, 'list', {})
  const byPkg = {}
  for (const p of res.json.value.plugins) byPkg[p.pkg] = p
  assert(byPkg['dsh-flaky'] && byPkg['dsh-flaky'].state === 'active', 'flaky 单飞成功 → active')
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg.failed['dsh-flaky'] === undefined, 'flaky 账本已清（假失败不残留）')
  // bad：并行 1 次 + 单飞 1 次 = create 2 次，真失败 attempts=2
  assert(ctx.createCounts['dsh-bad'] === 2, 'bad create 2 次（并行 1 + 单飞 1）')
  assert(byPkg['dsh-bad'] && byPkg['dsh-bad'].state === 'failed', 'bad 真失败 → failed')
  assert(byPkg['dsh-bad'] && byPkg['dsh-bad'].attempts === 2, 'bad attempts === 2（单飞确实执行过）')
  assert(reg.failed['dsh-bad']?.kind === 'activate-failed', 'bad 账本 kind=activate-failed')
}

async function caseRenameMigration() {
  console.log('\n[T14] v0.4 改名迁移：旧 dsh-plugin-manager 数据 → 新 dsh-bundle-manager primary + 旧 env 回退')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t14-rename-migration')
  // 场景 A：generic 模式——旧 mirror（profiles/<name>/plugin-manager/registry.json）有数据
  writeJson(join(profileDir, 'plugin-manager', 'registry.json'), {
    version: 1,
    activePreset: 'default',
    presets: { default: { 'dsh-good': { config: null } } },
    failed: {},
  })
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  const ctx = makeCtx()
  await bootCase({
    name: 't14a', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: null }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
  })
  const newPrimary = join(pkgDir, 'registry.json')
  assert(existsSync(newPrimary), 'generic 改名迁移写新 primary（新包目录）')
  const data = JSON.parse(readFileSync(newPrimary, 'utf8'))
  assert(data.presets?.default?.['dsh-good'] !== undefined, '旧挂载表随迁移保留')
  assert(readFileSync(join(profileDir, 'plugin-manager', 'registry.json'), 'utf8').includes('dsh-good'), '旧 mirror 只读保留')
  const listA = await callApi(ctx, 'list', {})
  assert(listA.json.value.plugins.find(p => p.pkg === 'dsh-good')?.state === 'active', '迁移后 dsh-good 已挂载 active')

  // 场景 B：旧 env DSH_PLUGIN_MANAGER_HOME 只读回退 → shell 模式仍生效
  const shellHome2 = join(dshHome, '..', 'shell2')
  mkdirSync(shellHome2, { recursive: true })
  process.env.DSH_PLUGIN_MANAGER_HOME = shellHome2
  try {
    const ctx2 = makeCtx()
    await bootCase({
      name: 't14b', dshHome, profileDir, pkgDir, shellHome,
      env: { pluginManagerHome: null }, ctx: ctx2, profileDeps: { 'dsh-good': '1.0.0' },
    })
    // env.pluginManagerHome:null → delete DSH_BUNDLE_MANAGER_HOME；旧 env 仍在 → 回退 shell 模式
    assert(existsSync(join(shellHome2, 'registry.json')), '旧 DSH_PLUGIN_MANAGER_HOME 回退生效（shell 模式写壳目录）')
  } finally {
    delete process.env.DSH_PLUGIN_MANAGER_HOME
  }
}

async function casePresetSaveWithDraft() {
  console.log('\n[T15] preset/save 携带 draft：草稿勾选合并进预设快照（不实际应用，0.4.2）')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t15-preset-draft')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  installFake(profileDir, 'dsh-new', JSON.stringify(goodManifest()))
  const ctx = makeCtx()
  await bootCase({
    name: 't15', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx,
    profileDeps: { 'dsh-good': '1.0.0', 'dsh-new': '1.0.0' },
  })
  // 先把 dsh-good 设为已提交 ON
  const apply = await callApi(ctx, 'apply', { entries: { 'dsh-good': true } })
  assert(apply.json.ok === true, 'apply dsh-good ON ok')
  // 用户勾选草稿（未提交）：关 dsh-good、开 dsh-new
  const save = await callApi(ctx, 'preset/save', { name: 'p1', draft: { 'dsh-good': false, 'dsh-new': true } })
  assert(save.json.ok === true, 'preset/save 带 draft ok')
  assert(save.json.value?.activated === 'p1', '保存新预设返回 activated=p1')
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  const p1 = reg.presets['p1']
  assert(p1 !== undefined, 'p1 已保存')
  assert(p1['dsh-new'] !== undefined, '草稿 ON 项并入预设')
  assert(p1['dsh-good'] === undefined, '草稿 OFF 项从预设移除')
  // 0.4.4：保存新预设 → 自动激活为新名；default 表未变、挂载树未变（draft 未实际应用）
  assert(reg.activePreset === 'p1', '保存新预设 → 自动激活为 p1')
  assert(reg.presets['default']['dsh-good'] !== undefined && reg.presets['default']['dsh-new'] === undefined, 'default 表未变（草稿未实际应用）')
  const list = await callApi(ctx, 'list', {})
  assert(list.json.value.activePreset === 'p1', 'list.activePreset === p1')
  assert(list.json.value.plugins.find(p => p.pkg === 'dsh-good')?.mounted === true, '挂载树未变（dsh-good 仍挂载）')
  assert(list.json.value.plugins.find(p => p.pkg === 'dsh-new')?.mounted === false, 'dsh-new 未挂载（保存不实际应用）')
  // 覆盖已有预设 → 不切换激活（只更新记录）
  const save2 = await callApi(ctx, 'preset/save', { name: 'p2', draft: {} })
  assert(save2.json.value?.activated === 'p2', '保存 p2（新名）→ 激活 p2')
  const save3 = await callApi(ctx, 'preset/save', { name: 'p1', draft: { 'dsh-good': true } })
  assert(save3.json.ok === true && save3.json.value?.activated === null, '覆盖 p1 → activated=null（不切换）')
  const reg2 = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg2.activePreset === 'p2', '覆盖已有预设不切换激活（仍 p2）')
  // 覆盖语义 = 当前激活表快照 + draft（0.4.2 起）；dsh-new 来自激活 p2 表的快照，dsh-good 由 draft 并入
  assert(reg2.presets['p1']['dsh-good'] !== undefined, '覆盖后 p1 表含 draft 并入的 dsh-good')
  // 不合法的 draft（数组）被拒
  const bad = await callApi(ctx, 'preset/save', { name: 'p3', draft: [1, 2] })
  assert(bad.json.ok === false && bad.json.error?.code === 'bad-request', 'draft 数组被拒（bad-request）')
}

async function casePresetDelete() {
  console.log('\n[T16] preset/delete：多选删除 + 拒 default/拒当前激活 + 非法输入（0.4.3）')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t16-preset-delete')
  const ctx = makeCtx()
  await bootCase({
    name: 't16', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: {},
  })
  for (const n of ['p1', 'p2', 'p3']) {
    const r = await callApi(ctx, 'preset/save', { name: n })
    assert(r.json.ok === true, `保存预设 ${n} ok`)
  }
  const badDefault = await callApi(ctx, 'preset/delete', { names: ['default'] })
  assert(badDefault.json.ok === false && badDefault.json.error?.code === 'bad-request', '拒删 default')
  await callApi(ctx, 'preset/switch', { name: 'p1' })
  const badActive = await callApi(ctx, 'preset/delete', { names: ['p1'] })
  assert(badActive.json.ok === false && badActive.json.error?.code === 'bad-request', '拒删当前激活预设')
  const del = await callApi(ctx, 'preset/delete', { names: ['p2', 'p3'] })
  assert(del.json.ok === true, '多选删除 p2/p3 ok')
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg.presets['p2'] === undefined && reg.presets['p3'] === undefined, 'p2/p3 已移除')
  assert(reg.presets['p1'] !== undefined && reg.presets['default'] !== undefined, 'p1/default 保留')
  const badArr = await callApi(ctx, 'preset/delete', { names: [] })
  assert(badArr.json.ok === false, '空数组被拒')
  const badName = await callApi(ctx, 'preset/delete', { names: ['a b'] })
  assert(badName.json.ok === false, '非法名被拒')
}

// ── 0.5.0 对外双轨 / 卸载半边 测试（T17+）─────────────────────────────────────

function profileBundlesOf(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? []
}

/** T17 — registry 行状态机：旧行默认 managed-by-bm；superseded-by-static 只读 */
async function caseRowStateMachine() {
  console.log('\n[T17] registry 行状态机迁移 + 只读展示')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t17-state-machine')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  installFake(profileDir, 'dsh-static', JSON.stringify(goodManifest()))
  // 预写 registry：dsh-good 旧格式（无 state）→ 归一化 managed-by-bm；dsh-static 已固化
  writeJson(join(shellHome, 'registry.json'), {
    version: 1,
    activePreset: 'default',
    presets: { default: {
      'dsh-good': { config: null },
      'dsh-static': { config: null, state: 'superseded-by-static' },
    } },
    failed: {},
  })
  const ctx = makeCtx()
  await bootCase({
    name: 't17', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx,
    profileDeps: { 'dsh-good': '1.0.0', 'dsh-static': '1.0.0' },
    // dsh-static 放官方静态层
    profileBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-bundle-manager', 'dsh-static'],
  })
  const res = await callApi(ctx, 'list', {})
  const byPkg = {}
  for (const p of res.json.value.plugins) byPkg[p.pkg] = p
  // 旧格式行 → 归一化 managed-by-bm（dsh-good 为正常 toggleable 候选，boot 已挂载）
  assert(byPkg['dsh-good'] && byPkg['dsh-good'].regState === 'managed-by-bm', '旧格式行归一化 managed-by-bm')
  assert(byPkg['dsh-good'] && byPkg['dsh-good'].mounted === true, '候选 dsh-good boot 已挂载')
  // dsh-static 在 bundles → 只读 superseded-by-static（非候选）
  assert(byPkg['dsh-static'] && byPkg['dsh-static'].regState === 'superseded-by-static', '已固化行 regState=superseded-by-static')
  assert(byPkg['dsh-static'] && byPkg['dsh-static'].state === 'superseded-by-static', '已固化行只读展示')
  // 已固化行不可 toggle（apply ON 被拒：双重挂载防线）
  const apply = await callApi(ctx, 'apply', { entries: { 'dsh-static': true } })
  assert(apply.json.ok === false && (apply.json.error?.code === 'superseded-by-static' || apply.json.error?.code === 'bad-request'),
    '静态层行 apply ON 被拒（双重挂载防线）')
  // 顶层 bundles 只读展示
  assert(res.json.value.bundles.includes('dsh-static'), 'list.bundles 含 dsh-static')
}

/** T18 — create 过滤：官方静态层包不双重挂载（boot 不 create、标 superseded-by-static） */
async function caseDoubleMountFilter() {
  console.log('\n[T18] create 过滤：静态层包不双重挂载')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t18-double-mount')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  // 预写 registry：dsh-good 也想被 bm 管（managed-by-bm）——但它在官方静态层
  writeJson(join(shellHome, 'registry.json'), {
    version: 1,
    activePreset: 'default',
    presets: { default: { 'dsh-good': { config: null, state: 'managed-by-bm' } } },
    failed: {},
  })
  // 计数式 create 行为：验证 bm 对静态层包不发 create
  const ctx = makeCtx((options) => 'ok')
  // 模拟官方静态 boot 挂载（id include:dsh-good）
  ctx.bootEntries(['dsh-good'])
  await bootCase({
    name: 't18', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx,
    profileDeps: { 'dsh-good': '1.0.0' },
    profileBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-bundle-manager', 'dsh-good'],
  })
  // bm 不应 create（已在静态层）
  assert(ctx.createCounts['dsh-good'] === undefined, 'boot 未对静态层包 create（不双重挂载）')
  const list = await callApi(ctx, 'list', {})
  const row = list.json.value.plugins.find(p => p.pkg === 'dsh-good')
  assert(row && row.regState === 'superseded-by-static', '静态层行标 superseded-by-static')
  assert(row && row.mounted === true && row.managed === false, '静态层行保持静态挂载（managed=false）')
  // registry 行已从 managed-by-bm 收敛为 superseded-by-static
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg.presets?.default?.['dsh-good']?.state === 'superseded-by-static', 'registry 行收敛为 superseded-by-static')
}

/** T19 — import-to-bm：白名单 + 摘条 + 预注册 pending-import + 失败可见 + A 级备份 */
async function caseImportToBm() {
  console.log('\n[T19] import-to-bm：摘 bundles + 预注册 + 失败可见 + .bm.bak')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t19-import')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  installFake(profileDir, 'dsh-also', JSON.stringify(goodManifest()))
  // dsh-good 在静态层；dsh-also 在 dependencies（deps-only）
  const ctx = makeCtx()
  await bootCase({
    name: 't19', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx,
    profileDeps: { 'dsh-good': '1.0.0', 'dsh-also': '1.0.0' },
    profileBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-bundle-manager', 'dsh-good'],
  })
  const before = profileBundlesOf(profileDir)
  const imp = await callApi(ctx, 'import-to-bm', { pkg: ['dsh-good', 'dsh-also', 'dsh-missing'] })
  const v = imp.json.value
  assert(imp.json.ok === true, 'import-to-bm ok')
  assert(v.imported.includes('dsh-good') && v.imported.includes('dsh-also'), '两个有效包导入')
  // 白名单：未安装的 dsh-missing 被拒（可见）
  assert(v.rejected.some(r => r.pkg === 'dsh-missing'), '未安装包 rejected')
  // 摘条：dsh-good 从 bundles 移除（manifest 变更 → needsRestart）
  const after = profileBundlesOf(profileDir)
  assert(!after.includes('dsh-good') && before.includes('dsh-good'), 'dsh-good 从 bundles 摘除')
  assert(v.needsRestart === true, '导入后需重启')
  // 预注册：dsh-good（原在 bundles）→ pending-import；dsh-also（deps-only）→ managed-by-bm
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg.presets?.default?.['dsh-good']?.state === 'pending-import', '原静态层包预注册 pending-import')
  assert(reg.presets?.default?.['dsh-also']?.state === 'managed-by-bm', 'deps-only 包预注册 managed-by-bm')
  // A 级冗余 3：返回 snapshotId（供一键回滚）
  assert(typeof v.snapshotId === 'string' && v.snapshotId !== '', '返回 import snapshotId')
  // A 级冗余 1：.bm.bak 保底（导入前 manifest 快照）
  assert(existsSync(join(profileDir, 'package.json.bm.bak')), '导入产生 package.json.bm.bak 备份')
  // 写后的 bundles 与 .bm.bak 前状态一致（dsh-good 仍在 .bm.bak 里）
  const bak = JSON.parse(readFileSync(join(profileDir, 'package.json.bm.bak'), 'utf8'))
  assert(bak.dsh?.profile?.bundles.includes('dsh-good'), '.bm.bak 保留导入前 bundles（含 dsh-good）')
  // 导入后（当前会话，未重启）list 展示 dsh-good 为 pending-import（待重启接管）
  const afterList = await callApi(ctx, 'list', {})
  assert(afterList.json.value.plugins.find(p => p.pkg === 'dsh-good')?.regState === 'pending-import',
    '导入后 list 展示 pending-import（待重启接管）')
}

/** T20 — export-to-bundles：加进 bundles + superseded-by-static + 重启引导 */
async function caseExportToBundles() {
  console.log('\n[T20] export-to-bundles：固化 + superseded-by-static')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t20-export')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  installFake(profileDir, 'dsh-plain', JSON.stringify(goodManifest())) // 候选：已装但从未托管
  // 计数式 create：验证 bm 实际 create 挂载 dsh-good
  const ctx = makeCtx((options) => 'ok')
  await bootCase({
    name: 't20', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx,
    profileDeps: { 'dsh-good': '1.0.0', 'dsh-plain': '1.0.0' },
  })
  // 先托管 dsh-good（deps-only → bm 挂载）
  let apply = await callApi(ctx, 'apply', { entries: { 'dsh-good': true } })
  assert(apply.json.ok === true, 'apply dsh-good ON ok')
  assert(ctx.createCounts['dsh-good'] === 1, 'dsh-good 由 bm create 挂载')
  // 导出固化
  const ex = await callApi(ctx, 'export-to-bundles', { pkg: ['dsh-good'] })
  const v = ex.json.value
  assert(ex.json.ok === true, 'export-to-bundles ok')
  assert(v.exported.includes('dsh-good'), '导出包含 dsh-good')
  assert(v.needsRestart === true, '导出后需重启')
  assert(profileBundlesOf(profileDir).includes('dsh-good'), 'dsh-good 已加入官方静态层')
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg.presets?.default?.['dsh-good']?.state === 'superseded-by-static', '导出后行标 superseded-by-static')
  // 0.5.1：未托管候选（已装、无 registry 行）也可导出固化——不要求 bm 托管行
  const exPlain = await callApi(ctx, 'export-to-bundles', { pkg: ['dsh-plain'] })
  const vp = exPlain.json.value
  assert(exPlain.json.ok === true, '未托管候选导出 ok')
  assert(vp.exported.includes('dsh-plain'), '导出包含 dsh-plain（未托管候选）')
  assert(vp.needsRestart === true, '候选导出后需重启')
  assert(profileBundlesOf(profileDir).includes('dsh-plain'), 'dsh-plain 已加入官方静态层')
  // framework-hard-protect：导出框架被拒
  const fw = await callApi(ctx, 'export-to-bundles', { pkg: ['dsh-bundle-manager'] })
  assert(Array.isArray(fw.json.value?.rejected) && fw.json.value.rejected.some(r => r.code === 'framework-protected'),
    '导出框架被拒（framework-protected）')
  // 未安装包导出被拒（非候选也非托管行）
  const notManaged = await callApi(ctx, 'export-to-bundles', { pkg: ['dsh-ghost'] })
  assert(notManaged.json.value.rejected.some(r => r.pkg === 'dsh-ghost'), '未安装包导出 rejected')
}

/** T21 — import/rollback：一键回滚批次（写回 bundles + 还原 registry 行） */
async function caseImportRollback() {
  console.log('\n[T21] import/rollback：写回 bundles + 还原行（A 级冗余 3）')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t21-rollback')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  const ctx = makeCtx()
  await bootCase({
    name: 't21', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
    profileBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-bundle-manager', 'dsh-good'],
  })
  // 导入
  const imp = await callApi(ctx, 'import-to-bm', { pkg: ['dsh-good'] })
  const snapshotId = imp.json.value.snapshotId
  assert(typeof snapshotId === 'string' && snapshotId, '导入生成 snapshotId')
  assert(!profileBundlesOf(profileDir).includes('dsh-good'), '导入后 dsh-good 已摘条')
  // 回滚
  const rb = await callApi(ctx, 'import/rollback', { id: snapshotId })
  assert(rb.json.ok === true, 'import/rollback ok')
  assert(profileBundlesOf(profileDir).includes('dsh-good'), '回滚后 dsh-good 写回 bundles')
  // 快照无效 id → not-found
  const bad = await callApi(ctx, 'import/rollback', { id: 'nope' })
  assert(bad.json.ok === false && bad.json.error?.code === 'not-found', '无效快照 id → not-found')
}

/** T22 — uninstall：先 bm 出库（清行）后引导官方 remove；dormant 可逆 */
async function caseUninstallOrder() {
  console.log('\n[T22] uninstall：bm 出库 + dormant + 官方命令引导 + 可逆')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t22-uninstall')
  installFake(profileDir, 'dsh-good', JSON.stringify(goodManifest()))
  const ctx = makeCtx()
  await bootCase({
    name: 't22', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: { 'dsh-good': '1.0.0' },
  })
  // 托管 ON
  await callApi(ctx, 'apply', { entries: { 'dsh-good': true } })
  const regBefore = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(regBefore.presets?.default?.['dsh-good'] !== undefined, '卸载前 dsh-good 在表中')
  // 卸载
  const un = await callApi(ctx, 'uninstall', { pkg: ['dsh-good', 'dsh-base'] })
  const v = un.json.value
  assert(un.json.ok === true, 'uninstall ok')
  assert(v.uninstalled.includes('dsh-good'), 'dsh-good 出库')
  // 框架硬保护：dsh-base 被拒
  assert(v.rejected.some(r => r.pkg === 'dsh-base' && r.code === 'framework-protected'), '卸载框架被拒')
  // bm 出库：registry 行清空（激活表 + failed）
  const regAfter = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(regAfter.presets?.default?.['dsh-good'] === undefined, 'bm 出库后 registry 行已清')
  // 出库只动 registry，不碰 manifest（依赖仍在 = dormant）
  assert(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies['dsh-good'] !== undefined,
    'bm 出库不碰 manifest（依赖仍在 → dormant）')
  assert(v.dormant.includes('dsh-good'), 'dsh-good 退化为 dormant dependency')
  // 官方命令引导（先出库后 remove）
  assert(v.command.includes('remove dsh-good') && v.command.includes('dsh-good'), '返回官方 remove 引导命令')
  assert(v.dormant.length === 1, 'dormant 恰为 dsh-good（deps-only 托管包）')
  // dormant 可逆：写回 registry 行 enabled → 恢复管理（apply ON 重新托管）
  const applyBack = await callApi(ctx, 'apply', { entries: { 'dsh-good': true } })
  assert(applyBack.json.ok === true, 'dormant 可逆：apply ON 恢复托管')
  const regRev = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(regRev.presets?.default?.['dsh-good']?.state === 'managed-by-bm', '恢复托管后行状态 managed-by-bm')
}

/** T23 — 反应式 GC：行包已不在 deps/磁盘 → 清行 + failed 账本 */
async function caseReactiveGC() {
  console.log('\n[T23] 反应式 GC：外部已删包 → 清行 + failed 提示')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t23-gc')
  // registry 表里有 dsh-gone，但依赖/磁盘都无 → boot 应清行 + 记 failed
  writeJson(join(shellHome, 'registry.json'), {
    version: 1,
    activePreset: 'default',
    presets: { default: { 'dsh-gone': { config: null, state: 'managed-by-bm' } } },
    failed: {},
  })
  const ctx = makeCtx()
  await bootCase({
    name: 't23', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: {},
  })
  const reg = JSON.parse(readFileSync(join(shellHome, 'registry.json'), 'utf8'))
  assert(reg.presets?.default?.['dsh-gone'] === undefined, 'GC 清掉外部已删包的行')
  assert(reg.failed['dsh-gone'] !== undefined, 'GC 记 failed 账本')
  assert(reg.failed['dsh-gone']?.kind === 'not-a-bundle', 'GC failed 账本 kind=not-a-bundle')
  assert(reg.failed['dsh-gone']?.error.includes('外部移除'), 'GC failed 提示外部移除')
  const list = await callApi(ctx, 'list', {})
  const row = list.json.value.plugins.find(p => p.pkg === 'dsh-gone')
  assert(row === undefined, 'GC 后 list 不再出现 dsh-gone 行')
}

/** T24 — 候选发现：官方 @deepseek-ai scope 不进候选（headless 事故回归）；非核心孤儿仍可发现（P9） */
async function caseCoreScopeExcluded() {
  console.log('\n[T24] 候选发现：@deepseek-ai scope 排除 + 非核心孤儿保留')
  const { shellHome, profileDir, dshHome, pkgDir } = buildCase('t24-core-scope')
  // 官方 scope 的 runner 型 bundle（patch 声明 dsh.bundle，但属核心家族，2026-08-19 headless 事故同型）
  installFake(profileDir, '@deepseek-ai/dsh-core-x', JSON.stringify({
    name: '@deepseek-ai/dsh-core-x', version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  // 非核心孤儿（装了但未声明 deps）：P9 设计仍应可发现
  installFake(profileDir, 'dsh-orphan', JSON.stringify(goodManifest()))
  const ctx = makeCtx()
  await bootCase({
    name: 't24', dshHome, profileDir, pkgDir, shellHome,
    env: { pluginManagerHome: shellHome }, ctx, profileDeps: {},
  })
  const res = await callApi(ctx, 'list', {})
  const pkgs = res.json.value.plugins.map(p => p.pkg)
  assert(!pkgs.includes('@deepseek-ai/dsh-core-x'), '官方 @deepseek-ai scope 包不进候选列表')
  assert(pkgs.includes('dsh-orphan'), '非核心孤儿包仍可发现（P9 保留）')
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('dsh-bundle-manager host half — offline harness\n')
  wipeScratch()
  const cases = [
    caseShellMigration,
    caseCorruptPrimaryBakRecovery,
    caseSeedEmptyRegistry,
    caseBrokenManifest,
    caseWatchdogTimeout,
    caseStorageError,
    caseFrameworkProtected,
    casePresetDiff,
    caseInvalidEnv,
    caseGenericDualWrite,
    caseSwitchPresetKeepsFailed,
    casePresetCap,
    caseBootGroupedParallel,
    caseRenameMigration,
    casePresetSaveWithDraft,
    casePresetDelete,
    // 0.5.0 对外双轨 / 卸载半边
    caseRowStateMachine,
    caseDoubleMountFilter,
    caseImportToBm,
    caseExportToBundles,
    caseImportRollback,
    caseUninstallOrder,
    caseReactiveGC,
    caseCoreScopeExcluded,
  ]
  for (const fn of cases) {
    try {
      await fn()
    } catch (err) {
      failed += 1
      console.error(`  FAIL- case ${fn.name} threw: ${err?.stack ?? err}`)
    }
  }
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  wipeScratch()
  if (failed > 0) process.exitCode = 1
}

await main()
