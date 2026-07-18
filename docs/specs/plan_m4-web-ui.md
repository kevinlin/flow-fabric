# M4 Web UI + Notifier Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The six web pages from design §9 (Definitions, Refine, Instances, Inbox, Dashboards, System) work against the live daemon, covering FR-20..23 and FR-25, and notifications deep-link into the inbox (impl spec M4.1–M4.6).

**Architecture:** Server first, UI second. Tasks 1–8 close the API gaps the UI needs (definition linkage on instances, metrics aggregates, scheduler state, platform logs, SSE event vocabulary, transcript/grill-state/version-list routes, shared DTO types, static SPA serving) — each is a normal TDD server task. Tasks 9–15 build `packages/web`: Vite + React SPA, `bpmn-js` NavigatedViewer for diagram render + token overlay, native `EventSource` for SSE, a small hand-rolled JSON-Schema form (flat schemas only, free-form JSON escape hatch per design §9). Task 16 is the styling pass, docs, and the manual M4 exit gate. Spec: [impl_flow-fabric.md](impl_flow-fabric.md) M4, [design_flow-fabric.md](design_flow-fabric.md) §8, §9.

**Tech Stack:** Node 22, TypeScript (strict, ESM), pnpm workspaces, `fastify` ^5 + `@fastify/static` ^8, `better-sqlite3` ^12, React ^19, `react-router-dom` ^7, `bpmn-js` ^18, Vite ^7, vitest ^3 (+ jsdom ^26, `@testing-library/react` ^16 in web).

## Design Decisions

- **`instances.status = 'waiting'` stays deferred.** The UI derives a "waiting" display label from pending user tasks + armed timers (the M2/M3 deferral said "introduce the status when the UI needs it" — the UI needs the *label*, not the column). Pure function in web, unit-tested; no engine or schema change.
- **No `@rjsf`, no chart library.** Every formSchema the profile produces is a flat object of primitives; a ~90-line `SchemaForm` component plus the JSON escape hatch covers FR-13/design §9 without rjsf's theming surface. Dashboards are SQL aggregates rendered as stat tiles and CSS bars — a chart lib buys nothing at this data volume.
- **Metrics need instance→definition linkage.** `instances` rows never recorded which definition version started them (M2 predates the definition store). Task 1 adds nullable `definition_id`/`version_no` columns with a `PRAGMA table_info` migration guard so existing `~/.flow-fabric` DBs keep working.
- **Scheduler state is in-memory.** `EngineHost` records `expireAt` from the `activity.timer` message content into a map, cleared on `activity.timeout`/`activity.end`. Durable timer state already lives in `engine_state`; the map is just the queryable "now" view and rebuilds on resume because recovery re-emits `activity.timer`. (If a bpmn-engine version stops re-emitting it on resume, fall back to parsing timers out of the recovered state in `resumeAll()` — the Task 3 test will catch it.)
- **Transcript links serve file content by row id.** `GET /api/task-executions/:id/transcript` reads the `transcript_path` stored on the row. No user-supplied paths ever reach `fs` — the path comes only from the DB.
- **Web package uses Bundler resolution.** `moduleResolution: "Bundler"`, extensionless relative imports, `noEmit` (Vite builds; `tsc` typechecks). The server/shared NodeNext `.js`-extension rule does not apply inside `packages/web`.
- **Web imports `@flowfabric/shared` (built dist).** DTO types live in shared; the server pins its row types against them with compile-time assignments (Task 7) instead of refactoring rows out of `store.ts`.

## Global Constraints

- Node ≥ 22, pnpm ≥ 9. All packages `"type": "module"`, TS `strict: true`. Server/shared: `NodeNext` + `.js`-extension local imports. Web: `Bundler` resolution, extensionless imports.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Test databases and workspaces in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))` — never in the repo.
- `pnpm build && pnpm test` stays green after every task; M1–M3 suites untouched and passing. Extend public signatures with optional parameters only.
- Timer arm signal is `activity.timer`, fire signal is `activity.timeout` (never `activity.wait` — M1 finding). `engine.getState()` snapshots stay serialized through the existing promise queue.
- Server vitest `testTimeout: 20000` (already configured); timer fixtures use 2–6 s durations.
- Daemon binds `127.0.0.1` only (no auth, PRD §8); default port 4400 (`FF_PORT`), data dir `~/.flow-fabric` (`FF_DATA_DIR`).
- Web dev needs `pnpm --filter @flowfabric/shared build` once before `vite` (web resolves shared's `dist/`).
- New dependencies limited to: `@fastify/static` (server); `react`, `react-dom`, `react-router-dom`, `bpmn-js` (web deps); `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, `@testing-library/react`, `@types/react`, `@types/react-dom`, `typescript` (web dev deps).

## File Structure

Server (modify): `engine-host/store.ts` (columns, metrics, `getTaskExecution`), `engine-host/engine-host.ts` (timer registry, `incident.resolved` event), `engine-host/failure.ts` (notify copy), `inbox/inbox.ts` (events, notify copy), `notify/notifier.ts` (default link), `definitions/store.ts` (`listVersions`), `api/server.ts` (new routes, DTO shaping, static serving, logger), `daemon.ts` (wiring). Server (create): `logs/ring.ts`.

Shared (create): `src/api/types.ts` (DTOs). Modify: `src/index.ts` (exports).

Web (create, all under `packages/web/`):

```
package.json  vite.config.ts  tsconfig.json  index.html
src/main.tsx  src/App.tsx  src/app.css
src/api/client.ts        # typed fetch wrapper
src/api/sse.ts           # useEventStream hook
src/lib/node-status.ts   # events → per-node overlay status (pure)
src/lib/instance-view.ts # waiting derivation, duration/cost/time formatting (pure)
src/lib/chat.ts          # SDK message → chat text (pure)
src/lib/logs.ts          # pino line parsing (pure)
src/components/BpmnCanvas.tsx   # bpmn-js NavigatedViewer wrapper + markers
src/components/LintPanel.tsx    # lint report rendering (Definitions + Refine)
src/components/SchemaForm.tsx   # JSON-Schema form + JSON escape hatch
src/pages/DefinitionsPage.tsx  src/pages/RefinePage.tsx
src/pages/InstancesPage.tsx    src/pages/InstanceDetailPage.tsx
src/pages/InboxPage.tsx        src/pages/DashboardsPage.tsx  src/pages/SystemPage.tsx
test/*.test.ts(x)        # vitest + jsdom unit/component tests for the pure parts
```

## Task Overview

Dependencies: 2 needs 1; 7 needs 1–3 (pins their types); 8 is independent; 9 needs 7 (DTO imports) and 8 (daemon serves the build); 10–15 need 9; 11 also needs 6 (grill state route); 12 needs 6 (transcript route); 14 needs 2; 15 needs 3–4; 16 needs everything. Tasks 1–6 are parallelizable except 2-after-1.

1. Server — instances record their definition version (+ timestamps exposed)
2. Server — metrics aggregates + `GET /api/metrics/definitions/:id`
3. Server — armed-timer registry + `GET /api/scheduler`
4. Server — platform log ring buffer + `GET /api/logs` + daemon logger
5. Server — SSE event vocabulary + notifier polish (links, instance names)
6. Server — API gap fill: version list, grill session state, transcript
7. Shared — API DTO types; server response shaping + type pins
8. Server — serve the built SPA
9. Web — scaffold: Vite/React/Router, API client, SSE hook, shell
10. Web — Definitions page (upload, versions, lint, start instance)
11. Web — BpmnCanvas + Refine page (grill chat, live lint, save version)
12. Web — Instances pages: live diagram overlay (FR-20) + timeline (FR-21)
13. Web — Inbox page: schema forms, escape hatch, incidents (FR-22)
14. Web — Dashboards page (FR-23)
15. Web — System page (FR-25)
16. Styling pass, docs, M4 exit gate

---

### Task 1: Instances record their definition version

`POST /api/instances` with `definitionId` resolves a version but throws the linkage away; metrics (Task 2) and the Instances page need it, and the UI needs `createdAt`/`updatedAt` which the table already stores but the row type hides.

**Files:**
- Modify: `packages/server/src/engine-host/store.ts`
- Modify: `packages/server/src/engine-host/engine-host.ts` (start opts pass-through)
- Modify: `packages/server/src/api/server.ts` (pass linkage when starting by version)
- Test: `packages/server/test/metrics.test.ts` (create)

**Interfaces:**
- Produces: `InstanceRow` gains `definitionId: string | null; versionNo: number | null; createdAt: number; updatedAt: number`. `InstanceStore.createInstance` opts and `EngineHost.start` opts gain `definitionId?: string; versionNo?: number`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/metrics.test.ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('instance definition linkage', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('records definitionId/versionNo and exposes timestamps', () => {
    const dbPath = path.join(tmp(), 'ff.db');
    const store = new InstanceStore(dbPath);
    stores.push(store);
    store.createInstance('i1', 'n', '<xml/>', { definitionId: 'def-1', versionNo: 3 });
    const row = store.getInstance('i1')!;
    expect(row.definitionId).toBe('def-1');
    expect(row.versionNo).toBe(3);
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.updatedAt).toBeGreaterThanOrEqual(row.createdAt);
    // linkage is optional — M1/M2 callers unchanged
    store.createInstance('i2', 'n', '<xml/>');
    expect(store.getInstance('i2')!.definitionId).toBeNull();
    // migration guard: reopening the same DB must not throw
    const again = new InstanceStore(dbPath);
    stores.push(again);
    expect(again.getInstance('i1')!.versionNo).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test metrics`
Expected: FAIL — `definitionId` does not exist on `InstanceRow` (TS error surfaces as test compile failure).

- [ ] **Step 3: Implement**

In `packages/server/src/engine-host/store.ts`:

```ts
export interface InstanceRow {
  id: string;
  name: string;
  source: string;
  status: InstanceStatus;
  engineState: string | null;
  workspace: string;
  dryRun: boolean;
  stubOverrides: string | null;
  definitionId: string | null;
  versionNo: number | null;
  createdAt: number;
  updatedAt: number;
}
```

```ts
const INSTANCE_COLUMNS = `id, name, source, status, engine_state AS engineState,
  workspace_path AS workspace, dry_run AS dryRun, stub_overrides AS stubOverrides,
  definition_id AS definitionId, version_no AS versionNo,
  created_at AS createdAt, updated_at AS updatedAt`;
```

In the constructor's `CREATE TABLE IF NOT EXISTS instances` DDL add two columns after `stub_overrides TEXT,`:

```sql
        definition_id TEXT,
        version_no INTEGER,
```

After the `this.db.exec(...)` DDL block, add the migration guard for DBs created before M4:

```ts
    const cols = this.db.prepare(`PRAGMA table_info(instances)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'definition_id')) {
      this.db.exec(`ALTER TABLE instances ADD COLUMN definition_id TEXT;
                    ALTER TABLE instances ADD COLUMN version_no INTEGER;`);
    }
```

`createInstance` opts gain the two fields and the INSERT writes them:

```ts
  createInstance(
    id: string,
    name: string,
    source: string,
    opts: {
      workspace?: string;
      dryRun?: boolean;
      stubOverrides?: Record<string, Record<string, unknown>>;
      definitionId?: string;
      versionNo?: number;
    } = {},
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO instances
           (id, name, source, status, engine_state, workspace_path, dry_run, stub_overrides,
            definition_id, version_no, created_at, updated_at)
         VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        source,
        opts.workspace ?? '',
        opts.dryRun ? 1 : 0,
        opts.stubOverrides ? JSON.stringify(opts.stubOverrides) : null,
        opts.definitionId ?? null,
        opts.versionNo ?? null,
        now,
        now,
      );
  }
```

In `packages/server/src/engine-host/engine-host.ts`, `start()` opts gain `definitionId?: string; versionNo?: number` and forward them:

```ts
    this.store.createInstance(opts.id, opts.name, opts.source, {
      workspace: opts.workspace,
      dryRun: opts.dryRun,
      stubOverrides: opts.stubOverrides,
      definitionId: opts.definitionId,
      versionNo: opts.versionNo,
    });
```

In `packages/server/src/api/server.ts`, inside the `if (body.definitionId)` branch remember the resolved version, and pass linkage to `host.start`:

```ts
    let definitionId: string | undefined;
    let versionNo: number | undefined;
    if (body.definitionId) {
      // ...existing resolution code...
      definitionId = body.definitionId;
      versionNo = version.versionNo;
      source = version.xml;
      name = definitions.getDefinition(body.definitionId)?.name ?? name;
    }
```

and in the `host.start({...})` call add `definitionId, versionNo,`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test`
Expected: all suites PASS (metrics + untouched M1–M3).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test/metrics.test.ts
git commit -m "feat(server): instances record definition version; expose timestamps (M4 prep)"
```

---

### Task 2: Metrics aggregates + `GET /api/metrics/definitions/:id`

FR-23 aggregates as SQL over the tables Task 1 linked. Impl gate M4.5: "aggregates match seeded test data".

**Files:**
- Modify: `packages/server/src/engine-host/store.ts`
- Modify: `packages/server/src/api/server.ts`
- Test: `packages/server/test/metrics.test.ts` (extend)

**Interfaces:**
- Consumes: `instances.definition_id` from Task 1.
- Produces: `DefinitionMetrics` (exported from `store.ts`), `InstanceStore.metricsForDefinition(definitionId: string): DefinitionMetrics`, route `GET /api/metrics/definitions/:id`.

- [ ] **Step 1: Write the failing test** (append to `metrics.test.ts`)

```ts
import { buildApi } from '../src/api/server.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';

describe('definition metrics', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  function seed() {
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    // two finished runs, one aborted, one still running
    for (const [id, status] of [
      ['a', 'completed'],
      ['b', 'terminated'],
      ['c', 'aborted'],
      ['d', 'running'],
    ] as const) {
      store.createInstance(id, 'rfp', '<xml/>', { definitionId: 'def-1', versionNo: 1 });
      if (status !== 'running') store.setStatus(id, status);
    }
    // unrelated definition must not leak in
    store.createInstance('x', 'other', '<xml/>', { definitionId: 'def-2', versionNo: 1 });
    // task executions with cost on run a
    const e1 = store.startTaskExecution('a', 'audit', 'agent', 1, {});
    store.finishTaskExecution(e1, { status: 'completed', output: {}, costUsd: 0.5 });
    const e2 = store.startTaskExecution('a', 'audit', 'agent', 2, {});
    store.finishTaskExecution(e2, { status: 'completed', output: {}, costUsd: 0.25 });
    const e3 = store.startTaskExecution('b', 'review', 'code', 1, {});
    store.finishTaskExecution(e3, { status: 'completed', output: {} });
    store.createIncident('c', 'audit', 'boom');
    return store;
  }

  it('aggregates runs, success rate, cost, and incidents per definition', () => {
    const m = seed().metricsForDefinition('def-1');
    expect(m.runs).toEqual({ total: 4, completed: 1, terminated: 1, aborted: 1, error: 0, active: 1 });
    expect(m.successRate).toBeCloseTo(2 / 3); // finished = completed+terminated+aborted+error
    expect(m.durationsMs).toHaveLength(2); // finished successfully only
    expect(m.costPerRun.find((r) => r.instanceId === 'a')!.costUsd).toBeCloseTo(0.75);
    expect(m.costPerTask).toEqual([
      { nodeId: 'audit', runs: 2, totalCostUsd: 0.75, avgDurationMs: expect.any(Number) },
      { nodeId: 'review', runs: 1, totalCostUsd: 0, avgDurationMs: expect.any(Number) },
    ]);
    expect(m.incidents).toEqual({ total: 1, open: 1 });
  });

  it('serves metrics over HTTP', async () => {
    const store = seed();
    let inbox!: Inbox;
    const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
    inbox = new Inbox(store, host, { notify: async () => {} });
    const app = buildApi({ store, host, inbox });
    const res = await app.inject({ method: 'GET', url: '/api/metrics/definitions/def-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs.total).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test metrics`
Expected: FAIL — `metricsForDefinition` does not exist.

- [ ] **Step 3: Implement**

Append to `packages/server/src/engine-host/store.ts`:

```ts
export interface DefinitionMetrics {
  runs: { total: number; completed: number; terminated: number; aborted: number; error: number; active: number };
  /** (completed+terminated) / all finished runs; null when nothing finished yet. */
  successRate: number | null;
  /** Wall-clock duration of each successfully finished run (completed/terminated). */
  durationsMs: number[];
  costPerRun: Array<{ instanceId: string; costUsd: number }>;
  costPerTask: Array<{ nodeId: string; runs: number; totalCostUsd: number; avgDurationMs: number | null }>;
  incidents: { total: number; open: number };
}
```

and the method on `InstanceStore`:

```ts
  metricsForDefinition(definitionId: string): DefinitionMetrics {
    const byStatus = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM instances WHERE definition_id = ? GROUP BY status`)
      .all(definitionId) as Array<{ status: InstanceStatus; n: number }>;
    const count = (s: InstanceStatus) => byStatus.find((r) => r.status === s)?.n ?? 0;
    const completed = count('completed');
    const terminated = count('terminated');
    const aborted = count('aborted');
    const error = count('error');
    const total = byStatus.reduce((sum, r) => sum + r.n, 0);
    const finished = completed + terminated + aborted + error;

    const durationsMs = (
      this.db
        .prepare(
          `SELECT updated_at - created_at AS d FROM instances
           WHERE definition_id = ? AND status IN ('completed', 'terminated') ORDER BY created_at`,
        )
        .all(definitionId) as Array<{ d: number }>
    ).map((r) => r.d);

    const costPerRun = this.db
      .prepare(
        `SELECT i.id AS instanceId, COALESCE(SUM(te.cost_usd), 0) AS costUsd
         FROM instances i LEFT JOIN task_executions te ON te.instance_id = i.id
         WHERE i.definition_id = ? GROUP BY i.id ORDER BY i.created_at`,
      )
      .all(definitionId) as Array<{ instanceId: string; costUsd: number }>;

    const costPerTask = this.db
      .prepare(
        `SELECT te.node_id AS nodeId, COUNT(*) AS runs,
                COALESCE(SUM(te.cost_usd), 0) AS totalCostUsd,
                AVG(te.ended_at - te.started_at) AS avgDurationMs
         FROM task_executions te JOIN instances i ON i.id = te.instance_id
         WHERE i.definition_id = ? AND te.status = 'completed'
         GROUP BY te.node_id ORDER BY te.node_id`,
      )
      .all(definitionId) as DefinitionMetrics['costPerTask'];

    const inc = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(inc.status = 'open'), 0) AS open
         FROM incidents inc JOIN instances i ON i.id = inc.instance_id
         WHERE i.definition_id = ?`,
      )
      .get(definitionId) as { total: number; open: number };

    return {
      runs: { total, completed, terminated, aborted, error, active: total - finished },
      successRate: finished === 0 ? null : (completed + terminated) / finished,
      durationsMs,
      costPerRun,
      costPerTask,
      incidents: inc,
    };
  }
```

In `packages/server/src/api/server.ts` (with the always-on routes, before the `if (definitions)` block):

```ts
  app.get('/api/metrics/definitions/:id', async (req) =>
    store.metricsForDefinition((req.params as { id: string }).id),
  );
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test/metrics.test.ts
git commit -m "feat(server): per-definition metrics aggregates + API route (FR-23)"
```

---

### Task 3: Armed-timer registry + `GET /api/scheduler`

FR-25 "visible scheduler state (next timer firings)". The probe confirmed `activity.timer` carries `content.expireAt` (Date) and `content.timeout` (ms); capture it into a map, clear on `activity.timeout`/`activity.end`, expose it. Impl gate M4.6: "24h timer shows correct next-fire time".

**Files:**
- Modify: `packages/server/src/engine-host/engine-host.ts`
- Modify: `packages/server/src/api/server.ts`
- Test: `packages/server/test/scheduler.test.ts` (create)

**Interfaces:**
- Produces: `EngineHost.scheduledTimers(): ArmedTimer[]` where `ArmedTimer = { instanceId: string; nodeId: string; expireAt: number }`; route `GET /api/scheduler` → `{ timers: ArmedTimer[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/scheduler.test.ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

// loop.bpmn: gateway loop around a 2s duration timer (rfp-daily shape).
const loop = readFileSync(new URL('./fixtures/loop.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('scheduler state', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('lists an armed timer while waiting and clears it after firing', async () => {
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    const host = new EngineHost(store, {});
    const completion = host.start({ id: 'i1', name: 'loop', source: loop, workspace: tmp() });

    let armed: ReturnType<typeof host.scheduledTimers> = [];
    for (let i = 0; i < 50 && armed.length === 0; i++) {
      armed = host.scheduledTimers();
      if (armed.length === 0) await sleep(50);
    }
    expect(armed[0].instanceId).toBe('i1');
    expect(armed[0].expireAt).toBeGreaterThan(Date.now() - 1000);

    await completion; // loop runs to its end event
    expect(host.scheduledTimers()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test scheduler`
Expected: FAIL — `host.scheduledTimers` is not a function.

- [ ] **Step 3: Implement**

In `packages/server/src/engine-host/engine-host.ts` add the type near the top exports:

```ts
export interface ArmedTimer {
  instanceId: string;
  nodeId: string;
  expireAt: number;
}
```

Add `activity.timeout` to the events the listener watches (it does not need a snapshot but the registry needs it):

```ts
const SNAPSHOT_EVENTS = ['activity.start', 'activity.wait', 'activity.timer', 'activity.end'];
const TIMER_CLEAR_EVENTS = ['activity.timeout', 'activity.end', 'activity.error'];
```

Add the field on the class:

```ts
  private timers = new Map<string, ArmedTimer>();
```

Add the accessor:

```ts
  /** Armed duration timers across all running instances (FR-25 scheduler view). */
  scheduledTimers(): ArmedTimer[] {
    return [...this.timers.values()].sort((a, b) => a.expireAt - b.expireAt);
  }
```

In `run()`, inside the `for (const event of SNAPSHOT_EVENTS)` listener, after the existing `snapshot()` call, capture the timer arm. The `activity.timer` api carries `content.expireAt`:

```ts
        if (event === 'activity.timer') {
          const content = (api as { content?: { expireAt?: string | number | Date } }).content;
          const expireAt = content?.expireAt ? new Date(content.expireAt).getTime() : Date.now();
          this.timers.set(`${id}:${api.id}`, { instanceId: id, nodeId: api.id, expireAt });
        }
```

Register a second listener loop for the clear events (these are not in `SNAPSHOT_EVENTS`, so add after that loop):

```ts
    for (const event of TIMER_CLEAR_EVENTS) {
      listener.on(event, (api: { id: string }) => this.timers.delete(`${id}:${api.id}`));
    }
```

In the `finally` of `run()`, drop any stragglers for this instance so a stopped/aborted engine leaves no ghost timers:

```ts
    } finally {
      for (const key of this.timers.keys()) if (key.startsWith(`${id}:`)) this.timers.delete(key);
      this.running.delete(id);
    }
```

In `packages/server/src/api/server.ts`, with the always-on routes:

```ts
  app.get('/api/scheduler', async () => ({ timers: host.scheduledTimers() }));
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test`
Expected: all PASS (scheduler + untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test/scheduler.test.ts
git commit -m "feat(server): armed-timer registry + /api/scheduler (FR-25)"
```

---

### Task 4: Platform log ring buffer + `GET /api/logs` + daemon logger

FR-25 "structured platform logs". Fastify already logs via pino; capture the daemon's pino stream into a bounded in-memory ring so the System page can show recent lines without a file tail.

**Files:**
- Create: `packages/server/src/logs/ring.ts`
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/daemon.ts`
- Test: `packages/server/test/logs.test.ts` (create)

**Interfaces:**
- Produces: `LogRing` class (`{ write(line: string): void; lines(limit?: number): string[] }`) usable as a pino stream (`write` matches Node's writable-ish contract pino needs); `ApiDeps` gains optional `logRing?: LogRing`; route `GET /api/logs?limit=n` → `{ lines: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/logs.test.ts
import { describe, it, expect } from 'vitest';
import { LogRing } from '../src/logs/ring.js';

describe('LogRing', () => {
  it('keeps only the last N lines and returns newest-last', () => {
    const ring = new LogRing(3);
    for (const n of ['a', 'b', 'c', 'd']) ring.write(`${n}\n`);
    expect(ring.lines()).toEqual(['b', 'c', 'd']);
    expect(ring.lines(2)).toEqual(['c', 'd']);
  });

  it('splits multi-line writes and ignores blank lines', () => {
    const ring = new LogRing(10);
    ring.write('one\ntwo\n');
    ring.write('\n');
    ring.write('three\n');
    expect(ring.lines()).toEqual(['one', 'two', 'three']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test logs`
Expected: FAIL — cannot find `../src/logs/ring.js`.

- [ ] **Step 3: Implement**

Create `packages/server/src/logs/ring.ts`:

```ts
/** Bounded in-memory log buffer. Acts as a pino stream: pino calls write(chunk). */
export class LogRing {
  private buf: string[] = [];
  constructor(private capacity = 500) {}

  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.buf.push(trimmed);
      if (this.buf.length > this.capacity) this.buf.shift();
    }
  }

  /** Newest-last. `limit` returns the most recent `limit` lines. */
  lines(limit?: number): string[] {
    return limit === undefined ? [...this.buf] : this.buf.slice(-limit);
  }
}
```

In `packages/server/src/api/server.ts`, extend `ApiDeps` and add the route:

```ts
import type { LogRing } from '../logs/ring.js';
```

```ts
export interface ApiDeps {
  store: InstanceStore;
  host: EngineHost;
  inbox: Inbox;
  definitions?: DefinitionStore;
  grill?: GrillHost;
  logRing?: LogRing;
}
```

Destructure `logRing` in `buildApi({ ... })` and add:

```ts
  app.get('/api/logs', async (req) => {
    const { limit } = req.query as { limit?: string };
    return { lines: logRing?.lines(limit ? Number(limit) : undefined) ?? [] };
  });
```

In `packages/server/src/daemon.ts`, create the ring, feed pino from it, and pass it in. Replace the `const app = buildApi(...)` line region:

```ts
import { LogRing } from './logs/ring.js';
```

```ts
const logRing = new LogRing();
const app = buildApi({ store, host, inbox, definitions, grill, logRing });
```

and construct Fastify with a logger that tees into the ring. Since `buildApi` owns `Fastify()`, add an optional logger stream there: change the `Fastify()` call to accept the ring:

In `server.ts`:

```ts
  const app = Fastify(
    logRing ? { logger: { level: 'info', stream: logRing } } : {},
  );
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test/logs.test.ts
git commit -m "feat(server): platform log ring buffer + /api/logs (FR-25)"
```

---

### Task 5: SSE event vocabulary + notifier polish

Design §8 names lifecycle SSE event types (`instance.completed`, `incident.raised/resolved`, `usertask.created/submitted`). M2/M3 emit raw `activity.*` and a few `instance.*`/`incident.raised` events but the set is incomplete for a live UI, and notifications carry no deep link (FR-13 "don't rely on polling" implies the notification opens the task). Fill the gaps and give the notifier a default inbox link.

**Files:**
- Modify: `packages/server/src/engine-host/engine-host.ts` (`incident.resolved` on resolve)
- Modify: `packages/server/src/inbox/inbox.ts` (`usertask.created` / `usertask.submitted` events; notify link)
- Modify: `packages/server/src/engine-host/failure.ts` (notify link + instance name in copy)
- Modify: `packages/server/src/notify/notifier.ts` (default link constant)
- Test: `packages/server/test/events-vocab.test.ts` (create)

**Interfaces:**
- Consumes: `InstanceStore.appendEvent(instanceId, type, elementId?, detail?)` (existing).
- Produces: events `usertask.created`, `usertask.submitted`, `incident.resolved` appended to the log (and thus fanned out over SSE). `Inbox` constructor gains optional `inboxUrl?: string` used as the notification deep link. No signature breaks — the arg is optional.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/events-vocab.test.ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('SSE event vocabulary', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('emits usertask.created and usertask.submitted', async () => {
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    let inbox!: Inbox;
    const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
    inbox = new Inbox(store, host, { notify: async () => {} });
    host.start({ id: 'i1', name: 'c', source: contracts, workspace: tmp(), dryRun: true, variables: { deadline: 'x' } });

    let task: ReturnType<typeof inbox.listPending>[number] | undefined;
    for (let i = 0; i < 100 && !task; i++) { task = inbox.listPending()[0]; if (!task) await sleep(50); }
    expect(store.listEvents('i1').some((e) => e.type === 'usertask.created')).toBe(true);

    await inbox.submit(task!.id, { approved: true });
    expect(store.listEvents('i1').some((e) => e.type === 'usertask.submitted')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test events-vocab`
Expected: FAIL — no `usertask.created` event in the log.

- [ ] **Step 3: Implement**

In `packages/server/src/notify/notifier.ts` add a shared default link constant (the daemon serves the SPA at `/`, inbox route is `/#/inbox`):

```ts
export const DEFAULT_INBOX_LINK = 'http://127.0.0.1:4400/#/inbox';
```

In `packages/server/src/inbox/inbox.ts`, the constructor gains an optional inbox URL, `handleWait` appends `usertask.created` and passes the link, and `submit` appends `usertask.submitted`:

```ts
import { DEFAULT_INBOX_LINK } from '../notify/notifier.js';
```

```ts
  constructor(
    private store: InstanceStore,
    private host: EngineHost,
    private notifier: Notifier,
    private inboxUrl: string = DEFAULT_INBOX_LINK,
  ) {}
```

In `handleWait`, after `createUserTask(...)`:

```ts
    this.store.appendEvent(info.instanceId, 'usertask.created', info.nodeId);
    void this.notifier.notify(
      'Flow Fabric: task waiting',
      `${info.nodeId} needs your input`,
      this.inboxUrl,
    );
```

(remove the old `notify(...)` call — it becomes this one.)

In `submit`, after `submitUserTask(...)`:

```ts
    this.store.appendEvent(task.instanceId, 'usertask.submitted', task.nodeId);
```

In `packages/server/src/engine-host/failure.ts`, give the incident notification the inbox link. Add a module constant import and pass it:

```ts
import { DEFAULT_INBOX_LINK } from '../notify/notifier.js';
```

```ts
        void deps.notifier?.notify(
          'Flow Fabric incident',
          `${nodeId} failed after ${contract.retries + 1} attempts`,
          DEFAULT_INBOX_LINK,
        );
```

In `packages/server/src/engine-host/engine-host.ts`, `resolveIncident` appends `incident.resolved` on each successful resolution. In the `skip` branch after `this.store.resolveIncident(incidentId, 'skip')`:

```ts
      this.store.appendEvent(incident.instanceId, 'incident.resolved', incident.nodeId, 'skip');
```

In the `retry` branch after `this.store.resolveIncident(incidentId, 'retry')`:

```ts
      this.store.appendEvent(incident.instanceId, 'incident.resolved', incident.nodeId, 'retry');
```

In the `abort` branch after `this.store.resolveIncident(incidentId, 'abort')`:

```ts
      this.store.appendEvent(incident.instanceId, 'incident.resolved', incident.nodeId, 'abort');
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test/events-vocab.test.ts
git commit -m "feat(server): usertask/incident SSE events + notifier deep links (FR-13)"
```

---

### Task 6: API gap fill — version list, grill session state, transcript

The UI needs three reads the API lacks: all versions of a definition (Definitions page version list), a grill session's current XML + lint (Refine page loads state without replaying chat), and a task execution's transcript (timeline transcript link, FR-21).

**Files:**
- Modify: `packages/server/src/definitions/store.ts` (`listVersions`)
- Modify: `packages/server/src/grill/session.ts` (already exposes `xml`/`lintReport` getters — verify)
- Modify: `packages/server/src/engine-host/store.ts` (`getTaskExecution`)
- Modify: `packages/server/src/api/server.ts` (three routes)
- Test: `packages/server/test/api-reads.test.ts` (create)

**Interfaces:**
- Produces:
  - `DefinitionStore.listVersions(definitionId): Array<{ versionNo: number; deployable: boolean; createdAt: number }>`
  - `InstanceStore.getTaskExecution(id: number): TaskExecutionRow | undefined`
  - Routes: `GET /api/definitions/:id/versions` → `{ versions: [...] }`; `GET /api/grill/sessions/:id` → `{ sessionId, xml, lint }`; `GET /api/task-executions/:id/transcript` → transcript file body (`text/plain`) or 404.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/api-reads.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { DefinitionStore } from '../src/definitions/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { buildApi } from '../src/api/server.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
const MINIMAL = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"><process id="p"/></definitions>';

function build() {
  const dbPath = path.join(tmp(), 'ff.db');
  const store = new InstanceStore(dbPath);
  const definitions = new DefinitionStore(dbPath);
  let inbox!: Inbox;
  const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
  inbox = new Inbox(store, host, { notify: async () => {} });
  const app = buildApi({ store, host, inbox, definitions });
  return { store, definitions, app };
}

describe('UI read routes', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('lists versions of a definition', async () => {
    const { store, definitions, app } = build();
    stores.push(store);
    const { id } = definitions.upload('rfp', MINIMAL);
    definitions.saveVersion(id, MINIMAL);
    const res = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions` });
    expect(res.statusCode).toBe(200);
    expect(res.json().versions.map((v: any) => v.versionNo)).toEqual([1, 2]);
  });

  it('serves a transcript file by execution id', async () => {
    const { store, app } = build();
    stores.push(store);
    store.createInstance('i1', 'n', '<xml/>');
    const p = path.join(tmp(), 't.jsonl');
    writeFileSync(p, '{"hello":1}\n');
    const execId = store.startTaskExecution('i1', 'audit', 'agent', 1, {});
    store.finishTaskExecution(execId, { status: 'completed', output: {}, transcriptPath: p });
    const res = await app.inject({ method: 'GET', url: `/api/task-executions/${execId}/transcript` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hello');
    const missing = await app.inject({ method: 'GET', url: `/api/task-executions/9999/transcript` });
    expect(missing.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test api-reads`
Expected: FAIL — `/api/definitions/:id/versions` returns 404 (route absent).

- [ ] **Step 3: Implement**

In `packages/server/src/definitions/store.ts`:

```ts
  listVersions(definitionId: string): Array<{ versionNo: number; deployable: boolean; createdAt: number }> {
    return this.db
      .prepare(
        `SELECT version_no AS versionNo, deployable, created_at AS createdAt
         FROM definition_versions WHERE definition_id = ? ORDER BY version_no`,
      )
      .all(definitionId)
      .map((r: any) => ({ versionNo: r.versionNo, deployable: !!r.deployable, createdAt: r.createdAt }));
  }
```

In `packages/server/src/engine-host/store.ts`:

```ts
  getTaskExecution(id: number): TaskExecutionRow | undefined {
    return this.db
      .prepare(`SELECT ${TASK_EXECUTION_COLUMNS} FROM task_executions WHERE id = ?`)
      .get(id) as TaskExecutionRow | undefined;
  }
```

In `packages/server/src/api/server.ts` add `import { readFileSync } from 'node:fs';` at the top, then the transcript route (always-on) and the versions route (inside `if (definitions)`):

```ts
  app.get('/api/task-executions/:id/transcript', async (req, reply) => {
    const exec = store.getTaskExecution(Number((req.params as { id: string }).id));
    if (!exec?.transcriptPath) return reply.code(404).send({ error: 'no transcript' });
    try {
      reply.header('content-type', 'text/plain');
      return readFileSync(exec.transcriptPath, 'utf8');
    } catch {
      return reply.code(404).send({ error: 'transcript file missing' });
    }
  });
```

Inside `if (definitions) { ... }`:

```ts
    app.get('/api/definitions/:id/versions', async (req) => ({
      versions: definitions.listVersions((req.params as { id: string }).id),
    }));
```

Inside `if (grill) { ... }`, a state read (the session already exposes `xml` and `lintReport` getters):

```ts
    app.get('/api/grill/sessions/:id', async (req, reply) => {
      const session = grill.get((req.params as { id: string }).id);
      if (!session) return reply.code(404).send({ error: 'no such session' });
      return { sessionId: session.id, xml: session.xml, lint: session.lintReport };
    });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test/api-reads.test.ts
git commit -m "feat(server): version list, grill-state, and transcript read routes (FR-21)"
```

---

### Task 7: Shared API DTO types + server response shaping

The web package needs typed API responses. Define DTOs in `@flowfabric/shared`, shape the instance-detail response to include a `waiting`-derivable status the UI can read, and pin the server row types against the DTOs with compile-time assignment checks so drift breaks the build.

**Files:**
- Create: `packages/shared/src/api/types.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/server/src/api/server.ts` (add `_dtoCheck` assignment guards — no runtime change)
- Test: `packages/shared/test/api-types.test.ts` (create)

**Interfaces:**
- Produces (all exported from `@flowfabric/shared`): `InstanceDto`, `TimelineEntryDto`, `EventDto`, `InstanceDetailDto`, `InboxDto`, `UserTaskDto`, `IncidentDto`, `DefinitionDto`, `VersionSummaryDto`, `SchedulerDto`, `ArmedTimerDto`, `DefinitionMetricsDto`, `LogsDto`. These mirror the server row/return shapes; the server casts its responses to them.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/api-types.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type { InstanceDto, InstanceDetailDto, DefinitionMetricsDto } from '../src/index.js';

describe('API DTOs', () => {
  it('InstanceDto carries status and definition linkage', () => {
    expectTypeOf<InstanceDto>().toHaveProperty('status');
    expectTypeOf<InstanceDto>().toHaveProperty('definitionId');
    expectTypeOf<InstanceDto['definitionId']>().toEqualTypeOf<string | null>();
  });
  it('InstanceDetailDto bundles timeline + events', () => {
    expectTypeOf<InstanceDetailDto>().toHaveProperty('instance');
    expectTypeOf<InstanceDetailDto>().toHaveProperty('timeline');
    expectTypeOf<InstanceDetailDto>().toHaveProperty('events');
  });
  it('DefinitionMetricsDto exposes runs + successRate', () => {
    expectTypeOf<DefinitionMetricsDto['successRate']>().toEqualTypeOf<number | null>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/shared test api-types`
Expected: FAIL — module `../src/api/types.js` / exports not found (compile error).

- [ ] **Step 3: Implement**

Create `packages/shared/src/api/types.ts`:

```ts
export type InstanceStatusDto =
  | 'running' | 'completed' | 'terminated' | 'stopped' | 'error' | 'incident' | 'aborted';

export interface InstanceDto {
  id: string;
  name: string;
  status: InstanceStatusDto;
  workspace: string;
  dryRun: boolean;
  definitionId: string | null;
  versionNo: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TimelineEntryDto {
  id: number;
  nodeId: string;
  actor: 'agent' | 'code' | 'user';
  attempt: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  endedAt: number | null;
  resolvedInputs: string;
  output: string | null;
  error: string | null;
  costUsd: number | null;
  tokenUsage: string | null;
  transcriptPath: string | null;
}

export interface EventDto {
  seq: number;
  type: string;
  elementId: string | null;
  detail: string | null;
  ts: number;
}

export interface InstanceDetailDto {
  instance: InstanceDto;
  timeline: TimelineEntryDto[];
  events: EventDto[];
}

export interface UserTaskDto {
  id: number;
  instanceId: string;
  nodeId: string;
  formSchema: string;
  status: 'pending' | 'submitted';
}

export interface IncidentDto {
  id: number;
  instanceId: string;
  nodeId: string;
  reason: string;
  status: 'open' | 'resolved';
}

export interface InboxDto {
  userTasks: UserTaskDto[];
  incidents: IncidentDto[];
}

export interface DefinitionDto {
  id: string;
  name: string;
  createdAt: number;
}

export interface VersionSummaryDto {
  versionNo: number;
  deployable: boolean;
  createdAt: number;
}

export interface ArmedTimerDto {
  instanceId: string;
  nodeId: string;
  expireAt: number;
}

export interface SchedulerDto {
  timers: ArmedTimerDto[];
}

export interface DefinitionMetricsDto {
  runs: { total: number; completed: number; terminated: number; aborted: number; error: number; active: number };
  successRate: number | null;
  durationsMs: number[];
  costPerRun: Array<{ instanceId: string; costUsd: number }>;
  costPerTask: Array<{ nodeId: string; runs: number; totalCostUsd: number; avgDurationMs: number | null }>;
  incidents: { total: number; open: number };
}

export interface LogsDto {
  lines: string[];
}
```

Append to `packages/shared/src/index.ts`:

```ts
export type {
  InstanceStatusDto,
  InstanceDto,
  TimelineEntryDto,
  EventDto,
  InstanceDetailDto,
  UserTaskDto,
  IncidentDto,
  InboxDto,
  DefinitionDto,
  VersionSummaryDto,
  ArmedTimerDto,
  SchedulerDto,
  DefinitionMetricsDto,
  LogsDto,
} from './api/types.js';
```

In `packages/server/src/api/server.ts`, add compile-time pins near the top (after imports) so server rows and DTOs cannot drift. These are type-only, no runtime effect:

```ts
import type {
  DefinitionMetricsDto,
  InstanceDetailDto,
  SchedulerDto,
} from '@flowfabric/shared';
import type { DefinitionMetrics } from '../engine-host/store.js';

// Compile-time guards: server return shapes must remain assignable to the DTOs.
type _MetricsPin = DefinitionMetrics extends DefinitionMetricsDto ? true : never;
type _SchedulerPin = { timers: ReturnType<EngineHost['scheduledTimers']> } extends SchedulerDto ? true : never;
const _dtoPins: [_MetricsPin, _SchedulerPin] = [true, true];
void _dtoPins;
```

Rebuild shared so the server and web resolve the new exports:

```bash
pnpm --filter @flowfabric/shared build
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/shared test && pnpm --filter @flowfabric/server test && pnpm --filter @flowfabric/server build`
Expected: all PASS; server build clean (pins hold).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src packages/shared/test/api-types.test.ts packages/server/src/api/server.ts
git commit -m "feat(shared): API DTO types; pin server responses against them"
```

---

### Task 8: Serve the built SPA from the daemon

Impl gate M4.1 "pages load against live server". The daemon serves `packages/web/dist` at `/`, with an SPA fallback so client-side routes (`/#/...` hash routes need no fallback, but a history-mode fallback is cheap and future-proofs) resolve to `index.html`. API routes keep priority because they are registered first and `@fastify/static` only serves unmatched GETs.

**Files:**
- Modify: `packages/server/package.json` (add `@fastify/static`)
- Modify: `packages/server/src/api/server.ts` (register static when a web root exists)
- Modify: `packages/server/src/daemon.ts` (compute + pass web root)
- Test: `packages/server/test/static.test.ts` (create)

**Interfaces:**
- Produces: `ApiDeps` gains optional `webRoot?: string`; when set and present on disk, GETs not matching `/api/*` serve files from it, falling back to `index.html`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @flowfabric/server add @fastify/static@^8
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/test/static.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { buildApi } from '../src/api/server.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('static SPA serving', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('serves index.html at / and keeps /api working', async () => {
    const webRoot = tmp();
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Flow Fabric</title>');
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    let inbox!: Inbox;
    const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
    inbox = new Inbox(store, host, { notify: async () => {} });
    const app = buildApi({ store, host, inbox, webRoot });

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Flow Fabric');

    const health = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(health.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test static`
Expected: FAIL — `GET /` returns 404 (no static handler).

- [ ] **Step 4: Implement**

In `packages/server/src/api/server.ts`:

```ts
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
```

Add `webRoot?: string` to `ApiDeps`, destructure it, and register static as the **last** thing before `return app` so API routes win. `buildApi` stays synchronous: `app.register(...)` without `await` queues the plugin, and Fastify loads it during `ready()` (which both `app.inject` and `app.listen` call internally), so existing callers are untouched.

```ts
  if (webRoot && existsSync(webRoot)) {
    // wildcard:false — static serves only exact file paths (index.html, /assets/*);
    // everything else falls through to the notFoundHandler for the SPA fallback.
    // With the default wildcard:true, a `GET /*` route would swallow unmatched
    // /api/* requests before the handler runs.
    app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }
```

In `packages/server/src/daemon.ts`, compute the web root relative to the daemon file and pass it:

```ts
import { fileURLToPath } from 'node:url';
```

```ts
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const app = buildApi({ store, host, inbox, definitions, grill, logRing, webRoot });
```

(From `packages/server/src/daemon.ts`, `../../web/dist` resolves to `packages/web/dist`. When running via `tsx` from source that path holds; the built `dist/daemon.js` sits one level deeper, so adjust to `../../../web/dist` if a compiled run is ever used — the dev entrypoint runs from source, so `../../web/dist` is correct for `pnpm dev`.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @flowfabric/server test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json packages/server/src pnpm-lock.yaml packages/server/test/static.test.ts
git commit -m "feat(server): serve built SPA with API-priority routing (M4.1)"
```

---

### Task 9: Web scaffold — Vite/React/Router, API client, SSE hook, shell

Replace the `packages/web` placeholder with a real Vite + React SPA: build tooling, a typed API client over the DTOs, an `EventSource` hook, and the app shell with hash-router navigation. Impl gate M4.1: "pages load against live server".

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/vite.config.ts`, `packages/web/tsconfig.json`, `packages/web/index.html`
- Create: `packages/web/src/main.tsx`, `src/App.tsx`, `src/app.css`
- Create: `packages/web/src/api/client.ts`, `src/api/sse.ts`
- Test: `packages/web/test/client.test.ts`

**Interfaces:**
- Consumes: DTOs from `@flowfabric/shared` (Task 7).
- Produces: `api` object (typed methods per endpoint), `useEventStream(path, onEvent)` hook, `<App/>` with routes for all six pages.

- [ ] **Step 1: Dependencies + config**

Replace `packages/web/package.json`:

```json
{
  "name": "@flowfabric/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -p . --noEmit"
  },
  "dependencies": {
    "@flowfabric/shared": "workspace:*",
    "bpmn-js": "^18",
    "react": "^19",
    "react-dom": "^19",
    "react-router-dom": "^7"
  },
  "devDependencies": {
    "@testing-library/react": "^16",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^5",
    "jsdom": "^26",
    "typescript": "^5",
    "vite": "^7",
    "vitest": "^3"
  }
}
```

Install:

```bash
pnpm install
```

Create `packages/web/vite.config.ts` (dev proxy sends `/api` to the daemon so the SPA runs on Vite's port during development):

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4400' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
```

Create `packages/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "declaration": false,
    "types": ["vitest/globals", "node"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

Create `packages/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Flow Fabric</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/web/test/client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api/client';

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('GETs instances and returns the array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ instances: [{ id: 'i1', status: 'running' }] }),
      { headers: { 'content-type': 'application/json' } },
    )));
    const rows = await api.listInstances();
    expect(rows[0].id).toBe('i1');
    expect(fetch).toHaveBeenCalledWith('/api/instances', expect.objectContaining({ method: 'GET' }));
  });

  it('POSTs a user-task submit with a JSON body', async () => {
    const spy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', spy);
    await api.submitUserTask(7, { approved: true });
    expect(spy).toHaveBeenCalledWith('/api/user-tasks/7/submit', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ vars: { approved: true } }),
    }));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/web test client`
Expected: FAIL — cannot resolve `../src/api/client`.

- [ ] **Step 4: Implement the client**

Create `packages/web/src/api/client.ts`:

```ts
import type {
  InstanceDto, InstanceDetailDto, InboxDto, DefinitionDto, VersionSummaryDto,
  SchedulerDto, DefinitionMetricsDto, LogsDto, LintReport,
} from '@flowfabric/shared';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { method: 'GET', ...init });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return req<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface StartInstanceBody {
  definitionId?: string;
  version?: number;
  source?: string;
  name?: string;
  workspacePath: string;
  dryRun?: boolean;
  inputs?: Record<string, unknown>;
  stubOverrides?: Record<string, Record<string, unknown>>;
}

export const api = {
  listInstances: () => req<{ instances: InstanceDto[] }>('/api/instances').then((r) => r.instances),
  getInstance: (id: string) => req<InstanceDetailDto>(`/api/instances/${id}`),
  startInstance: (body: StartInstanceBody) => post<{ id: string }>('/api/instances', body),
  abortInstance: (id: string) => post<void>(`/api/instances/${id}/abort`),

  getInbox: () => req<InboxDto>('/api/inbox'),
  submitUserTask: (id: number, vars: Record<string, unknown>) =>
    post<void>(`/api/user-tasks/${id}/submit`, { vars }),
  resolveIncident: (id: number, action: 'retry' | 'skip' | 'abort', output?: Record<string, unknown>) =>
    post<void>(`/api/incidents/${id}/resolve`, { action, output }),

  listDefinitions: () => req<{ definitions: DefinitionDto[] }>('/api/definitions').then((r) => r.definitions),
  uploadDefinition: (name: string, xml: string) => post<{ id: string; versionNo: number }>('/api/definitions', { name, xml }),
  listVersions: (id: string) => req<{ versions: VersionSummaryDto[] }>(`/api/definitions/${id}/versions`).then((r) => r.versions),
  getVersion: (id: string, v: number | 'latest') =>
    req<{ definitionId: string; versionNo: number; xml: string; lintReport: LintReport | null; deployable: boolean }>(
      `/api/definitions/${id}/versions/${v}`,
    ),
  lintVersion: (id: string, v: number | 'latest') => post<LintReport>(`/api/definitions/${id}/versions/${v}/lint`),

  startGrill: (definitionId: string) => post<{ sessionId: string; lint: LintReport }>('/api/grill/sessions', { definitionId }),
  getGrill: (sessionId: string) => req<{ sessionId: string; xml: string; lint: LintReport }>(`/api/grill/sessions/${sessionId}`),
  sendGrill: (sessionId: string, text: string) => post<{ accepted: boolean }>(`/api/grill/sessions/${sessionId}/messages`, { text }),
  saveGrillVersion: (sessionId: string) => post<{ versionNo: number; deployable: boolean }>(`/api/grill/sessions/${sessionId}/save-version`),

  metrics: (definitionId: string) => req<DefinitionMetricsDto>(`/api/metrics/definitions/${definitionId}`),
  scheduler: () => req<SchedulerDto>('/api/scheduler'),
  logs: (limit?: number) => req<LogsDto>(`/api/logs${limit ? `?limit=${limit}` : ''}`),
  transcript: (execId: number) => req<string>(`/api/task-executions/${execId}/transcript`),
};
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @flowfabric/web test client`
Expected: PASS.

- [ ] **Step 6: Build the SSE hook + shell**

Create `packages/web/src/api/sse.ts`:

```ts
import { useEffect, useRef } from 'react';

/** Subscribe to a server SSE endpoint. `onEvent` receives each parsed data payload.
 * The callback is held in a ref so re-renders don't reopen the stream. */
export function useEventStream<T = unknown>(path: string, onEvent: (data: T) => void): void {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const es = new EventSource(path);
    es.onmessage = (e) => {
      if (!e.data || e.data.startsWith(':')) return;
      try {
        cb.current(JSON.parse(e.data) as T);
      } catch {
        /* ignore keep-alive / non-JSON frames */
      }
    };
    return () => es.close();
  }, [path]);
}
```

Create `packages/web/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
```

Create `packages/web/src/App.tsx`:

```tsx
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { DefinitionsPage } from './pages/DefinitionsPage';
import { RefinePage } from './pages/RefinePage';
import { InstancesPage } from './pages/InstancesPage';
import { InstanceDetailPage } from './pages/InstanceDetailPage';
import { InboxPage } from './pages/InboxPage';
import { DashboardsPage } from './pages/DashboardsPage';
import { SystemPage } from './pages/SystemPage';

const NAV = [
  ['/definitions', 'Definitions'],
  ['/instances', 'Instances'],
  ['/inbox', 'Inbox'],
  ['/dashboards', 'Dashboards'],
  ['/system', 'System'],
] as const;

export function App() {
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Flow Fabric</div>
        {NAV.map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/definitions" replace />} />
          <Route path="/definitions" element={<DefinitionsPage />} />
          <Route path="/definitions/:id/refine" element={<RefinePage />} />
          <Route path="/instances" element={<InstancesPage />} />
          <Route path="/instances/:id" element={<InstanceDetailPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/dashboards" element={<DashboardsPage />} />
          <Route path="/system" element={<SystemPage />} />
        </Routes>
      </main>
    </div>
  );
}
```

Create `packages/web/src/app.css` (minimal shell layout; the Task 16 polish pass replaces this):

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; color: #1a1a1a; }
.shell { display: flex; min-height: 100vh; }
.sidebar { width: 200px; background: #111; color: #eee; padding: 16px; display: flex; flex-direction: column; gap: 4px; }
.sidebar .brand { font-weight: 700; margin-bottom: 16px; }
.sidebar a { color: #bbb; text-decoration: none; padding: 6px 8px; border-radius: 6px; }
.sidebar a.active, .sidebar a:hover { background: #333; color: #fff; }
.content { flex: 1; padding: 24px; overflow: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eee; font-size: 14px; }
button { cursor: pointer; }
```

Create placeholder page modules so the app compiles now; each is fully implemented in its own task. Create `packages/web/src/pages/DefinitionsPage.tsx`, `RefinePage.tsx`, `InstancesPage.tsx`, `InstanceDetailPage.tsx`, `InboxPage.tsx`, `DashboardsPage.tsx`, `SystemPage.tsx`, each with the same stub body (named export matching the import):

```tsx
export function DefinitionsPage() {
  return <h1>Definitions</h1>;
}
```

(Repeat per file with the matching component name — `RefinePage`, `InstancesPage`, `InstanceDetailPage`, `InboxPage`, `DashboardsPage`, `SystemPage`.)

- [ ] **Step 7: Verify build + typecheck**

Run: `pnpm --filter @flowfabric/shared build && pnpm --filter @flowfabric/web typecheck && pnpm --filter @flowfabric/web build`
Expected: typecheck clean; `dist/index.html` emitted.

- [ ] **Step 8: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "feat(web): Vite/React/Router scaffold, API client, SSE hook, app shell (M4.1)"
```

---

### Task 10: Definitions page — upload, versions, lint, start instance

Design §9 Definitions page: list definitions, upload a BPMN file, show versions with lint/deployable state, start an instance from a deployable version, and link into Refine.

**Files:**
- Create: `packages/web/src/components/LintPanel.tsx`
- Modify: `packages/web/src/pages/DefinitionsPage.tsx`
- Test: `packages/web/test/lint-panel.test.tsx`

**Interfaces:**
- Consumes: `api.listDefinitions`, `api.uploadDefinition`, `api.listVersions`, `api.lintVersion`, `api.getVersion`, `api.startInstance`.
- Produces: `<LintPanel report={LintReport | null} />` reused by the Refine page (Task 11).

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/test/lint-panel.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LintPanel } from '../src/components/LintPanel';

describe('LintPanel', () => {
  it('shows deployable when there are no errors', () => {
    render(<LintPanel report={{ findings: [], errorCount: 0, deployable: true }} />);
    expect(screen.getByText(/deployable/i)).toBeTruthy();
  });

  it('lists findings with their rule id and message', () => {
    render(<LintPanel report={{
      findings: [{ rule: 'FF002', severity: 'error', nodeId: 'Task_1', message: 'missing contract' }],
      errorCount: 1, deployable: false,
    }} />);
    expect(screen.getByText(/FF002/)).toBeTruthy();
    expect(screen.getByText(/missing contract/)).toBeTruthy();
    expect(screen.getByText(/1 error/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/web test lint-panel`
Expected: FAIL — cannot resolve `../src/components/LintPanel`.

- [ ] **Step 3: Implement LintPanel**

Create `packages/web/src/components/LintPanel.tsx`:

```tsx
import type { LintReport } from '@flowfabric/shared';

export function LintPanel({ report }: { report: LintReport | null }) {
  if (!report) return <p className="muted">Not linted yet.</p>;
  return (
    <div className="lint-panel">
      <p className={report.deployable ? 'lint-ok' : 'lint-bad'}>
        {report.deployable ? 'Deployable' : `Not deployable — ${report.errorCount} error${report.errorCount === 1 ? '' : 's'}`}
      </p>
      {report.findings.length > 0 && (
        <ul>
          {report.findings.map((f, i) => (
            <li key={i} className={`finding sev-${f.severity}`}>
              <code>{f.rule}</code> {f.nodeId ? <em>{f.nodeId}</em> : null} — {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @flowfabric/web test lint-panel`
Expected: PASS.

- [ ] **Step 5: Implement the Definitions page**

Replace `packages/web/src/pages/DefinitionsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DefinitionDto, VersionSummaryDto } from '@flowfabric/shared';
import { api } from '../api/client';

export function DefinitionsPage() {
  const [defs, setDefs] = useState<DefinitionDto[]>([]);
  const [error, setError] = useState<string>();

  const refresh = () => api.listDefinitions().then(setDefs).catch((e) => setError(String(e)));
  useEffect(() => { refresh(); }, []);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await api.uploadDefinition(file.name.replace(/\.bpmn$/i, ''), await file.text());
      await refresh();
    } catch (err) {
      setError(String(err));
    }
    e.target.value = '';
  }

  return (
    <section>
      <h1>Definitions</h1>
      <label className="upload">
        Upload BPMN <input type="file" accept=".bpmn,.xml" onChange={onUpload} />
      </label>
      {error && <p className="lint-bad">{error}</p>}
      {defs.length === 0 && <p className="muted">No definitions yet. Upload a BPMN file to begin.</p>}
      {defs.map((d) => <DefinitionRow key={d.id} def={d} />)}
    </section>
  );
}

function DefinitionRow({ def }: { def: DefinitionDto }) {
  const [versions, setVersions] = useState<VersionSummaryDto[]>([]);
  const refresh = () => api.listVersions(def.id).then(setVersions);
  useEffect(() => { refresh(); }, [def.id]);

  async function lint(v: number) {
    await api.lintVersion(def.id, v);
    await refresh();
  }

  async function start(v: number) {
    const workspacePath = window.prompt('Workspace path to run against:');
    if (!workspacePath) return;
    const dryRun = window.confirm('Dry run (stub agents)? OK = dry run, Cancel = real run.');
    const { id } = await api.startInstance({ definitionId: def.id, version: v, workspacePath, dryRun });
    window.location.hash = `#/instances/${id}`;
  }

  return (
    <div className="def-card">
      <div className="def-head">
        <strong>{def.name}</strong>
        <Link to={`/definitions/${def.id}/refine`}>Refine</Link>
      </div>
      <table>
        <thead><tr><th>Version</th><th>Lint</th><th>Actions</th></tr></thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.versionNo}>
              <td>v{v.versionNo}</td>
              <td className={v.deployable ? 'lint-ok' : 'lint-bad'}>
                {v.deployable ? 'deployable' : 'not deployable'}
              </td>
              <td>
                <button onClick={() => lint(v.versionNo)}>Lint</button>{' '}
                <button disabled={!v.deployable} onClick={() => start(v.versionNo)}>Start</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: Verify typecheck + build**

Run: `pnpm --filter @flowfabric/web typecheck && pnpm --filter @flowfabric/web test`
Expected: typecheck clean; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src packages/web/test/lint-panel.test.tsx
git commit -m "feat(web): Definitions page — upload, versions, lint, start (design §9)"
```

---

### Task 11: BpmnCanvas + Refine page — grill chat, live lint, save version

Design §9 Refine page: bpmn-js render beside the grill chat, live lint panel, version save. Impl gate M4.2: "grill session usable end-to-end from browser". The `chat.ts` helper turns an SDK message into displayable text and is unit-tested without the DOM.

**Files:**
- Create: `packages/web/src/components/BpmnCanvas.tsx`
- Create: `packages/web/src/lib/chat.ts`
- Modify: `packages/web/src/pages/RefinePage.tsx`
- Test: `packages/web/test/chat.test.ts`

**Interfaces:**
- Consumes: `api.startGrill`, `api.getGrill`, `api.sendGrill`, `api.saveGrillVersion`, `useEventStream`, `<LintPanel/>` (Task 10).
- Produces: `<BpmnCanvas xml={string} markers?={Record<string, string>} />` (reused by Task 12); `messageToText(msg): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/test/chat.test.ts
import { describe, it, expect } from 'vitest';
import { messageToText } from '../src/lib/chat';

describe('messageToText', () => {
  it('extracts assistant text blocks', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'text', text: 'Which actor runs Task_1?' }] } };
    expect(messageToText(msg)).toBe('Which actor runs Task_1?');
  });
  it('summarizes a tool use as an op proposal', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__flowfabric__propose_patch_ops', input: { ops: [{ op: 'setTaskType' }] } }] } };
    expect(messageToText(msg)).toContain('proposed 1 patch op');
  });
  it('returns null for result/system frames', () => {
    expect(messageToText({ type: 'result', session_id: 'x' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/web test chat`
Expected: FAIL — cannot resolve `../src/lib/chat`.

- [ ] **Step 3: Implement chat.ts**

Create `packages/web/src/lib/chat.ts`:

```ts
/** Turn a Claude Agent SDK stream message into a line for the grill chat, or null to skip. */
export function messageToText(msg: any): string | null {
  if (msg?.type !== 'assistant') return null;
  const blocks = msg.message?.content ?? [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text?.trim()) parts.push(b.text.trim());
    else if (b.type === 'tool_use' && b.name?.includes('propose_patch_ops')) {
      const n = Array.isArray(b.input?.ops) ? b.input.ops.length : 0;
      parts.push(`(proposed ${n} patch op${n === 1 ? '' : 's'})`);
    }
  }
  return parts.length ? parts.join('\n') : null;
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @flowfabric/web test chat`
Expected: PASS.

- [ ] **Step 5: Implement BpmnCanvas**

Create `packages/web/src/components/BpmnCanvas.tsx`. `NavigatedViewer` renders and pans/zooms; `markers` maps element id → CSS class for the token overlay (Task 12 supplies them; Refine passes none):

```tsx
import { useEffect, useRef } from 'react';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

export function BpmnCanvas({ xml, markers = {} }: { xml: string; markers?: Record<string, string> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);

  useEffect(() => {
    const viewer = new BpmnViewer({ container: hostRef.current! });
    viewerRef.current = viewer;
    return () => viewer.destroy();
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !xml) return;
    let cancelled = false;
    viewer.importXML(xml).then(() => {
      if (cancelled) return;
      viewer.get('canvas').zoom('fit-viewport');
      applyMarkers(viewer, markers);
    }).catch(() => { /* invalid XML renders nothing; lint panel explains why */ });
    return () => { cancelled = true; };
  }, [xml]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer?.getDefinitions?.()) applyMarkers(viewer, markers);
  }, [markers]);

  return <div className="bpmn-canvas" ref={hostRef} />;
}

const ALL_MARKERS = ['node-running', 'node-done', 'node-failed', 'node-waiting'];

function applyMarkers(viewer: any, markers: Record<string, string>) {
  const canvas = viewer.get('canvas');
  const registry = viewer.get('elementRegistry');
  for (const el of registry.getAll()) {
    for (const m of ALL_MARKERS) canvas.removeMarker(el.id, m);
  }
  for (const [id, cls] of Object.entries(markers)) {
    if (registry.get(id)) canvas.addMarker(id, cls);
  }
}
```

- [ ] **Step 6: Implement the Refine page**

Replace `packages/web/src/pages/RefinePage.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { LintReport } from '@flowfabric/shared';
import { api } from '../api/client';
import { useEventStream } from '../api/sse';
import { BpmnCanvas } from '../components/BpmnCanvas';
import { LintPanel } from '../components/LintPanel';
import { messageToText } from '../lib/chat';

export function RefinePage() {
  const { id } = useParams<{ id: string }>();
  const [sessionId, setSessionId] = useState<string>();
  const [xml, setXml] = useState('');
  const [lint, setLint] = useState<LintReport | null>(null);
  const [chat, setChat] = useState<Array<{ who: 'you' | 'agent'; text: string }>>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    api.startGrill(id).then(async ({ sessionId, lint }) => {
      setSessionId(sessionId);
      setLint(lint);
      setXml((await api.getGrill(sessionId)).xml);
    });
  }, [id]);

  useEventStream(sessionId ? `/api/grill/sessions/${sessionId}/events` : '/api/events', (ev: any) => {
    if (!sessionId) return;
    if (ev.type === 'chat') {
      const text = messageToText(ev.message);
      if (text) setChat((c) => [...c, { who: 'agent', text }]);
    } else if (ev.type === 'lint-updated') {
      setLint(ev.report);
      api.getGrill(sessionId).then((s) => setXml(s.xml));
    } else if (ev.type === 'turn-done') {
      setBusy(false);
    }
  });

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [chat]);

  async function send() {
    if (!sessionId || !draft.trim()) return;
    setChat((c) => [...c, { who: 'you', text: draft }]);
    setBusy(true);
    const text = draft;
    setDraft('');
    await api.sendGrill(sessionId, text);
  }

  async function save() {
    if (!sessionId) return;
    const { versionNo, deployable } = await api.saveGrillVersion(sessionId);
    setSaved(`Saved v${versionNo}${deployable ? ' (deployable)' : ' (not yet deployable)'}`);
  }

  return (
    <section className="refine">
      <div className="refine-diagram">
        <BpmnCanvas xml={xml} />
        <LintPanel report={lint} />
        <button onClick={save} disabled={!sessionId}>Save version</button>
        {saved && <span className="muted">{saved}</span>}
      </div>
      <div className="refine-chat">
        <div className="chat-log">
          {chat.map((m, i) => <div key={i} className={`chat-msg ${m.who}`}><b>{m.who}:</b> {m.text}</div>)}
          <div ref={endRef} />
        </div>
        <div className="chat-input">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Answer the grill agent…"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button onClick={send} disabled={busy || !sessionId}>{busy ? 'Thinking…' : 'Send'}</button>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Verify typecheck + build**

Run: `pnpm --filter @flowfabric/web typecheck && pnpm --filter @flowfabric/web test && pnpm --filter @flowfabric/web build`
Expected: clean; bpmn-js bundles.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src packages/web/test/chat.test.ts
git commit -m "feat(web): BpmnCanvas + Refine page with grill chat and live lint (M4.2)"
```

---

### Task 12: Instances pages — live diagram overlay (FR-20) + timeline (FR-21)

Design §9 Instances: list + live diagram with token overlay and per-node status (FR-20); timeline tab with inputs/outputs/durations/transcript links/cost (FR-21). Impl gate M4.3: "watch a dry run live; every executed step visible with full data". The overlay status and the display formatters are pure functions, unit-tested off-DOM.

**Files:**
- Create: `packages/web/src/lib/node-status.ts`
- Create: `packages/web/src/lib/instance-view.ts`
- Modify: `packages/web/src/pages/InstancesPage.tsx`
- Modify: `packages/web/src/pages/InstanceDetailPage.tsx`
- Test: `packages/web/test/node-status.test.ts`, `packages/web/test/instance-view.test.ts`

**Interfaces:**
- Consumes: `api.listInstances`, `api.getInstance`, `api.abortInstance`, `api.getVersion` (diagram XML), `api.transcript`, `useEventStream`, `<BpmnCanvas/>` (Task 11).
- Produces: `nodeMarkers(events): Record<string, string>`; `deriveDisplayStatus(instance, pendingCount, timerCount): string`; `fmtDuration(ms)`, `fmtCost(usd)`, `fmtTime(ms)`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/test/node-status.test.ts
import { describe, it, expect } from 'vitest';
import { nodeMarkers } from '../src/lib/node-status';
import type { EventDto } from '@flowfabric/shared';

const ev = (seq: number, type: string, elementId: string | null = null): EventDto =>
  ({ seq, type, elementId, detail: null, ts: seq });

describe('nodeMarkers', () => {
  it('marks the last event per node', () => {
    const markers = nodeMarkers([
      ev(1, 'activity.start', 'audit'),
      ev(2, 'activity.end', 'audit'),
      ev(3, 'activity.start', 'review'),
      ev(4, 'activity.wait', 'review'),
    ]);
    expect(markers).toEqual({ audit: 'node-done', review: 'node-waiting' });
  });
  it('maps a raised incident to failed and a timer to waiting', () => {
    const markers = nodeMarkers([
      ev(1, 'incident.raised', 'audit'),
      ev(2, 'activity.timer', 'wait'),
    ]);
    expect(markers).toEqual({ audit: 'node-failed', wait: 'node-waiting' });
  });
  it('ignores events without an element id', () => {
    expect(nodeMarkers([ev(1, 'engine.end', null)])).toEqual({});
  });
});
```

```ts
// packages/web/test/instance-view.test.ts
import { describe, it, expect } from 'vitest';
import { deriveDisplayStatus, fmtDuration, fmtCost } from '../src/lib/instance-view';
import type { InstanceDto } from '@flowfabric/shared';

const inst = (status: InstanceDto['status']): InstanceDto => ({
  id: 'i', name: 'n', status, workspace: '/w', dryRun: false,
  definitionId: null, versionNo: null, createdAt: 0, updatedAt: 0,
});

describe('deriveDisplayStatus', () => {
  it('shows "waiting" when running with a pending user task', () => {
    expect(deriveDisplayStatus(inst('running'), 1, 0)).toBe('waiting (user task)');
  });
  it('shows "waiting (timer)" when running with an armed timer only', () => {
    expect(deriveDisplayStatus(inst('running'), 0, 1)).toBe('waiting (timer)');
  });
  it('passes real statuses through', () => {
    expect(deriveDisplayStatus(inst('incident'), 0, 0)).toBe('incident');
    expect(deriveDisplayStatus(inst('running'), 0, 0)).toBe('running');
  });
});

describe('formatters', () => {
  it('formats durations and cost', () => {
    expect(fmtDuration(1500)).toBe('1.5s');
    expect(fmtDuration(65000)).toBe('1m 5s');
    expect(fmtCost(0.1234)).toBe('$0.1234');
    expect(fmtCost(null)).toBe('—');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/web test node-status instance-view`
Expected: FAIL — cannot resolve the two lib modules.

- [ ] **Step 3: Implement the pure libs**

Create `packages/web/src/lib/node-status.ts`:

```ts
import type { EventDto } from '@flowfabric/shared';

const TYPE_TO_MARKER: Record<string, string> = {
  'activity.start': 'node-running',
  'activity.end': 'node-done',
  'activity.wait': 'node-waiting',
  'activity.timer': 'node-waiting',
  'incident.raised': 'node-failed',
  'task.attempt-failed': 'node-failed',
};

/** Last relevant event per node id wins (events arrive in seq order). */
export function nodeMarkers(events: EventDto[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of events) {
    if (!e.elementId) continue;
    const marker = TYPE_TO_MARKER[e.type];
    if (marker) out[e.elementId] = marker;
  }
  return out;
}
```

Create `packages/web/src/lib/instance-view.ts`:

```ts
import type { InstanceDto } from '@flowfabric/shared';

/** Derive the "waiting" display label the engine has no status column for
 * (design data model defers instances.status='waiting' — the UI computes it). */
export function deriveDisplayStatus(inst: InstanceDto, pendingUserTasks: number, armedTimers: number): string {
  if (inst.status === 'running') {
    if (pendingUserTasks > 0) return 'waiting (user task)';
    if (armedTimers > 0) return 'waiting (timer)';
  }
  return inst.status;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function fmtCost(usd: number | null): string {
  return usd === null || usd === undefined ? '—' : `$${usd.toFixed(4)}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/web test node-status instance-view`
Expected: PASS.

- [ ] **Step 5: Implement the Instances list page**

Replace `packages/web/src/pages/InstancesPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InstanceDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { useEventStream } from '../api/sse';
import { fmtTime } from '../lib/instance-view';

export function InstancesPage() {
  const [rows, setRows] = useState<InstanceDto[]>([]);
  const refresh = () => api.listInstances().then(setRows);
  useEffect(() => { refresh(); }, []);
  // any instance lifecycle event refreshes the list
  useEventStream('/api/events', () => refresh());

  return (
    <section>
      <h1>Instances</h1>
      {rows.length === 0 && <p className="muted">No instances yet. Start one from a deployable definition.</p>}
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Dry run</th><th>Started</th></tr></thead>
        <tbody>
          {rows.slice().reverse().map((r) => (
            <tr key={r.id}>
              <td><Link to={`/instances/${r.id}`}>{r.name}</Link></td>
              <td><span className={`status-${r.status}`}>{r.status}</span></td>
              <td>{r.dryRun ? 'yes' : 'no'}</td>
              <td>{fmtTime(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 6: Implement the Instance detail page (diagram + timeline)**

Replace `packages/web/src/pages/InstanceDetailPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { InstanceDetailDto, TimelineEntryDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { useEventStream } from '../api/sse';
import { BpmnCanvas } from '../components/BpmnCanvas';
import { nodeMarkers } from '../lib/node-status';
import { deriveDisplayStatus, fmtCost, fmtDuration, fmtTime } from '../lib/instance-view';

export function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<InstanceDetailDto>();
  const [xml, setXml] = useState('');
  const [tab, setTab] = useState<'diagram' | 'timeline'>('diagram');
  const [pending, setPending] = useState(0);
  const [timers, setTimers] = useState(0);

  const refresh = useCallback(async () => {
    if (!id) return;
    const d = await api.getInstance(id);
    setDetail(d);
    if (!xml && d.instance.definitionId && d.instance.versionNo) {
      api.getVersion(d.instance.definitionId, d.instance.versionNo).then((v) => setXml(v.xml)).catch(() => {});
    }
    const inbox = await api.getInbox();
    setPending(inbox.userTasks.filter((t) => t.instanceId === id).length);
    const sched = await api.scheduler();
    setTimers(sched.timers.filter((t) => t.instanceId === id).length);
  }, [id, xml]);

  useEffect(() => { refresh(); }, [refresh]);
  useEventStream(id ? `/api/events?instanceId=${id}` : '/api/events', () => refresh());

  if (!detail) return <p className="muted">Loading…</p>;
  const { instance, timeline, events } = detail;
  const markers = nodeMarkers(events);

  return (
    <section>
      <h1>{instance.name}</h1>
      <p>Status: <b>{deriveDisplayStatus(instance, pending, timers)}</b>{' '}
        <span className="muted">· {instance.workspace}</span>{' '}
        {['running', 'incident'].includes(instance.status) && (
          <button onClick={() => api.abortInstance(instance.id).then(refresh)}>Abort</button>
        )}
      </p>
      <div className="tabs">
        <button className={tab === 'diagram' ? 'active' : ''} onClick={() => setTab('diagram')}>Diagram</button>
        <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Timeline</button>
      </div>
      {tab === 'diagram'
        ? (xml ? <BpmnCanvas xml={xml} markers={markers} /> : <p className="muted">No diagram (started from raw source).</p>)
        : <Timeline rows={timeline} />}
    </section>
  );
}

function Timeline({ rows }: { rows: TimelineEntryDto[] }) {
  if (rows.length === 0) return <p className="muted">No steps recorded yet.</p>;
  return (
    <table>
      <thead><tr><th>Node</th><th>Actor</th><th>Attempt</th><th>Status</th><th>Duration</th><th>Cost</th><th>Inputs</th><th>Output</th><th>Transcript</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.nodeId}</td>
            <td>{r.actor}</td>
            <td>{r.attempt}</td>
            <td className={`status-${r.status}`}>{r.status}</td>
            <td>{fmtDuration(r.endedAt ? r.endedAt - r.startedAt : null)}</td>
            <td>{fmtCost(r.costUsd)}</td>
            <td><OutputCell json={r.resolvedInputs} /></td>
            <td><OutputCell json={r.output ?? r.error} /></td>
            <td>{r.transcriptPath
              ? <button onClick={() => api.transcript(r.id).then((t) => window.alert(t.slice(0, 4000)))}>view</button>
              : <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OutputCell({ json }: { json: string | null }) {
  if (!json) return <span className="muted">—</span>;
  return <code className="cell-json" title={json}>{json.length > 60 ? `${json.slice(0, 60)}…` : json}</code>;
}
```

- [ ] **Step 7: Add overlay marker styles**

Append to `packages/web/src/app.css`:

```css
.bpmn-canvas { height: 480px; border: 1px solid #ddd; border-radius: 8px; background: #fafafa; }
.node-running .djs-visual > :nth-child(1) { stroke: #d98300 !important; stroke-width: 3px !important; }
.node-done .djs-visual > :nth-child(1) { stroke: #2e7d32 !important; stroke-width: 3px !important; }
.node-failed .djs-visual > :nth-child(1) { stroke: #c62828 !important; stroke-width: 3px !important; }
.node-waiting .djs-visual > :nth-child(1) { stroke: #1565c0 !important; stroke-width: 3px !important; stroke-dasharray: 4 !important; }
.tabs { margin: 12px 0; display: flex; gap: 6px; }
.tabs button.active { background: #111; color: #fff; }
.cell-json { font-size: 12px; color: #555; }
```

- [ ] **Step 8: Verify + commit**

Run: `pnpm --filter @flowfabric/web typecheck && pnpm --filter @flowfabric/web test && pnpm --filter @flowfabric/web build`
Expected: clean.

```bash
git add packages/web/src packages/web/test/node-status.test.ts packages/web/test/instance-view.test.ts
git commit -m "feat(web): Instances live diagram overlay + timeline (FR-20, FR-21)"
```

---

### Task 13: Inbox page — schema forms, escape hatch, incident resolution

Design §9 Inbox: JSON-Schema-rendered forms with a free-form JSON escape hatch (PRD §9), incident resolution actions (FR-22). Impl gate M4.4: "submit a real user task and resolve a forced incident from the browser". The `SchemaForm` value coercion is pure and unit-tested.

**Files:**
- Create: `packages/web/src/components/SchemaForm.tsx`
- Modify: `packages/web/src/pages/InboxPage.tsx`
- Test: `packages/web/test/schema-form.test.tsx`

**Interfaces:**
- Consumes: `api.getInbox`, `api.submitUserTask`, `api.resolveIncident`, `useEventStream`.
- Produces: `<SchemaForm schema={object} onSubmit={(vars) => void} />` handling flat JSON-Schema objects of primitives, plus a raw-JSON toggle.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/test/schema-form.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SchemaForm } from '../src/components/SchemaForm';

const schema = {
  type: 'object',
  required: ['approved'],
  properties: {
    approved: { type: 'boolean' },
    notes: { type: 'string' },
    priority: { type: 'number' },
  },
};

describe('SchemaForm', () => {
  it('coerces field values to their declared types on submit', () => {
    const onSubmit = vi.fn();
    render(<SchemaForm schema={schema} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText('approved'));
    fireEvent.change(screen.getByLabelText('notes'), { target: { value: 'looks good' } });
    fireEvent.change(screen.getByLabelText('priority'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith({ approved: true, notes: 'looks good', priority: 3 });
  });

  it('submits raw JSON from the escape hatch', () => {
    const onSubmit = vi.fn();
    render(<SchemaForm schema={schema} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /raw json/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"approved":false}' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith({ approved: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/web test schema-form`
Expected: FAIL — cannot resolve `../src/components/SchemaForm`.

- [ ] **Step 3: Implement SchemaForm**

Create `packages/web/src/components/SchemaForm.tsx`:

```tsx
import { useState } from 'react';

type Schema = {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
};

export function SchemaForm({ schema, onSubmit }: { schema: Schema; onSubmit: (vars: Record<string, unknown>) => void }) {
  const props = schema.properties ?? {};
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState('{}');
  const [error, setError] = useState<string>();

  function set(name: string, v: string | boolean) {
    setValues((prev) => ({ ...prev, [name]: v }));
  }

  function submit() {
    setError(undefined);
    if (raw) {
      try {
        onSubmit(JSON.parse(rawText));
      } catch {
        setError('Invalid JSON');
      }
      return;
    }
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(props)) {
      const v = values[name];
      if (v === undefined) continue;
      if (spec.type === 'number' || spec.type === 'integer') out[name] = Number(v);
      else if (spec.type === 'boolean') out[name] = Boolean(v);
      else out[name] = v;
    }
    onSubmit(out);
  }

  return (
    <div className="schema-form">
      <label className="raw-toggle">
        <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw JSON
      </label>
      {raw ? (
        <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} rows={6} />
      ) : (
        Object.entries(props).map(([name, spec]) => (
          <div key={name} className="field">
            <label htmlFor={`f-${name}`}>{name}</label>
            {spec.type === 'boolean' ? (
              <input id={`f-${name}`} type="checkbox"
                checked={Boolean(values[name])} onChange={(e) => set(name, e.target.checked)} />
            ) : spec.enum ? (
              <select id={`f-${name}`} value={String(values[name] ?? '')} onChange={(e) => set(name, e.target.value)}>
                <option value="" disabled>choose…</option>
                {spec.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
              </select>
            ) : (
              <input id={`f-${name}`}
                type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'}
                value={String(values[name] ?? '')} onChange={(e) => set(name, e.target.value)} />
            )}
          </div>
        ))
      )}
      {error && <p className="lint-bad">{error}</p>}
      <button onClick={submit}>Submit</button>
    </div>
  );
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @flowfabric/web test schema-form`
Expected: PASS.

- [ ] **Step 5: Implement the Inbox page**

Replace `packages/web/src/pages/InboxPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InboxDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { useEventStream } from '../api/sse';
import { SchemaForm } from '../components/SchemaForm';

export function InboxPage() {
  const [inbox, setInbox] = useState<InboxDto>({ userTasks: [], incidents: [] });
  const [error, setError] = useState<string>();
  const refresh = () => api.getInbox().then(setInbox);
  useEffect(() => { refresh(); }, []);
  useEventStream('/api/events', () => refresh());

  async function submit(taskId: number, vars: Record<string, unknown>) {
    setError(undefined);
    try {
      await api.submitUserTask(taskId, vars);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function resolve(id: number, action: 'retry' | 'skip' | 'abort') {
    setError(undefined);
    let output: Record<string, unknown> | undefined;
    if (action === 'skip') {
      const raw = window.prompt('Output JSON to merge as this task\'s result:', '{}');
      if (raw === null) return;
      try { output = JSON.parse(raw); } catch { setError('Invalid JSON'); return; }
    }
    try {
      await api.resolveIncident(id, action, output);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section>
      <h1>Inbox</h1>
      {error && <p className="lint-bad">{error}</p>}

      <h2>User tasks</h2>
      {inbox.userTasks.length === 0 && <p className="muted">Nothing waiting.</p>}
      {inbox.userTasks.map((t) => (
        <div key={t.id} className="inbox-card">
          <div><b>{t.nodeId}</b> · <Link to={`/instances/${t.instanceId}`}>instance</Link></div>
          <SchemaForm schema={JSON.parse(t.formSchema)} onSubmit={(vars) => submit(t.id, vars)} />
        </div>
      ))}

      <h2>Incidents</h2>
      {inbox.incidents.length === 0 && <p className="muted">No open incidents.</p>}
      {inbox.incidents.map((inc) => (
        <div key={inc.id} className="inbox-card incident">
          <div><b>{inc.nodeId}</b> · <Link to={`/instances/${inc.instanceId}`}>instance</Link></div>
          <p className="reason">{inc.reason}</p>
          <div className="actions">
            <button onClick={() => resolve(inc.id, 'retry')}>Retry</button>
            <button onClick={() => resolve(inc.id, 'skip')}>Skip (supply output)</button>
            <button onClick={() => resolve(inc.id, 'abort')}>Abort instance</button>
          </div>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter @flowfabric/web typecheck && pnpm --filter @flowfabric/web test && pnpm --filter @flowfabric/web build`
Expected: clean.

```bash
git add packages/web/src packages/web/test/schema-form.test.tsx
git commit -m "feat(web): Inbox — schema forms, JSON escape hatch, incident resolution (FR-22)"
```

---

### Task 14: Dashboards page (FR-23)

Design §9 Dashboards: success rate, duration distribution, cost per run/task, incident frequency as SQL aggregates (FR-23). Impl gate M4.5: "aggregates match seeded test data" (the server side is Task 2; this renders them). Stat tiles + CSS bars, no chart library.

**Files:**
- Modify: `packages/web/src/pages/DashboardsPage.tsx`
- Test: `packages/web/test/dashboards.test.tsx`

**Interfaces:**
- Consumes: `api.listDefinitions`, `api.metrics`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/test/dashboards.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DashboardsPage } from '../src/pages/DashboardsPage';

afterEach(() => vi.restoreAllMocks());

describe('DashboardsPage', () => {
  it('renders success rate and run counts for the selected definition', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/definitions')
        return new Response(JSON.stringify({ definitions: [{ id: 'def-1', name: 'rfp', createdAt: 0 }] }),
          { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        runs: { total: 4, completed: 2, terminated: 0, aborted: 1, error: 0, active: 1 },
        successRate: 0.6667, durationsMs: [1000, 2000],
        costPerRun: [{ instanceId: 'a', costUsd: 0.75 }],
        costPerTask: [{ nodeId: 'audit', runs: 2, totalCostUsd: 0.75, avgDurationMs: 1500 }],
        incidents: { total: 1, open: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }));
    render(<DashboardsPage />);
    await waitFor(() => expect(screen.getByText(/67%/)).toBeTruthy());
    expect(screen.getByText(/audit/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/web test dashboards`
Expected: FAIL — DashboardsPage is still the stub, no `67%`.

- [ ] **Step 3: Implement the Dashboards page**

Replace `packages/web/src/pages/DashboardsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { DefinitionDto, DefinitionMetricsDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { fmtCost, fmtDuration } from '../lib/instance-view';

export function DashboardsPage() {
  const [defs, setDefs] = useState<DefinitionDto[]>([]);
  const [selected, setSelected] = useState<string>();
  const [m, setM] = useState<DefinitionMetricsDto>();

  useEffect(() => {
    api.listDefinitions().then((d) => {
      setDefs(d);
      if (d[0]) setSelected(d[0].id);
    });
  }, []);
  useEffect(() => {
    if (selected) api.metrics(selected).then(setM);
  }, [selected]);

  const maxDur = m ? Math.max(1, ...m.durationsMs) : 1;

  return (
    <section>
      <h1>Dashboards</h1>
      <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
        {defs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      {!m ? <p className="muted">No metrics.</p> : (
        <>
          <div className="tiles">
            <Tile label="Success rate" value={m.successRate === null ? '—' : `${Math.round(m.successRate * 100)}%`} />
            <Tile label="Total runs" value={String(m.runs.total)} />
            <Tile label="Active" value={String(m.runs.active)} />
            <Tile label="Open incidents" value={`${m.incidents.open}/${m.incidents.total}`} />
          </div>

          <h2>Run duration</h2>
          {m.durationsMs.length === 0 ? <p className="muted">No finished runs.</p> : (
            <div className="bars">
              {m.durationsMs.map((d, i) => (
                <div key={i} className="bar" style={{ width: `${(d / maxDur) * 100}%` }} title={fmtDuration(d)}>
                  {fmtDuration(d)}
                </div>
              ))}
            </div>
          )}

          <h2>Cost per task</h2>
          <table>
            <thead><tr><th>Node</th><th>Runs</th><th>Total cost</th><th>Avg duration</th></tr></thead>
            <tbody>
              {m.costPerTask.map((t) => (
                <tr key={t.nodeId}>
                  <td>{t.nodeId}</td><td>{t.runs}</td><td>{fmtCost(t.totalCostUsd)}</td>
                  <td>{fmtDuration(t.avgDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return <div className="tile"><div className="tile-value">{value}</div><div className="tile-label">{label}</div></div>;
}
```

Append to `packages/web/src/app.css`:

```css
.tiles { display: flex; gap: 12px; margin: 12px 0; }
.tile { background: #f5f5f5; border-radius: 8px; padding: 16px 20px; min-width: 120px; }
.tile-value { font-size: 28px; font-weight: 700; }
.tile-label { font-size: 12px; color: #666; }
.bars { display: flex; flex-direction: column; gap: 4px; }
.bar { background: #1565c0; color: #fff; font-size: 12px; padding: 2px 6px; border-radius: 3px; min-width: 40px; white-space: nowrap; }
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @flowfabric/web typecheck && pnpm --filter @flowfabric/web test && pnpm --filter @flowfabric/web build`
Expected: clean.

```bash
git add packages/web/src packages/web/test/dashboards.test.tsx
git commit -m "feat(web): Dashboards — success rate, durations, cost per task (FR-23)"
```

---

### Task 15: System page (FR-25)

Design §9 System: health, scheduler state (next timer firings), platform logs (FR-25). Impl gate M4.6: "24h timer shows correct next-fire time". The log-line parser is pure and unit-tested.

**Files:**
- Create: `packages/web/src/lib/logs.ts`
- Modify: `packages/web/src/pages/SystemPage.tsx`
- Test: `packages/web/test/logs.test.ts`

**Interfaces:**
- Consumes: `api.scheduler`, `api.logs`, `fetch('/api/healthz')`.
- Produces: `parseLogLine(line): { level: string; msg: string; time: number | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/test/logs.test.ts
import { describe, it, expect } from 'vitest';
import { parseLogLine } from '../src/lib/logs';

describe('parseLogLine', () => {
  it('parses a pino JSON line', () => {
    const p = parseLogLine('{"level":30,"time":1700000000000,"msg":"server listening"}');
    expect(p).toEqual({ level: 'info', msg: 'server listening', time: 1700000000000 });
  });
  it('falls back to raw text for non-JSON', () => {
    const p = parseLogLine('plain log line');
    expect(p.msg).toBe('plain log line');
    expect(p.level).toBe('info');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/web test logs`
Expected: FAIL — cannot resolve `../src/lib/logs`.

- [ ] **Step 3: Implement logs.ts**

Create `packages/web/src/lib/logs.ts`:

```ts
const PINO_LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

export function parseLogLine(line: string): { level: string; msg: string; time: number | null } {
  try {
    const o = JSON.parse(line);
    return {
      level: PINO_LEVELS[o.level as number] ?? String(o.level ?? 'info'),
      msg: o.msg ?? line,
      time: typeof o.time === 'number' ? o.time : null,
    };
  } catch {
    return { level: 'info', msg: line, time: null };
  }
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @flowfabric/web test logs`
Expected: PASS.

- [ ] **Step 5: Implement the System page**

Replace `packages/web/src/pages/SystemPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { ArmedTimerDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { parseLogLine } from '../lib/logs';

export function SystemPage() {
  const [healthy, setHealthy] = useState<boolean>();
  const [timers, setTimers] = useState<ArmedTimerDto[]>([]);
  const [lines, setLines] = useState<string[]>([]);

  async function refresh() {
    setHealthy(await fetch('/api/healthz').then((r) => r.ok).catch(() => false));
    setTimers((await api.scheduler()).timers);
    setLines((await api.logs(200)).lines);
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <section>
      <h1>System</h1>
      <p>Health: <b className={healthy ? 'lint-ok' : 'lint-bad'}>{healthy ? 'ok' : 'unreachable'}</b></p>

      <h2>Scheduler — next timer firings</h2>
      {timers.length === 0 ? <p className="muted">No armed timers.</p> : (
        <table>
          <thead><tr><th>Instance</th><th>Node</th><th>Fires at</th><th>In</th></tr></thead>
          <tbody>
            {timers.map((t) => (
              <tr key={`${t.instanceId}:${t.nodeId}`}>
                <td>{t.instanceId.slice(0, 8)}</td>
                <td>{t.nodeId}</td>
                <td>{new Date(t.expireAt).toLocaleString()}</td>
                <td>{Math.max(0, Math.round((t.expireAt - Date.now()) / 1000))}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Platform logs</h2>
      <div className="logs">
        {lines.map((line, i) => {
          const p = parseLogLine(line);
          return <div key={i} className={`log log-${p.level}`}>
            <span className="log-level">{p.level}</span> {p.msg}
          </div>;
        })}
      </div>
    </section>
  );
}
```

Append to `packages/web/src/app.css`:

```css
.logs { font-family: ui-monospace, monospace; font-size: 12px; background: #111; color: #ddd; padding: 12px; border-radius: 8px; max-height: 320px; overflow: auto; }
.log-level { display: inline-block; width: 44px; color: #888; }
.log-warn .log-level { color: #d98300; }
.log-error .log-level, .log-fatal .log-level { color: #ff6b6b; }
```

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter @flowfabric/web typecheck && pnpm --filter @flowfabric/web test && pnpm --filter @flowfabric/web build`
Expected: clean.

```bash
git add packages/web/src packages/web/test/logs.test.ts
git commit -m "feat(web): System page — health, scheduler, platform logs (FR-25)"
```

---

### Task 16: Styling pass, docs, and the M4 exit gate

Design §4 "product must be presentable; design and copy quality matter". Polish the shared CSS, then run the manual end-to-end gate against the live daemon and record M4 findings.

**Files:**
- Modify: `packages/web/src/app.css`
- Modify: `CLAUDE.md` (M4 state)
- Modify: `docs/specs/impl_flow-fabric.md` (mark M4 verification notes if needed)
- Create: none (this task is polish + verification).

- [ ] **Step 1: Polish the shell CSS**

Extend `packages/web/src/app.css` with card, form, and status-badge styling so pages look intentional (adjust to taste; keep it self-contained, no external fonts/CDNs):

```css
.muted { color: #888; }
.lint-ok { color: #2e7d32; font-weight: 600; }
.lint-bad { color: #c62828; font-weight: 600; }
.def-card, .inbox-card { border: 1px solid #e5e5e5; border-radius: 10px; padding: 16px; margin: 12px 0; }
.def-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.inbox-card.incident { border-color: #f0b7b7; background: #fff7f7; }
.inbox-card .reason { font-family: ui-monospace, monospace; font-size: 12px; color: #a33; }
.inbox-card .actions { display: flex; gap: 8px; }
.refine { display: grid; grid-template-columns: 1fr 380px; gap: 16px; height: calc(100vh - 48px); }
.refine-chat { display: flex; flex-direction: column; border: 1px solid #e5e5e5; border-radius: 10px; overflow: hidden; }
.chat-log { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.chat-msg.you { text-align: right; color: #1565c0; }
.chat-input { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #eee; }
.chat-input textarea { flex: 1; resize: none; height: 56px; }
.schema-form .field { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
.schema-form .field label { width: 120px; }
.status-running, .status-incident { font-weight: 600; }
.status-completed, .status-terminated { color: #2e7d32; }
.status-incident, .status-error, .status-aborted { color: #c62828; }
.upload { display: inline-block; margin: 8px 0; }
button { border: 1px solid #ccc; background: #fff; border-radius: 6px; padding: 4px 10px; }
button:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 2: Build everything and start the daemon**

```bash
pnpm --filter @flowfabric/shared build
pnpm --filter @flowfabric/web build
pnpm --filter @flowfabric/server test
pnpm --filter @flowfabric/server dev &
```

Expected: daemon logs `http://127.0.0.1:4400`. Open it in a browser — the SPA loads (Task 8 serves `web/dist`).

- [ ] **Step 3: Manual gate — walk every page (impl M4.1–M4.6)**

Verify each, matching the impl-spec gates:

- **M4.1** every page loads at `http://127.0.0.1:4400/#/...` with no console errors.
- **M4.2** Definitions → upload a BPMN → Refine: chat with the grill agent, watch the diagram + lint panel update live, save a version. (Needs `ANTHROPIC_API_KEY` in `.env`.)
- **M4.3** Start a dry run of the refined `daily-loop-refined` fixture; on the instance page watch node markers move (running → done), the timer node show `waiting`, and the timeline fill with inputs/outputs/durations/cost; open a transcript link.
- **M4.4** Submit the pending user task from the Inbox form; force an incident (start the raw `failure.bpmn` non-dry with a failing runner, or resolve an existing one) and resolve it retry/skip/abort.
- **M4.5** Dashboards: confirm success rate, run counts, duration bars, and cost-per-task match the runs you just did.
- **M4.6** System: the armed timer shows a correct next-fire time and counts down; logs stream; health is ok.

- [ ] **Step 4: Update CLAUDE.md**

In `CLAUDE.md`, move M4 from "Not built" to "Built": update the "Current state" section to note the web SPA exists (`packages/web` — React/Vite, six pages), the new server routes (`/api/metrics/definitions/:id`, `/api/scheduler`, `/api/logs`, `/api/definitions/:id/versions`, `/api/grill/sessions/:id`, `/api/task-executions/:id/transcript`), instance definition linkage, the armed-timer registry, the log ring, and SSE event vocabulary. Note the daemon now serves the SPA at `/`. Update the "Not built" line to `M5 only (OTel/soak)`.

- [ ] **Step 5: Write M4 findings into this plan**

Append a "Spike/Build Findings" note here recording anything surprising (bpmn-js marker CSS selector quirks, SSE reconnection behavior, Fastify static + notFoundHandler interaction) for the M5 author.

- [ ] **Step 6: Final full-workspace verify**

Run: `pnpm build && pnpm test`
Expected: every package builds; all suites green (M1–M4).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/app.css CLAUDE.md docs/specs
git commit -m "feat(web): styling pass; docs: M4 built state; M4 exit gate"
```

---

## M4 Exit Checklist (impl spec verification gates)

- [ ] M4.1 — every page loads against the live daemon; SPA served at `/` (Task 8, 9, 16 step 3).
- [ ] M4.2 — grill session usable end-to-end from the browser: chat, live lint, save version (Task 11, 16 step 3).
- [ ] M4.3 — watch a dry run live; token overlay moves; every executed step visible with inputs/outputs/durations/transcript/cost (Task 12; success criterion 3).
- [ ] M4.4 — submit a real user task and resolve a forced incident from the browser (Task 13).
- [ ] M4.5 — dashboard aggregates match seeded/real run data (Task 2 server, Task 14 render).
- [ ] M4.6 — System page shows correct next-fire time for an armed timer; logs + health visible (Task 3 server, Task 15 render).
- [ ] `pnpm build && pnpm test` green across the workspace; M1–M3 suites untouched and passing.

## Deferred (deliberately not in M4)

- `instances.status = 'waiting'` column — the UI derives the label (`deriveDisplayStatus`); introduce the column only if a consumer outside the UI needs it.
- OTel traces/metrics + OTLP export (FR-24) — M5.
- Diagram editing beyond grill refinement, template library (PRD §7 "Later").
- SSE auto-reconnect/backoff — `EventSource` reconnects on its own; a custom backoff is only worth it if the soak run shows dropped streams.
- Auth — localhost only, single user (PRD §8).
