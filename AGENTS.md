# palforge

Operator tooling for Palworld dedicated servers (`apps/palctl`, `packages/*`). Packages with a recurring pitfall have their own `AGENTS.md`; the `vp` toolchain is described in `docs/agents/vite-plus.md`.

- Effect is v4, whose APIs differ from v3: check `node_modules/effect/AGENTS.md` and its `ai-docs/`.
- Run `vp check` and `vp test --run` from the repository root; per-package test runs fail.
- The roadmap is issue #1 and its sub-issues; post acceptance evidence on the milestone's issue.
- Keep agent docs short: add a note only for a problem that keeps recurring.
