# dsh-bundle-manager (English)

> Full manual (Chinese): [`MANUAL.md`](./MANUAL.md) · 中文 README：[`README.md`](./README.md)

DSH web plugin: a **runtime mount manager** for optional third-party plugin bundles. It provides a「插件挂载管理」(Plugin Mount Manager) settings section that mounts/unmounts bundle rows **in-process through the Loader API** — instant effect, **no restart, never rewrites the profile manifest**, with named presets, a failure ledger and self-healing fallback.

> Renamed from `dsh-plugin-manager` (v0.4.0). The bare name was taken by a third-party package; `dsh-bundle-manager` describes the actual job (bundle mount/unmount) and is free on npm.

## Install

```bash
npm i dsh-bundle-manager
```

**Key architecture requirement**: optional third-party plugins must live in `dependencies` only (NOT in `dsh.profile.bundles`), and this plugin is the only framework bundle that mounts them at runtime:

```json
{
  "dependencies": { "dsh-bundle-manager": "npm:dsh-bundle-manager" },
  "dsh": { "profile": { "bundles": ["dsh-base", "dsh-web-app", "dsh-settings-ui", "dsh-bundle-manager"] } }
}
```

## Usage (UI)

- Toggle switches edit a **local draft**; click **保存并刷新 (Save & Refresh)** to apply the whole table at once (host diffs create/remove + persists, then hard-refreshes the page so client halves reconcile).
- **Presets**: save the current draft combination as a named preset (`保存为预设`, draft is merged into the snapshot without applying; saving a **new** preset auto-activates it), switch presets from the dropdown, delete presets via the red `删除预设` button (multi-select + irreversible confirmation).
- Bad plugins land in a **Failed** group (kind + attempts + error) and the rest keep working.

## API (fenced `/bundle-manager/api`, browser-trust fence)

| Method | Body | Returns |
|---|---|---|
| `list` | `{}` | `plugins[]` (state/version/managed/waitingFor/kind/attempts) + `profile/activePreset/presets` + `storage` block |
| `apply` | `{ entries: { pkg: true\|false } }` | one-shot diff apply + persist (serial queue, 30s cap) |
| `preset/save` | `{ name, draft? }` | save snapshot (draft merged, new name auto-activates) |
| `preset/switch` | `{ name }` | diff switch (keeps shared plugins mounted) |
| `preset/delete` | `{ names: string[] }` | multi-delete (rejects `default` / active preset) |

Error codes: `framework-protected` / `bad-request` / `not-found` / `forbidden` / `internal` / `storage-error` / `timeout`.

## Environment

- `DSH_BUNDLE_MANAGER_HOME` — shell mode: mount table lives in the shell repo dir, zero writes to `.dsh` (legacy `DSH_PLUGIN_MANAGER_HOME` still works as a read-only fallback).
- `DSH_PM_BOOT_GROUPS` — boot mount parallelism (default 4, 1–8; `1` = fully serial).

## Compatibility

- Verified on dsh **0.1.0-rc.5** (official desktop shell, framework-only bundles).
- **rc.6 verified (2026-08-17)**: rc.5/rc.6 share the same upstream commit (`47f9438`) — runtime mount/unmount, framework whitelist, failed isolation, presets, registry persistence and the client half all pass with **zero code adaptation**. Known difference: `link:` mounts fail ESM resolution on rc.6, use `file:` tarballs.

## Development

```bash
npm test     # offline regression harness (159 assertions, mock ctx driving the fenced API)
npm run ci   # 5-step gate: syntax + harness + secret scan + sanitization + pack whitelist
```

## License

MIT — see [LICENSE](./LICENSE).
