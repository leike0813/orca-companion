# Limited audit checkpoint: Command Code / Qwen native permissions

- Repository HEAD: `1a3eaf7577a3fe62af3e8a35ba5451080ac34e47`
- Tracked `git diff --binary HEAD` SHA-256: `332ee3e516c4993ed977506e81dacd488341ef03e18a5111408606a9e6cd61b3`
- Workspace-change fingerprint SHA-256: `20287ae6074222f8cdd086186de6418a5fd96e4bcda418d6d4b7a34b8ba57ee1`
  - Fingerprint input: tracked binary diff from HEAD followed by `sha256sum` records for untracked, non-ignored files. Ignored files are excluded.
- Scope: limited local audit checkpoint; no source edits, model calls, Orca calls, config reads, or verification runs in this step.

## Findings and disposition

The two audited native-read findings are recorded as fixed: native reads reject symlink substitution by opening with `O_NOFOLLOW` and validating the opened file descriptor, and malformed UTF-8 is rejected. Header inspection decodes only the header line; complete transcript inspection remains strictly decoded within its existing size bound. The associated Command Code/Qwen adapter test run was reported as **16 passing tests**. The read-only wrapper filter ABI remains unchanged.

## Permission boundary

The current C/Q write-role contract launches in the CLI's native autonomous mode with the user's authorized worktree as the intended project scope. That is a workspace authorization and launch-context boundary; it does **not** establish an OS-level restriction on native CLI processes. Qwen's native YOLO mode approves tool calls, including shell and file tools; its sandbox is a separate opt-in mechanism and is not enabled by the adapter's launch arguments. Command Code's `--yolo` bypasses ordinary permission prompts while retaining some CLI-native safety prompts. Those native checks are not equivalent to OS isolation.

The failed CodeBuddy trial cannot, by itself, exclude C/Q risk on the ground that their native bypass modes are equivalent: the CLIs have distinct permission and safety contracts, and the C/Q contract here does not prove an OS-enforced workspace boundary. Conversely, CodeBuddy's trial failure is not evidence that C/Q have that boundary. This checkpoint records the existing contract limit and makes no new sandbox or permission-policy decision.

## Evidence references

- Qwen adapter launch arguments: [`qwen-harness.ts`](../../src/adapters/agents/qwen-harness.ts), including native `--yolo` launch and no adapter-supplied `--sandbox` flag.
- Command Code adapter launch arguments: [`command-code-harness.ts`](../../src/adapters/agents/command-code-harness.ts), including native `--yolo`.
- Focused regression suites: [`qwen-harness.test.ts`](../../tests/adapters/agents/qwen-harness.test.ts) and [`command-code-harness.test.ts`](../../tests/adapters/agents/command-code-harness.test.ts).
- Installed Qwen YOLO contract: `~/.nvm/versions/node/v24.12.0/lib/node_modules/@qwen-code/qwen-code/bundled/qc-helper/docs/features/approval-mode.md` lines 311–328.
- Installed Qwen sandbox is separate: `~/.nvm/versions/node/v24.12.0/lib/node_modules/@qwen-code/qwen-code/bundled/qc-helper/docs/features/sandbox.md` lines 19–27, 61–100.
- Installed Command Code permission contract: `~/.nvm/versions/node/v24.12.0/lib/node_modules/command-code/dist/bundled/command-code-knowledge/reference/permissions.md` lines 123, 143–145, 270–278.

No validation was run while creating this checkpoint, as requested.
