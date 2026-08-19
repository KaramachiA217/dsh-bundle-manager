# dsh-bundle-manager

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-bundle-manager)](https://www.npmjs.com/package/dsh-bundle-manager)
[![stars](https://img.shields.io/github/stars/KaramachiA217/dsh-bundle-manager?style=flat)](https://github.com/KaramachiA217/dsh-bundle-manager)

A runtime mount manager for optional third-party plugin bundles in DeepSeek Harness. Provides the「插件挂载管理」(Plugin Mount Manager) settings section that mounts/unmounts bundle rows **in-process through the Loader API** — instant effect, **no restart, never rewrites the profile manifest**, with named presets, a failure ledger and self-healing fallback.

## Install

Install from npm with the official CLI (one step: adds the dependency, then reconcile appends the package to `dsh.profile.bundles`):

```sh
dsh plugin --profile <profile-name> add dsh-bundle-manager
```

npm latest is currently **0.5.3**; upgrade later by re-running with `@latest` (`dsh plugin --profile <profile-name> add dsh-bundle-manager@latest`).

**Key architecture requirement**: optional third-party plugins must live in `dependencies` only (NOT in `dsh.profile.bundles`), and this plugin is the only framework bundle that mounts them at runtime. The resulting profile layout (what the CLI produces):

```json
{
  "dependencies": { "dsh-bundle-manager": "^0.5.3" },
  "dsh": { "profile": { "bundles": ["dsh-base", "dsh-web-app", "dsh-settings-ui", "dsh-bundle-manager"] } }
}
```

Local development (optional): `npm pack` to build the tarball, then `dsh plugin --profile <profile-name> add ./dsh-bundle-manager-<ver>.tgz` (or a `file:` dependency), re-packing on every change — see [Development](#development).

## What you get

- **Draft switches + one-shot apply** — toggle plugins in a local draft, click **Save & Refresh** to apply the whole table (host diffs create/remove + persists, then hard-refreshes the page so client halves reconcile)
- **Named presets** — save the current draft combination as a preset (uncommitted toggles are merged into the snapshot; saving a **new** preset auto-activates it), switch from the dropdown, delete via multi-select with irreversible confirmation
- **Self-healing** — bad plugins land in a **Failed** group (kind + attempts + error) and the rest keep working; 20s mount watchdog; grouped-parallel boot (`DSH_PM_BOOT_GROUPS`, 1–8)
- **Safety** — framework whitelist protects core bundles (`framework-protected`); atomic registry writes with `.bak` last-known-good and automatic legacy-path migration
- **Official coexistence / double-track (v0.5)** — reversible switching between the official static layer (`dsh.profile.bundles`) and the bm runtime layer: **import** a statically-bundled plugin into bm, **export** a bm-managed plugin back to the official static layer (or export all as a safety net), with A-level redundancy (atomic manifest write + backup + JSON.parse rollback, one-click batch rollback, dependency-group hints, framework hard-protection). Plus the **uninstall half**: bm de-registers the registry row first, then guides `dsh plugin remove pkg...`; a reactive GC clears rows for packages removed externally (bypassing bm).

## API (fenced `/bundle-manager/api`, browser-trust fence)

| Method | Body | Returns |
|---|---|---|
| `list` | `{}` | `plugins[]` (state/regState/version/managed/waitingFor/kind/attempts) + `profile/activePreset/presets/bundles` + `storage` block |
| `apply` | `{ entries: { pkg: true\|false } }` | one-shot diff apply + persist (serial queue, 30s cap) |
| `preset/save` | `{ name, draft? }` | save snapshot (draft merged, new name auto-activates) |
| `preset/switch` | `{ name }` | diff switch (keeps shared plugins mounted) |
| `preset/delete` | `{ names: string[] }` | multi-delete (rejects `default` / active preset) |
| `import-to-bm` | `{ pkg: string[] }` | official → bm (remove from bundles, pre-register, guide restart) |
| `export-to-bundles` | `{ pkg: string[] }` | bm → official static layer (add to bundles, superseded-by-static) |
| `export-all-to-bundles` | `{}` | safety net: write back ALL managed to the official static layer |
| `import/rollback` | `{ id }` | one-click rollback of an import batch (snapshot restore) |
| `uninstall` | `{ pkg: string[] }` | bm de-registry first, then guide `dsh plugin remove pkg...` |

## Official coexistence (double-track, v0.5)

Plugins can live in either **track**; switching is reversible and **needs a restart** (the compact dsh client has no unload chain, see the manual):

- **Official static layer** (`dsh.profile.bundles`) — loaded by dsh at boot, permanent. Plugins here are **not** bm-toggleable (they appear read-only as `superseded-by-static`); use **导入到 bm (import-to-bm)** to hand one over to runtime management.
- **bm runtime layer** — mounted/unmounted in-process with zero restart. Use **导出到官方 (export-to-bundles)** to permanently coalesce a plugin back to the static layer, or **导出全部到官方 (export-all-to-bundles)** as a safety net before removing bm itself.

Because import/export edit the profile manifest, they are the three explicit exceptions to the "never write the manifest" rule, and all run through A-level redundancy: atomic write with `.bm.bak` backup + JSON.parse rollback, pre-registration with visible failures (`imported`/`rejected`), one-click batch rollback, dependency-group hints, and framework hard-protection.

**Uninstall half (v0.5)**: ① **bm出库** — clear the registry rows (bm-owned file only, never the manifest); ② **guide** the official `dsh plugin remove pkg...` (official CLI passes through pnpm, supports batching, and `reconcile` automatically pulls packages out of `bundles`). Clearing first keeps the operation reversible: if the official removal fails, the package degrades to a **dormant dependency** (installed, idle) — flip it back on in the settings page (registry row rewritten) to restore management. A **reactive GC** also cleans up rows for packages removed externally (bypassing bm) and records a visible `failed` entry.

> **Family single-track note**: the other first-party family plugins (mcp / search / proxy / skill / balance …) stay **single-track** — `dependencies`-only, mounted at runtime by bm, not participating in import/export (their repos are untouched). Double-track is an **optional enhancement for external users**: install everything via official `dsh plugin add`, then import only what you want bm to manage. No family plugin needs double-track adaptation to be managed by bm.

## Compatibility

- Verified on dsh **0.1.0-rc.5** (official desktop shell, framework-only bundles).
- **rc.6 verified (2026-08-17)**: rc.5/rc.6 share the same upstream commit (`47f9438`) — runtime mount/unmount, framework whitelist, failed isolation, presets, registry persistence and the client half all pass with **zero code adaptation**. Known difference: `link:` mounts fail ESM resolution on rc.6, use `file:` tarballs.
- **rc.7 (2026-08-19)**: `settings.section` (the only kit surface bm uses) is unchanged on rc.7; the kit is pinned to the npm release `dsh-settings-ui@0.2.22` (bm does **not** depend on kit 0.3.0's `pluginCard`/`settingsScope`). bm v0.5 coexists with the official static layer (import/export). Full shell verification is performed through the `rc7-bm` test profile (see the runbook); contract deltas beyond `settings.plugin.item` list→keyed (which bm does not consume) are tracked by the kit alignment plan.

## Development

```bash
npm test     # offline regression harness (210 assertions, mock ctx driving the fenced API)
npm run ci   # 5-step gate: syntax + harness + secret scan + sanitization + pack whitelist
```

## License

MIT — see [LICENSE](./LICENSE). · Full manual (Chinese): [MANUAL.md](./MANUAL.md)
