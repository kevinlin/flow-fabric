# Flow Fabric — Soak Runbook (M5.3)

Runs the daemon 24/7 under launchd for the 7-day G1 soak. KeepAlive restarts
it on any exit; `resumeAll()` recovers instances and in-flight timers (FR-9).

## Install

    pnpm build                     # daemon runs the built dist, not tsx
    sed "s|REPLACE_ME|$HOME|g" ops/launchd/dev.flowfabric.daemon.plist \
      > ~/Library/LaunchAgents/dev.flowfabric.daemon.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.flowfabric.daemon.plist
    curl -s http://127.0.0.1:4400/api/healthz    # → {"ok":true}

Notes:
- `.env` at the repo root supplies `ANTHROPIC_*` (and `CLAUDE_CODE_PATH` if the
  agent SDK needs a pinned binary). launchd's PATH is minimal — if node isn't
  found, add `EnvironmentVariables` → `NODE_BIN` to the plist.
- Optional OTel: add `OTEL_EXPORTER_OTLP_ENDPOINT` to `.env` and keep the
  Jaeger container running. Export failures never affect execution — they only
  log to daemon.err.log.

## Daily check (~5 min)

1. `cd packages/server && node --import tsx scripts/soak-report.ts`
   — verdict per instance; exit 1 on any SILENT-STALL.
2. Open http://127.0.0.1:4400/#/inbox — answer pending user tasks, resolve
   incidents (retry / skip / abort). Incidents are *surfaced* halts and don't
   violate the soak criterion; unresolved ones block the loop, so act same-day.
3. Note the row below. Cycles must grow by 1 per day.

| Day | Date | Cycles | Verdict | Incidents (id → resolution) | Notes |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |

## Mid-soak restart drill (once, ~day 3)

    launchctl kickstart -k gui/$(id -u)/dev.flowfabric.daemon

Then re-run the soak report: the instance must still be a healthy wait and the
next timer must fire at its originally scheduled time (FR-9 in production shape).

## Exit criteria (G1 / success criterion 1)

- ≥ 7 consecutive daily cycles on the real workspace.
- Zero SILENT-STALL verdicts all week.
- Every halt was a modeled end event or a surfaced incident/user task.

## Teardown

    launchctl bootout gui/$(id -u)/dev.flowfabric.daemon
    rm ~/Library/LaunchAgents/dev.flowfabric.daemon.plist
