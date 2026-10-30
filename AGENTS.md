# Progress Pin

OpenCode V2 plugin. Server: `src/index.ts`; durable execution: `src/worker.ts`; pinned terminal UI: `src/tui.tsx`; shared RPC: `src/rpc.ts`; Python iterator helper: `python/opencode_progress.py`.

Use current V2 plugin APIs from https://opencode.ai/v2/docs/build/plugins . Run `bun run check` for types and real demo commands for acceptance. Do not write or run unit tests. Source lives here only; generated output and task data belong in ignored directories. The README screenshot is maintained in `docs/progress-pin.png`; other acceptance captures stay in `artifacts/`. See README for installation and compatibility, and `docs/usage.md` for tools and progress protocols.
