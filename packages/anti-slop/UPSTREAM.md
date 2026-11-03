# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop (MIT, `LICENSE` beside this file)
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13, "Merge pull request #45 from haydenbleasel/feat/group-singleline-bindings")
- Copied from `skills/install-anti-slop/assets/anti-slop/`, which is identical to upstream `src/` apart from the `*.test.ts` files.
- Installed on 2026-11-02 at `tools/oxlint/anti-slop/`, moved to the `packages/anti-slop/` workspace package the same day, with entry points `index.ts` (generic rules) and `effect/index.ts` (Effect rules).
- `@oxlint/plugins` is pinned to `1.89.0`, the oxlint version bundled by `vite-plus@1.4.0`. Upgrade both together.
- Local deviations: none. Every generic and Effect rule is enabled at `error` in the root `vite.config.ts`.
