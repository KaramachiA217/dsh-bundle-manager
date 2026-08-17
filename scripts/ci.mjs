/**
 * dsh-bundle-manager 本地 CI 门禁（零依赖，Node 内置能力；对齐 dsh-settings-ui 标准）。
 *
 * 步骤（任一步失败即 exit 1）：
 *   1. 语法检查：lib/*.js、test/harness.mjs（node --check）
 *   2. 离线回归：node test/harness.mjs（mock ctx 直驱 fenced API，159 断言）
 *   3. 凭据扫描：sk- / gh tokens / github_pat_ / xox 类 / AKIA / AIza / 私钥块 /
 *      DEEPSEEK_*_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / x-access-token:<value> / 代理地址
 *   4. 脱敏回归：README.md / MANUAL.md / CHANGELOG.md / LICENSE 不得出现本机专属路径
 *      （E:\、E:/、C:\Users、代理端口 127.0.0.1:7897、工作区目录 PluginsDev/DesktopDev）——
 *      发布物面向包消费者；内部开发信息不进公开仓。
 *   5. npm files 白名单校验：与 package.json 声明一致（打包只含发布物）。
 *
 * 子进程一律 stdio:'inherit'（沙箱内禁命名管道，见全局工作区 HANDOFF）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = false
const fail = (msg) => { console.error('  ✖ ' + msg); failed = true }
const ok = (msg) => console.log('  ✔ ' + msg)
const step = (title) => console.log('\n[' + title + ']')

const run = (label, ...args) => {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) fail(label + '（exit ' + r.status + '）')
  else ok(label)
}

// 1. 语法检查
step('1/5 语法检查')
for (const f of ['lib/index.js', 'lib/client.js', 'test/harness.mjs']) {
  run('node --check ' + f, '--check', f)
}

// 2. 离线回归
step('2/5 离线回归（harness）')
run('node test/harness.mjs', 'test/harness.mjs')

// 3. 凭据扫描（追踪文件）
step('3/5 凭据扫描')
const secretPat = /(sk-[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|BEGIN [A-Z ]*PRIVATE KEY|DEEPSEEK_[A-Z_]*KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|x-access-token:[A-Za-z0-9]|127\.0\.0\.1:7897)/i
const scanFiles = [
  'package.json', 'cordis.patch.yml', 'README.md', 'MANUAL.md', 'CHANGELOG.md',
  'LICENSE', 'lib/index.js', 'lib/client.js', 'test/harness.mjs',
  '.github/workflows/ci.yml', '.gitignore', '.gitattributes',
]
let secretHits = 0
for (const f of scanFiles) {
  const text = readFileSync(join(root, f), 'utf8')
  const m = text.match(secretPat)
  if (m) { secretHits++; fail('凭据疑似命中 ' + f + '：' + m[0].slice(0, 24) + '…') }
}
if (secretHits === 0) ok('扫描 ' + scanFiles.length + ' 个文件，零命中')

// 4. 脱敏回归（发布物不携带本机专属信息；repo URL 中的账号名属公开信息，不查）
step('4/5 发布物脱敏回归')
const pathPat = /(E:\\|E:\/|C:\\Users|127\.0\.0\.1:7897|PluginsDev|DesktopDev)/
for (const f of ['README.md', 'MANUAL.md', 'CHANGELOG.md', 'LICENSE']) {
  const text = readFileSync(join(root, f), 'utf8')
  const m = text.match(pathPat)
  if (m) fail(f + ' 含本机专属信息：' + m[0])
  else ok(f + ' 干净')
}

// 5. npm files 白名单校验
step('5/5 npm 打包白名单')
const expectedFiles = ['lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'MANUAL.md', 'CHANGELOG.md', 'LICENSE']
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const actual = pkg.files ?? []
if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expectedFiles].sort())) {
  fail('files 白名单漂移：' + JSON.stringify(actual) + '（期望 ' + JSON.stringify(expectedFiles) + '）')
} else ok('files 白名单与发布物一致')

console.log('\n' + (failed ? 'CI FAILED ✖' : 'CI PASSED ✔'))
process.exit(failed ? 1 : 0)
