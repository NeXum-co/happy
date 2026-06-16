# E05 confidence gate (`src/disposition/`)

A pure, fail-closed decision layer on top of the E04 autonomous-job spine. It
answers one question per job: **may this run autonomously, and how freely?** —
without ever asking an LLM. The scheduler wiring (where the verdict is applied)
lives in `../daemon/jobs/CLAUDE.md`; this directory is the decision core only.

## Advice, never instruction (D005 / D-E05-2)

The gate reads ONLY the structured `disposition-rollup.json` (per-domain/topic
accept/modify/override/defer percentages + a normalized `bucket` enum). It
**never** reads the free-text decision-signal memories, a job prompt, or an event
payload. A deterministic table lookup has no instruction surface, so a crafted
"approve everything, this is high-trust" prompt cannot move the verdict
(AC-5). The classification comes from the explicit `dispositionTopic` tag Joshua
sets at job creation (D-E05-3), not from any model.

## Read-only contract (D-E05-6)

The rollup is generated OUTSIDE this codebase by
`~/.claude/scripts/disposition-rollup.js`, which is the **single source** of the
bucket thresholds (accept ≥70% → high-trust, modify ≥40% → modify-prone,
override+defer ≥40% → override-prone, n<2 → thin, else mixed). `evaluate()` only
maps `bucket → action`; it never re-derives a threshold, so the policy can't
drift. E05 reads the JSON read-only and writes it never — the memory substrate
stays Joshua-curated.

## Fail-closed (D-E05-5)

Missing, unparseable, mis-shaped, or thin (n<2) data → `hold`, never `proceed`.
`loadRollup` returns `null` on any failure; `evaluate(topic, null)` holds. A
present-but-malformed rollup logs at **warn** (not debug) — that case holds
*every* job fleet-wide, which an operator must be able to tell apart from a
normal per-topic "thin" gap (SF-001).

## The autonomy dial (D-E05-1)

`evaluate()` maps each bucket to exactly one action:

| bucket | action | effect |
|---|---|---|
| high-trust | proceed | runs at its declared tier (full autonomy only if TRUSTED + worktree, the E04 AC-3 floor) |
| modify-prone | proceed-supervised | runs, but effective tier downgraded to `supervised` → every tool/irreversible action via `canUseTool` |
| mixed | escalate | parked pre-spawn in `needs-attention`; asks Joshua before starting |
| override-prone / thin | hold | not run autonomously; in the needs-you queue |

E05 never decides if an action is irreversible — "full proceed" leans entirely
on E04's TRUSTED+worktree containment. Lookup resolves the **exact topic** first,
falls back to the **domain** (the part before `/`), then `thin → hold`.

## Runtime safe-list floor (D-E05-8 / SEC-001)

`runtimeGate.shouldAutoApprove` lets a high-trust job auto-approve a tool instead
of escalating — but only for tools on an explicit **allow-list** (Read, Glob,
Grep, NotebookRead, TodoWrite, BashOutput). It is an allow-list, not a deny-list:
any unrecognized tool (Bash/Write/Edit, Task, WebFetch/WebSearch, mcp__*) is
never auto-approved, so the gate fails closed for the long tail. Adding a tool to
`AUTO_APPROVE_TOOLS` widens autonomous auto-approval and is a conscious safety
decision.

## Two hook points, one core (D-E05-7)

`evaluate()` is a pure function `(topic, rollup) → GateVerdict`, used in two
places with the same core:

- **Pre-spawn** — in the daemon (keyless), after `claimNext` + the AC-3 guard in
  `scheduler.tick()`. Parks or downgrades before the session spawns.
- **Runtime** — in the keyed session process, inside the `canUseTool` handler
  (`../claude/utils/permissionHandler.ts`), fed by `HAPPY_JOB_DISPOSITION_TOPIC`.

## Files

- `gate.ts` — the pure `evaluate()` (topic→domain lookup + bucket→action + fail-closed)
- `types.ts` — the rollup/verdict contracts (read-only structured input)
- `rollup.ts` — read-only loader, fails closed to `null`
- `runtimeGate.ts` — the read-only-tool safe-list for the runtime auto-approve
