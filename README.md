# dsh-bundle-manager

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-bundle-manager)](https://www.npmjs.com/package/dsh-bundle-manager)
[![stars](https://img.shields.io/github/stars/KaramachiA217/dsh-bundle-manager?style=flat)](https://github.com/KaramachiA217/dsh-bundle-manager)

A runtime mount manager for optional third-party plugin bundles in DeepSeek Harness. Provides the「插件挂载管理」(Plugin Mount Manager) settings section that mounts/unmounts bundle rows **in-process through the Loader API** — instant effect, **no restart, never rewrites the profile manifest**, with named presets, a failure ledger and self-healing fallback.

## Install

```sh
npm i dsh-bundle-manager
```

**Key architecture requirement**: optional third-party plugins must live in `dependencies` only (NOT in `dsh.profile.bundles`), and this plugin is the only framework bundle that mounts them at runtime:

```json
{
  "dependencies": { "dsh-bundle-manager": "npm:dsh-bundle-manager" },
  "dsh": { "profile": { "bundles": ["dsh-base", "dsh-web-app", "dsh-settings-ui", "dsh-bundle-manager"] } }
}
```

## What you get

- **Draft switches + one-shot apply** — toggle plugins in a local draft, click **Save & Refresh** to apply the whole table (host diffs create/remove + persists, then hard-refreshes the page so client halves reconcile)
- **Named presets** — save the current draft combination as a preset (uncommitted toggles are merged into the snapshot; saving a **new** preset auto-activates it), switch from the dropdown, delete via multi-select with irreversible confirmation
- **Self-healing** — bad plugins land in a **Failed** group (kind + attempts + error) and the rest keep working; 20s mount watchdog; grouped-parallel boot (`DSH_PM_BOOT_GROUPS`, 1–8)
- **Safety** — framework whitelist protects core bundles (`framework-protected`); atomic registry writes with `.bak` last-known-good and automatic legacy-path migration

## API (fenced `/bundle-manager/api`, browser-trust fence)

| Method | Body | Returns |
|---|---|---|
| `list` | `{}` | `plugins[]` (state/version/managed/waitingFor/kind/attempts) + `profile/activePreset/presets` + `storage` block |
| `apply` | `{ entries: { pkg: true\|false } }` | one-shot diff apply + persist (serial queue, 30s cap) |
| `preset/save` | `{ name, draft? }` | save snapshot (draft merged, new name auto-activates) |
| `preset/switch` | `{ name }` | diff switch (keeps shared plugins mounted) |
| `preset/delete` | `{ names: string[] }` | multi-delete (rejects `default` / active preset) |

## Compatibility

- Verified on dsh **0.1.0-rc.5** (official desktop shell, framework-only bundles).
- **rc.6 verified (2026-08-17)**: rc.5/rc.6 share the same upstream commit (`47f9438`) — runtime mount/unmount, framework whitelist, failed isolation, presets, registry persistence and the client half all pass with **zero code adaptation**. Known difference: `link:` mounts fail ESM resolution on rc.6, use `file:` tarballs.

## Development

```bash
npm test     # offline regression harness (159 assertions, mock ctx driving the fenced API)
npm run ci   # 5-step gate: syntax + harness + secret scan + sanitization + pack whitelist
```

## License

MIT — see [LICENSE](./LICENSE). · Full manual (Chinese): [MANUAL.md](./MANUAL.md)
