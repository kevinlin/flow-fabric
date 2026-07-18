# M1 Engine Spike / Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove `bpmn-engine` supports durable resume and timer persistence (PRD risk #1) via a walking skeleton: engine embedded, SQLite persistence, kill-and-resume, loop timers across restart. Go/no-go gate for the rest of Flow Fabric.

**Architecture:** pnpm monorepo; `packages/server` hosts a minimal `engine-host` module (`InstanceStore` for SQLite persistence, `EngineHost` wrapping `bpmn-engine`). State snapshot after every activity transition; boot-time `resumeAll()` recovers non-terminal instances. Spec: [impl_flow-fabric.md](../specs/impl_flow-fabric.md) M1, [design_flow-fabric.md](../specs/design_flow-fabric.md) §6.2.

**Tech Stack:** Node 22, TypeScript (strict, ESM), pnpm workspaces, `bpmn-engine` ^25, `better-sqlite3` ^12, vitest ^3, tsx ^4.

## Global Constraints

- Node ≥ 22, pnpm ≥ 9. All packages `"type": "module"`, TS `strict: true`, module/moduleResolution `NodeNext`.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Test databases go in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))`, never in the repo.
- Workflow fixtures use only elements from the Flow Fabric profile (design §4.1): script tasks, exclusive gateways, timer intermediate catch events, start/end events.
- `bpmn-engine` ships its own TypeScript types. If `tsc` reports missing declarations, add a minimal `packages/server/src/types/bpmn-engine.d.ts` with `declare module 'bpmn-engine';` — do not install `@types/bpmn-engine` (doesn't exist).
- Timer tests assert wall-clock windows with ±1.5 s slack; vitest `testTimeout: 20000`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/vitest.config.ts`, `packages/server/src/index.ts`, `packages/server/test/smoke.test.ts`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `packages/web/package.json` (placeholder)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: workspace where `pnpm -r build` and `pnpm -r test` run green; later tasks add files under `packages/server/src/engine-host/` and `packages/server/test/`.

- [ ] **Step 1: Write workspace + root config**

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
```

`package.json` (root):

```json
{
  "name": "flow-fabric",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

Append to `.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 2: Create packages**

`packages/server/package.json`:

```json
{
  "name": "@flowfabric/server",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run"
  },
  "dependencies": {
    "bpmn-engine": "^25",
    "better-sqlite3": "^12"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6",
    "@types/node": "^22",
    "tsx": "^4",
    "typescript": "^5",
    "vitest": "^3"
  }
}
```

`packages/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { testTimeout: 20000, hookTimeout: 20000 },
});
```

`packages/server/src/index.ts`:

```ts
export {};
```

`packages/server/test/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

`packages/shared/package.json`:

```json
{
  "name": "@flowfabric/shared",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc -p .", "test": "echo 'shared: no tests yet'" },
  "devDependencies": { "typescript": "^5" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/shared/src/index.ts`: `export {};`

`packages/web/package.json` (placeholder until M4):

```json
{
  "name": "@flowfabric/web",
  "private": true,
  "type": "module",
  "scripts": { "build": "echo 'web: placeholder until M4'", "test": "echo 'web: no tests yet'" }
}
```

- [ ] **Step 3: Install and verify**

Run: `pnpm install && pnpm build && pnpm test`
Expected: install succeeds (better-sqlite3 compiles its native module), builds green, smoke test PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo for M1 engine spike"
```

---

### Task 2: Prove bpmn-engine executes a profile-shaped fixture

**Files:**
- Create: `packages/server/test/fixtures/basic.bpmn`
- Test: `packages/server/test/engine-basics.test.ts`

**Interfaces:**
- Consumes: Task 1 workspace.
- Produces: `basic.bpmn` fixture reused by Task 3; confirmed listener event names (`activity.start`, `activity.end`) and script-task idiom (`this.environment.variables`, `next()`) used in all later fixtures.

- [ ] **Step 1: Write the fixture**

`packages/server/test/fixtures/basic.bpmn`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="basicDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="basicProcess" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="inc" />
    <scriptTask id="inc" scriptFormat="javascript">
      <script><![CDATA[
        this.environment.variables.count = (this.environment.variables.count || 0) + 1;
        next();
      ]]></script>
    </scriptTask>
    <sequenceFlow id="f2" sourceRef="inc" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>
```

- [ ] **Step 2: Write the failing test**

`packages/server/test/engine-basics.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Engine } from 'bpmn-engine';
import { describe, it, expect } from 'vitest';

const source = readFileSync(new URL('./fixtures/basic.bpmn', import.meta.url), 'utf8');

describe('bpmn-engine basics', () => {
  it('executes the fixture to completion and reports transitions', async () => {
    const engine = new Engine({ name: 'basic', source });
    const listener = new EventEmitter();
    const transitions: string[] = [];
    for (const ev of ['activity.start', 'activity.end']) {
      listener.on(ev, (api: { id: string }) => transitions.push(`${ev}:${api.id}`));
    }
    const ended = new Promise<void>((resolve, reject) => {
      engine.once('end', () => resolve());
      engine.once('error', reject);
    });
    await engine.execute({ listener });
    await ended;

    expect(transitions).toContain('activity.start:start');
    expect(transitions).toContain('activity.end:inc');
    expect(transitions).toContain('activity.end:end');

    const state = await engine.getState();
    expect(state.state).toBe('idle');
  });
});
```

- [ ] **Step 3: Run test to verify it currently fails only if engine misbehaves**

Run: `pnpm --filter @flowfabric/server test engine-basics`
Expected: PASS (this task probes the library, not our code — a FAIL here is itself a spike finding; record the error verbatim for Task 6).

- [ ] **Step 4: Commit**

```bash
git add packages/server/test
git commit -m "test: prove bpmn-engine executes profile-shaped fixture"
```

---

### Task 3: SQLite persistence — InstanceStore + EngineHost

**Files:**
- Create: `packages/server/src/engine-host/store.ts`
- Create: `packages/server/src/engine-host/engine-host.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/persistence.test.ts`

**Interfaces:**
- Consumes: `basic.bpmn` fixture from Task 2.
- Produces (used by Tasks 4–5):
  - `class InstanceStore { constructor(dbPath: string); createInstance(id: string, name: string, source: string): void; saveEngineState(id: string, stateJson: string): void; setStatus(id: string, status: InstanceStatus): void; appendEvent(instanceId: string, type: string, elementId?: string, detail?: string): void; getInstance(id: string): InstanceRow | undefined; listNonTerminal(): InstanceRow[]; listEvents(instanceId: string): EventRow[]; close(): void }`
  - `type InstanceStatus = 'running' | 'completed' | 'stopped' | 'error'`
  - `class EngineHost { constructor(store: InstanceStore); start(opts: { id: string; name: string; source: string; variables?: Record<string, unknown> }): Promise<void>; resumeAll(): Array<{ id: string; completion: Promise<void> }>; stopAll(): Promise<void> }`
  - `start()` resolves when the instance completes or stops; rejects on engine error.

- [ ] **Step 1: Write the failing test**

`packages/server/test/persistence.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const source = readFileSync(new URL('./fixtures/basic.bpmn', import.meta.url), 'utf8');

describe('persistence', () => {
  let store: InstanceStore;
  afterEach(() => store?.close());

  it('records instance, events, and state snapshots for a completed run', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
    store = new InstanceStore(path.join(dir, 'spike.db'));
    const host = new EngineHost(store);

    await host.start({ id: 'i1', name: 'basic', source });

    const row = store.getInstance('i1');
    expect(row?.status).toBe('completed');
    expect(row?.engineState).toBeTruthy();
    const state = JSON.parse(row!.engineState!);
    expect(state.state).toBe('idle');

    const events = store.listEvents('i1');
    const types = events.map((e) => `${e.type}:${e.elementId ?? ''}`);
    expect(types).toContain('activity.start:start');
    expect(types).toContain('activity.end:inc');
    expect(types).toContain('engine.end:');
    expect(store.listNonTerminal()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test persistence`
Expected: FAIL — cannot resolve `../src/engine-host/store.js`.

- [ ] **Step 3: Implement InstanceStore**

`packages/server/src/engine-host/store.ts`:

```ts
import Database from 'better-sqlite3';

export type InstanceStatus = 'running' | 'completed' | 'stopped' | 'error';

export interface InstanceRow {
  id: string;
  name: string;
  source: string;
  status: InstanceStatus;
  engineState: string | null;
}

export interface EventRow {
  seq: number;
  type: string;
  elementId: string | null;
  detail: string | null;
  ts: number;
}

export class InstanceStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        engine_state TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        type TEXT NOT NULL,
        element_id TEXT,
        detail TEXT,
        ts INTEGER NOT NULL
      );
    `);
  }

  createInstance(id: string, name: string, source: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO instances (id, name, source, status, engine_state, created_at, updated_at)
         VALUES (?, ?, ?, 'running', NULL, ?, ?)`,
      )
      .run(id, name, source, now, now);
  }

  saveEngineState(id: string, stateJson: string): void {
    this.db
      .prepare(`UPDATE instances SET engine_state = ?, updated_at = ? WHERE id = ?`)
      .run(stateJson, Date.now(), id);
  }

  setStatus(id: string, status: InstanceStatus): void {
    this.db
      .prepare(`UPDATE instances SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  appendEvent(instanceId: string, type: string, elementId?: string, detail?: string): void {
    this.db
      .prepare(`INSERT INTO events (instance_id, type, element_id, detail, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(instanceId, type, elementId ?? null, detail ?? null, Date.now());
  }

  getInstance(id: string): InstanceRow | undefined {
    const row = this.db
      .prepare(`SELECT id, name, source, status, engine_state AS engineState FROM instances WHERE id = ?`)
      .get(id) as InstanceRow | undefined;
    return row;
  }

  listNonTerminal(): InstanceRow[] {
    return this.db
      .prepare(
        `SELECT id, name, source, status, engine_state AS engineState
         FROM instances WHERE status IN ('running', 'stopped')`,
      )
      .all() as InstanceRow[];
  }

  listEvents(instanceId: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT seq, type, element_id AS elementId, detail, ts
         FROM events WHERE instance_id = ? ORDER BY seq`,
      )
      .all(instanceId) as EventRow[];
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Implement EngineHost**

`packages/server/src/engine-host/engine-host.ts`:

```ts
import { EventEmitter } from 'node:events';
import { Engine } from 'bpmn-engine';
import type { InstanceStore } from './store.js';

const SNAPSHOT_EVENTS = ['activity.start', 'activity.wait', 'activity.timer', 'activity.end'];

export class EngineHost {
  private running = new Map<string, InstanceType<typeof Engine>>();

  constructor(private store: InstanceStore) {}

  /** Start a new instance. Resolves on completion or stop; rejects on engine error. */
  async start(opts: {
    id: string;
    name: string;
    source: string;
    variables?: Record<string, unknown>;
  }): Promise<void> {
    this.store.createInstance(opts.id, opts.name, opts.source);
    const engine = new Engine({ name: opts.name, source: opts.source });
    await this.run(opts.id, engine, 'execute', opts.variables);
  }

  /** Recover and resume every non-terminal instance. Returns per-instance completion promises. */
  resumeAll(): Array<{ id: string; completion: Promise<void> }> {
    return this.store
      .listNonTerminal()
      .filter((row) => row.engineState !== null)
      .map((row) => {
        const engine = new Engine().recover(JSON.parse(row.engineState!));
        this.store.setStatus(row.id, 'running');
        return { id: row.id, completion: this.run(row.id, engine, 'resume') };
      });
  }

  /** Stop all running engines (final state snapshot is taken by run()). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((engine) => engine.stop()));
  }

  private async run(
    id: string,
    engine: InstanceType<typeof Engine>,
    mode: 'execute' | 'resume',
    variables?: Record<string, unknown>,
  ): Promise<void> {
    const listener = new EventEmitter();
    // getState() is async; serialize snapshots so writes never interleave.
    let queue: Promise<void> = Promise.resolve();
    const snapshot = () => {
      queue = queue
        .then(async () => {
          const state = await engine.getState();
          this.store.saveEngineState(id, JSON.stringify(state));
        })
        .catch(() => {});
    };
    for (const event of SNAPSHOT_EVENTS) {
      listener.on(event, (api: { id: string }) => {
        this.store.appendEvent(id, event, api.id);
        snapshot();
      });
    }

    const outcome = new Promise<'end' | 'stop'>((resolve, reject) => {
      engine.once('end', () => resolve('end'));
      engine.once('stop', () => resolve('stop'));
      engine.once('error', reject);
    });

    this.running.set(id, engine);
    try {
      if (mode === 'execute') await engine.execute({ listener, variables });
      else await engine.resume({ listener });
      const result = await outcome;
      await queue;
      const state = await engine.getState();
      this.store.saveEngineState(id, JSON.stringify(state));
      this.store.setStatus(id, result === 'end' ? 'completed' : 'stopped');
      this.store.appendEvent(id, `engine.${result}`);
    } catch (err) {
      await queue;
      this.store.setStatus(id, 'error');
      this.store.appendEvent(id, 'engine.error', undefined, String(err));
      throw err;
    } finally {
      this.running.delete(id);
    }
  }
}
```

Re-export from `packages/server/src/index.ts`:

```ts
export { InstanceStore } from './engine-host/store.js';
export type { InstanceRow, EventRow, InstanceStatus } from './engine-host/store.js';
export { EngineHost } from './engine-host/engine-host.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowfabric/server test persistence`
Expected: PASS. If `InstanceType<typeof Engine>` fails against the shipped types, substitute the library's exported engine type (check `node_modules/bpmn-engine/types`) — keep the public method signatures unchanged.

- [ ] **Step 6: Build + full test sweep, commit**

Run: `pnpm build && pnpm test`
Expected: all green.

```bash
git add packages/server
git commit -m "feat: engine-host with SQLite state persistence and event log"
```

---

### Task 4: Durable resume — in-process stop/resume and SIGKILL crash

This is the go/no-go heart of the spike: after a restart, a timer must fire at its **originally scheduled** time, not restart from zero.

**Files:**
- Create: `packages/server/test/fixtures/timer.bpmn`
- Create: `packages/server/scripts/spike-child.ts`
- Test: `packages/server/test/resume.test.ts`

**Interfaces:**
- Consumes: `InstanceStore`, `EngineHost` (Task 3 signatures).
- Produces: `timer.bpmn` (6 s timer fixture) and `spike-child.ts` (CLI: `spike-child.ts <dbPath> <instanceId>`) reused for Task 6 probes.

- [ ] **Step 1: Write the timer fixture**

`packages/server/test/fixtures/timer.bpmn`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="timerDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="timerProcess" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="before" />
    <scriptTask id="before" scriptFormat="javascript">
      <script><![CDATA[
        this.environment.variables.count = (this.environment.variables.count || 0) + 1;
        next();
      ]]></script>
    </scriptTask>
    <sequenceFlow id="f2" sourceRef="before" targetRef="wait" />
    <intermediateCatchEvent id="wait">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression">PT6S</timeDuration>
      </timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="f3" sourceRef="wait" targetRef="after" />
    <scriptTask id="after" scriptFormat="javascript">
      <script><![CDATA[
        this.environment.variables.count = (this.environment.variables.count || 0) + 1;
        next();
      ]]></script>
    </scriptTask>
    <sequenceFlow id="f4" sourceRef="after" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>
```

- [ ] **Step 2: Write the child runner script**

`packages/server/scripts/spike-child.ts`:

```ts
// Usage: node --import tsx scripts/spike-child.ts <dbPath> <instanceId>
// Starts the timer fixture and runs until killed (or completion).
import { readFileSync } from 'node:fs';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const [dbPath, instanceId] = process.argv.slice(2);
if (!dbPath || !instanceId) throw new Error('usage: spike-child.ts <dbPath> <instanceId>');

const source = readFileSync(new URL('../test/fixtures/timer.bpmn', import.meta.url), 'utf8');
const store = new InstanceStore(dbPath);
const host = new EngineHost(store);

await host.start({ id: instanceId, name: 'timer', source });
store.close();
```

- [ ] **Step 3: Write the failing tests**

`packages/server/test/resume.test.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const source = readFileSync(new URL('./fixtures/timer.bpmn', import.meta.url), 'utf8');
const TIMER_MS = 6000;
const SLACK_MS = 1500;

function tmpDb(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'ff-spike-')), 'spike.db');
}

async function waitForEvent(store: InstanceStore, id: string, type: string, elementId: string) {
  for (let i = 0; i < 100; i++) {
    if (store.listEvents(id).some((e) => e.type === type && e.elementId === elementId)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${type}:${elementId}`);
}

describe('durable resume', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('in-process: stop mid-timer, recover, resume; timer honors original schedule', async () => {
    const dbPath = tmpDb();
    const store1 = new InstanceStore(dbPath);
    stores.push(store1);
    const host1 = new EngineHost(store1);

    const startedAt = Date.now();
    const running = host1.start({ id: 'r1', name: 'timer', source });
    await waitForEvent(store1, 'r1', 'activity.wait', 'wait');
    await sleep(3000); // let ~3s of the 6s timer elapse
    await host1.stopAll();
    await running; // resolves as 'stopped'
    expect(store1.getInstance('r1')?.status).toBe('stopped');
    store1.close();

    // "Restart": fresh store + host over the same DB file.
    const store2 = new InstanceStore(dbPath);
    stores.push(store2);
    const host2 = new EngineHost(store2);
    const resumeStart = Date.now();
    const resumed = host2.resumeAll();
    expect(resumed.map((r) => r.id)).toEqual(['r1']);
    await resumed[0].completion;

    const resumeElapsed = Date.now() - resumeStart;
    const remaining = TIMER_MS - (resumeStart - startedAt);
    expect(store2.getInstance('r1')?.status).toBe('completed');
    // Go/no-go assertion: fires at original schedule (~remaining), not re-armed to full 6s.
    expect(resumeElapsed).toBeLessThan(Math.max(remaining, 0) + SLACK_MS);
  });

  it('SIGKILL: crash mid-timer, resume in this process, instance completes on schedule', async () => {
    const dbPath = tmpDb();
    const script = new URL('../scripts/spike-child.ts', import.meta.url).pathname;
    const child = spawn(process.execPath, ['--import', 'tsx', script, dbPath, 'k1'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: 'inherit',
    });
    const childStart = Date.now();

    const store = new InstanceStore(dbPath);
    stores.push(store);
    await waitForEvent(store, 'k1', 'activity.wait', 'wait');
    await sleep(3000);
    child.kill('SIGKILL');
    await sleep(500); // let the OS reap it

    // Crash leaves status 'running' — resumeAll must still pick it up.
    expect(store.getInstance('k1')?.status).toBe('running');

    const host = new EngineHost(store);
    const resumeStart = Date.now();
    const resumed = host.resumeAll();
    expect(resumed.map((r) => r.id)).toEqual(['k1']);
    await resumed[0].completion;

    const resumeElapsed = Date.now() - resumeStart;
    const remaining = TIMER_MS - (resumeStart - childStart);
    expect(store.getInstance('k1')?.status).toBe('completed');
    expect(resumeElapsed).toBeLessThan(Math.max(remaining, 0) + SLACK_MS);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test resume`
Expected: PASS if bpmn-engine honors persisted timer schedules.

**If the schedule assertion fails** (resume re-arms the full 6 s): this is a spike finding, not an immediate no-go. Inspect the persisted state JSON for the `wait` element (look for timer `startedAt` / `expireAt` fields), and probe whether a custom `timers` implementation passed via engine `environment` can compute the remaining delay. Record both the failure and the workaround assessment for Task 6; only if no workaround exists does the gate fail.

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "test: durable resume across stop and SIGKILL with timer schedule assertions"
```

---

### Task 5: Loop timer across restart (rfp-daily shape)

rfp-daily's "Wait 24 Hours" is a duration timer inside a gateway loop — not a `timeCycle`. This task proves that shape survives a restart mid-loop.

**Files:**
- Create: `packages/server/test/fixtures/loop.bpmn`
- Create: `packages/server/scripts/probe-timecycle.ts`
- Test: `packages/server/test/loop.test.ts`

**Interfaces:**
- Consumes: `InstanceStore`, `EngineHost` (Task 3 signatures).
- Produces: verified gateway-condition syntax for the profile (`next(null, …)` JavaScript conditions); `timeCycle` support verdict for Task 6.

- [ ] **Step 1: Write the loop fixture**

`packages/server/test/fixtures/loop.bpmn` — 3 iterations of work, 2 s wait between, default flow exits:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="loopDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="loopProcess" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="work" />
    <scriptTask id="work" scriptFormat="javascript">
      <script><![CDATA[
        this.environment.variables.count = (this.environment.variables.count || 0) + 1;
        next();
      ]]></script>
    </scriptTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="gw" />
    <exclusiveGateway id="gw" default="toEnd" />
    <sequenceFlow id="loop" sourceRef="gw" targetRef="wait">
      <conditionExpression xsi:type="tFormalExpression" language="javascript"><![CDATA[
        next(null, this.environment.variables.count < 3);
      ]]></conditionExpression>
    </sequenceFlow>
    <intermediateCatchEvent id="wait">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression">PT2S</timeDuration>
      </timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="back" sourceRef="wait" targetRef="work" />
    <sequenceFlow id="toEnd" sourceRef="gw" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>
```

- [ ] **Step 2: Write the failing test**

`packages/server/test/loop.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const source = readFileSync(new URL('./fixtures/loop.bpmn', import.meta.url), 'utf8');

describe('timer loop across restart', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('completes 3 iterations with a restart during the second wait', async () => {
    const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'ff-spike-')), 'spike.db');
    const store1 = new InstanceStore(dbPath);
    stores.push(store1);
    const host1 = new EngineHost(store1);

    const running = host1.start({ id: 'l1', name: 'loop', source });
    // Wait for the SECOND entry into the timer (one full loop done).
    for (let i = 0; i < 100; i++) {
      const waits = store1.listEvents('l1').filter(
        (e) => e.type === 'activity.wait' && e.elementId === 'wait',
      );
      if (waits.length >= 2) break;
      await sleep(100);
    }
    await host1.stopAll();
    await running;
    store1.close();

    const store2 = new InstanceStore(dbPath);
    stores.push(store2);
    const host2 = new EngineHost(store2);
    const resumed = host2.resumeAll();
    await Promise.all(resumed.map((r) => r.completion));

    expect(store2.getInstance('l1')?.status).toBe('completed');
    const workEnds = store2
      .listEvents('l1')
      .filter((e) => e.type === 'activity.end' && e.elementId === 'work');
    expect(workEnds).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run test**

Run: `pnpm --filter @flowfabric/server test loop`
Expected: PASS. A double-execution of `work` after resume (4+ `activity.end:work` events) is a critical finding — record exact event sequence for Task 6.

- [ ] **Step 4: Write the timeCycle probe (manual, findings input — not a unit test)**

`packages/server/scripts/probe-timecycle.ts`:

```ts
// Usage: node --import tsx scripts/probe-timecycle.ts
// Probes whether bpmn-engine supports timeCycle (R3/PT2S) on an intermediate catch event.
// Prints every listener event; run for ~10s and record behavior in the findings doc.
import { EventEmitter } from 'node:events';
import { Engine } from 'bpmn-engine';

const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="cycleDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="cycleProcess" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="wait" />
    <intermediateCatchEvent id="wait">
      <timerEventDefinition>
        <timeCycle xsi:type="tFormalExpression">R3/PT2S</timeCycle>
      </timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="f2" sourceRef="wait" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

const engine = new Engine({ name: 'cycle-probe', source });
const listener = new EventEmitter();
for (const ev of ['activity.start', 'activity.wait', 'activity.timer', 'activity.end']) {
  listener.on(ev, (api: { id: string }) => console.log(new Date().toISOString(), ev, api.id));
}
engine.once('end', () => console.log('ENGINE END'));
engine.once('error', (err: Error) => console.log('ENGINE ERROR', err.message));
await engine.execute({ listener });
```

Run: `cd packages/server && node --import tsx scripts/probe-timecycle.ts`
Expected: observe and note — fires once? cycles 3 times? errors? No assertion; the output goes into the Task 6 findings doc.

- [ ] **Step 5: Full sweep + commit**

Run: `pnpm build && pnpm test`
Expected: all green.

```bash
git add packages/server
git commit -m "test: loop timer survives restart; add timeCycle probe"
```

---

### Task 6: Spike findings + go/no-go gate

**Files:**
- Create: `docs/specs/findings_m1-spike.md`
- Modify (only if findings require): `docs/specs/design_flow-fabric.md` §4.2 (profile timer restrictions), §6.2

**Interfaces:**
- Consumes: test results and probe output from Tasks 2–5.
- Produces: the gate verdict that unblocks (or re-plans) M2.

- [ ] **Step 1: Run the full suite one final time and capture output**

Run: `pnpm build && pnpm test 2>&1 | tee /tmp/m1-final-run.txt` (use the session scratchpad dir if /tmp is unavailable)
Expected: all green, or a precise record of what failed.

- [ ] **Step 2: Run the timeCycle probe and record output**

Run: `cd packages/server && node --import tsx scripts/probe-timecycle.ts`

- [ ] **Step 3: Write the findings doc**

`docs/specs/findings_m1-spike.md` — fill every row from actual observed behavior; no speculation:

```markdown
# M1 Engine Spike — Findings

| | |
|---|---|
| Date | <fill> |
| bpmn-engine version | <from pnpm ls bpmn-engine> |
| Verdict | GO / GO-WITH-WORKAROUNDS / NO-GO |

## Questions and answers

| Question | Answer | Evidence |
|---|---|---|
| State serializes to JSON and recovers? | <fill> | persistence.test.ts |
| Timer honors original schedule after in-process stop/resume? | <fill> | resume.test.ts test 1, measured delay |
| Timer honors schedule after SIGKILL crash? | <fill> | resume.test.ts test 2 |
| SQLite/WAL intact after SIGKILL? | <fill> | resume.test.ts test 2 |
| Gateway loop + duration timer survives restart, no re-execution? | <fill> | loop.test.ts event counts |
| timeCycle (R3/PT2S) supported on intermediate catch? | <fill> | probe-timecycle.ts output |
| State snapshot size for a small process | <fill> bytes | inspect instances.engine_state |

## Workarounds required

<fill: e.g. custom environment timers for remaining-time computation, or "none">

## Profile amendments

<fill: e.g. "restrict FR-6 timers to timeDuration; model recurrence as gateway loops"
 — apply to design_flow-fabric.md §4.2 in this task if needed>

## Gate decision

<fill: GO → proceed to M2 plan. NO-GO → re-plan on custom interpreter fallback (design §1).>
```

- [ ] **Step 4: Apply any profile amendments to the design spec**

If the findings restrict timers (e.g. no `timeCycle`), update `docs/specs/design_flow-fabric.md` §4.2 supported-elements line to match reality. Skip if no amendments.

- [ ] **Step 5: Commit**

```bash
git add docs/specs packages/server
git commit -m "docs(specs): record M1 engine spike findings and gate verdict"
```

---

## Post-plan note

M2 (runners + failure ladder) gets its own plan after the gate reads GO. If the timer-schedule assertion failed but a `timers`-override workaround was validated, fold that workaround into the M2 plan's engine-host tasks.
