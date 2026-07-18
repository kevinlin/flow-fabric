# M3 Intake Implementation Plan — Profile, Linter, Patch Ops, Grill

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The real `rfp-daily-routine.bpmn` (Signavio export) becomes deployable through upload → lint → grill → versioned save, and `interview-process.bpmn` imports and lints (G2); the refined flagship dry-runs end-to-end (impl spec M3.1–M3.6).

**Architecture:** Four new server modules — `definitions` (immutable version store), `linter` (pure deployability gate, design §4.3), `patch-ops` (typed moddle edits that never touch DI, design §7.3), `grill` (Claude Agent SDK chat session whose only mutating tool is `propose_patch_ops`) — plus a daemon entrypoint (deferred from M2) and terminate-end status. `packages/shared` gains lint rule IDs/types and an `instanceInputs` profile extension. Spec: [impl_flow-fabric.md](impl_flow-fabric.md) M3, [design_flow-fabric.md](design_flow-fabric.md) §3, §4.3, §7, §8.

**Tech Stack:** Node 22, TypeScript (strict, ESM, NodeNext), pnpm workspaces, `bpmn-moddle` ^10, `better-sqlite3` ^12, `fastify` ^5, `@anthropic-ai/claude-agent-sdk` ^0.3 (with `createSdkMcpServer`/`tool` + `zod` ^4), vitest ^3.

## Global Constraints

- Node ≥ 22, pnpm ≥ 9. All packages `"type": "module"`, TS `strict: true`, module/moduleResolution `NodeNext`. Import local modules with the `.js` extension in TS source.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Test databases and workspaces go in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))` — never in the repo.
- `flowfabric` namespace is exactly `http://flowfabric.dev/schema/1.0` (design §4.2).
- Timers are `timeDuration` only (M1 finding). The linter rejects `timeCycle`/`timeDate`.
- **Gateway conditions are `language="javascript"` scripts with `next(null, <bool>)` semantics** — the format proven in M1/M2 and compiled by `createDispatch`'s `scripts` hook. Design §4.2's `${...}` expression format is NOT used: the scripts hook compiles every condition body with `new Function`, and a `${...}` body is a JS syntax error at registration. The linter accepts only javascript-language conditions; patch ops write them. Task 10 amends design §4.2 accordingly (same pattern as the M1 `timeCycle` amendment).
- `bpmn-moddle` v10 ships no types; the ambient `declare module 'bpmn-moddle'` shim in `packages/server/src/types/bpmn-moddle.d.ts` already covers it. Access moddle element shapes dynamically (`any`), matching `profile/read.ts`.
- `bpmn-engine` ships its own types; do not install `@types/bpmn-engine`.
- The Claude Agent SDK is configured by env only (`ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` from `.env`). Grill tests inject a mock `AgentQueryFn` — no live SDK calls in `pnpm test`.
- `Input/bpmn/*.bpmn` (real Signavio files) are git-ignored but present locally. Tests that read them must skip when absent: `it.skipIf(!existsSync(RFP_PATH))(...)`. Never copy them into `test/fixtures/`.
- Patch ops never edit XML text and never touch `<bpmndi:*>` sections except when an op *adds* an element (`addErrorBoundary` adds its own shape/edge). DI stability is asserted by normalize-compare: `applyPatchOps(xml, ops)` vs `applyPatchOps(xml, [])` (both sides pass through the same serializer, so formatting noise cancels out).
- M1/M2 files keep working — `pnpm test` stays green after every task. Extend, don't rewrite: existing public signatures may gain optional parameters but must not break existing callers (`buildApi` deps gain *optional* `definitions`/`grill`).
- Vitest `testTimeout: 20000` (already configured). Timer fixtures use 2–6 s durations.

## Task overview and dependencies

1. Shared profile additions: lint types + rule IDs, `instanceInputs` extension, `terminateEnds` in `readProfile`
2. `DefinitionStore` (immutable versions) + definitions upload/list/get API (impl M3.1)
3. Linter rules 1–3: unsupported elements, missing contracts, unevaluable gateway conditions (impl M3.2)
4. Linter rules 4–6 + lint API endpoint + refined fixture + real-file lint tests (impl M3.2)
5. Patch ops, in-place: `setTaskContract`, `setGatewayCondition`, `replaceLabel`, `setTimerDefinition`, `declareInstanceInput` (impl M3.3)
6. Patch ops, structural: `setTaskType`, `convertToTerminateEnd`, `addErrorBoundary` + DI-stability round-trip (impl M3.3, risk #3)
7. Grill session host: `GrillSession`/`GrillHost`, `propose_patch_ops` tool, re-lint feedback loop (impl M3.4)
8. Grill + instances-by-version API routes, grill SSE, daemon entrypoint (impl M3.4; daemon deferred from M2)
9. Terminate-end status + automated dry-run E2E of the refined fixture (impl M3.6 mechanics)
10. Real-file gate: grill CLI, grill rfp-daily + interview-process live, dry-run refined rfp-daily, design-doc amendments (impl M3.5 + M3.6 verify)

Dependencies: 3–4 need 1; 5–6 need 1; 7 needs 4+6 (and 2 for save-version); 8 needs 7; 9 needs 4 (fixture) + 8 (instances-by-version route); 10 needs everything. Tasks 2, 3, 5 are parallelizable after 1.

Known gap accepted for v1: the op set (design §7.3) has no `removeNode`, so an orphan node (rule 5) cannot be fixed by grilling — the user fixes it in the source editor and re-uploads. The grill briefing (Task 7) tells the agent to say exactly that when it meets an orphan finding.

---

### Task 1: Shared profile additions — lint types, `instanceInputs`, `terminateEnds`

The linter and definition store need shared types (`LintFinding`, `LintReport`, rule IDs — design says lint rule IDs live in `packages/shared`). Rule 4 and the `declareInstanceInput` patch op need a place in the XML for instance-input declarations: a `flowfabric:instanceInputs` extension on the *process* element. Task 9 needs to know which end events are terminate ends.

**Files:**
- Create: `packages/shared/src/lint/types.ts`
- Modify: `packages/shared/src/profile/descriptor.ts` (add `InstanceInputs` type)
- Modify: `packages/shared/src/index.ts` (exports)
- Modify: `packages/server/src/profile/read.ts` (`instanceInputs`, `terminateEnds`)
- Test: `packages/shared/test/profile.test.ts` (extend), `packages/server/test/profile-read.test.ts` (extend)

**Interfaces:**
- Consumes: existing `flowfabricModdle`, `InputDecl`, `ProcessProfile`.
- Produces (used by Tasks 3–9):
  - `LINT_RULES` — `{ UNSUPPORTED_ELEMENT: 'FF001', MISSING_CONTRACT: 'FF002', UNEVALUABLE_CONDITION: 'FF003', UNDECLARED_VARIABLE: 'FF004', ORPHAN_NODE: 'FF005', INSTRUCTION_LABEL: 'FF006' }`
  - `LintFinding { rule: LintRuleId; severity: 'error' | 'warning'; nodeId?: string; message: string }`
  - `LintReport { findings: LintFinding[]; errorCount: number; deployable: boolean }`
  - `ProcessProfile` gains `instanceInputs: InputDecl[]` and `terminateEnds: Set<string>`.
  - XML shape: `<bpmn:process><bpmn:extensionElements><flowfabric:instanceInputs><flowfabric:input name="submissionDeadline" type="string"/></flowfabric:instanceInputs></bpmn:extensionElements>...`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/profile.test.ts`:

```ts
describe('instanceInputs process extension', () => {
  const procXml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="iiDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="p" isExecutable="true">
    <extensionElements>
      <flowfabric:instanceInputs>
        <flowfabric:input name="submissionDeadline" type="string" />
      </flowfabric:instanceInputs>
    </extensionElements>
    <startEvent id="start" />
  </process>
</definitions>`;

  it('parses and round-trips instanceInputs', async () => {
    const m = moddle();
    const parsed = await m.fromXML(procXml);
    const proc = parsed.rootElement.rootElements.find((e: any) => e.$type === 'bpmn:Process');
    const ii = extensionOf(proc, 'flowfabric:InstanceInputs');
    expect(ii.inputs.map((i: any) => i.name)).toEqual(['submissionDeadline']);
    const { xml: reXml } = await m.toXML(parsed.rootElement, { format: true });
    expect(reXml).toContain('flowfabric:instanceInputs');
  });
});
```

Append to `packages/server/test/profile-read.test.ts` (reuse its existing imports/fixture style):

```ts
it('reads instanceInputs and terminateEnds', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="tDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="p" isExecutable="true">
    <extensionElements>
      <flowfabric:instanceInputs>
        <flowfabric:input name="deadline" type="string" />
      </flowfabric:instanceInputs>
    </extensionElements>
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="stop" />
    <endEvent id="stop"><terminateEventDefinition /></endEvent>
    <endEvent id="plainEnd" />
  </process>
</definitions>`;
  const profile = await readProfile(xml);
  expect(profile.instanceInputs).toEqual([{ name: 'deadline', type: 'string' }]);
  expect(profile.terminateEnds).toEqual(new Set(['stop']));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/shared test profile && pnpm --filter @flowfabric/server test profile-read`
Expected: FAIL — `InstanceInputs` unknown to the descriptor (extension parses as generic element without `inputs`), and `profile.instanceInputs` is `undefined`.

- [ ] **Step 3: Implement**

`packages/shared/src/lint/types.ts` (new):

```ts
export const LINT_RULES = {
  UNSUPPORTED_ELEMENT: 'FF001',
  MISSING_CONTRACT: 'FF002',
  UNEVALUABLE_CONDITION: 'FF003',
  UNDECLARED_VARIABLE: 'FF004',
  ORPHAN_NODE: 'FF005',
  INSTRUCTION_LABEL: 'FF006',
} as const;

export type LintRuleId = (typeof LINT_RULES)[keyof typeof LINT_RULES];

export interface LintFinding {
  rule: LintRuleId;
  severity: 'error' | 'warning';
  /** Flow node or sequence flow id the finding points at; absent for file-level findings. */
  nodeId?: string;
  message: string;
}

export interface LintReport {
  findings: LintFinding[];
  errorCount: number;
  /** Zero errors ⇒ deployable (FR-3). Warnings do not block. */
  deployable: boolean;
}
```

In `packages/shared/src/profile/descriptor.ts`, add to `types` (after the `Input` entry):

```ts
    {
      name: 'InstanceInputs',
      superClass: ['Element'],
      properties: [{ name: 'inputs', isMany: true, type: 'Input' }],
    },
```

In `packages/shared/src/index.ts`, add:

```ts
export { LINT_RULES } from './lint/types.js';
export type { LintRuleId, LintFinding, LintReport } from './lint/types.js';
```

In `packages/server/src/profile/read.ts`:
- extend the interface:

```ts
export interface ProcessProfile {
  contracts: Map<string, TaskContract>;
  errorBoundaryHosts: Set<string>;
  instanceInputs: InputDecl[];
  terminateEnds: Set<string>;
}
```

- initialise `const instanceInputs: InputDecl[] = []; const terminateEnds = new Set<string>();` alongside the existing collections, and inside the `bpmn:Process` loop add, before the `flowElements` loop:

```ts
    const ii = ext(root, 'flowfabric:InstanceInputs');
    if (ii) instanceInputs.push(...inputs(ii.inputs));
```

- in the `flowElements` loop add a branch:

```ts
      } else if (el.$type === 'bpmn:EndEvent') {
        const isTerminate = (el.eventDefinitions ?? []).some(
          (d: any) => d.$type === 'bpmn:TerminateEventDefinition',
        );
        if (isTerminate) terminateEnds.add(el.id);
```

- return `{ contracts, errorBoundaryHosts, instanceInputs, terminateEnds };`

- [ ] **Step 4: Run tests to verify they pass, plus the full suite**

Run: `pnpm build && pnpm test`
Expected: PASS everywhere (`readProfile` callers only gained fields).

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/server/src/profile/read.ts packages/server/test/profile-read.test.ts
git commit -m "feat(shared): lint rule types, instanceInputs extension, terminate-end profile info"
```

---

### Task 2: DefinitionStore — immutable versions + upload API (impl M3.1)

BPMN file store per design §3/§5: `definitions` and `definition_versions` tables, versions immutable, deployable flag from the lint report. Opens its own SQLite connection (WAL) — safe alongside `InstanceStore` on the same file.

**Files:**
- Create: `packages/server/src/definitions/store.ts`
- Modify: `packages/server/src/api/server.ts` (optional `definitions` dep + 3 routes)
- Modify: `packages/server/src/index.ts` (exports)
- Test: `packages/server/test/definitions.test.ts`

**Interfaces:**
- Consumes: `LintReport` from `@flowfabric/shared` (Task 1).
- Produces (used by Tasks 4, 7, 8, 9, 10):

```ts
interface DefinitionRow { id: string; name: string; createdAt: number }
interface DefinitionVersionRow {
  definitionId: string; versionNo: number; xml: string;
  lintReport: LintReport | null; deployable: boolean; createdAt: number;
}
class DefinitionStore {
  constructor(dbPath: string);
  upload(name: string, xml: string): { id: string; versionNo: number };   // creates definition + version 1
  saveVersion(definitionId: string, xml: string, lintReport?: LintReport): number; // next version_no
  setLintReport(definitionId: string, versionNo: number, report: LintReport): void;
  getDefinition(id: string): DefinitionRow | undefined;
  listDefinitions(): DefinitionRow[];
  getVersion(definitionId: string, versionNo: number): DefinitionVersionRow | undefined;
  getLatestVersion(definitionId: string): DefinitionVersionRow | undefined;
  close(): void;
}
```

- API routes: `POST /api/definitions` `{name, xml}` → 201 `{id, versionNo}`; `GET /api/definitions` → `{definitions}`; `GET /api/definitions/:id/versions/:v` → `{definitionId, versionNo, xml, lintReport, deployable}` (404 when missing). `v` may be `latest`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/definitions.test.ts`:

```ts
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DefinitionStore } from '../src/definitions/store.js';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { buildApi } from '../src/api/server.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const RFP_PATH = new URL('../../../Input/bpmn/rfp-daily-routine.bpmn', import.meta.url);
const INTERVIEW_PATH = new URL('../../../Input/bpmn/interview-process.bpmn', import.meta.url);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('DefinitionStore', () => {
  const stores: Array<{ close(): void }> = [];
  afterEach(() => stores.forEach((s) => s.close()));

  function defStore() {
    const store = new DefinitionStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    return store;
  }

  it('uploads a definition as version 1 and retrieves it', () => {
    const defs = defStore();
    const { id, versionNo } = defs.upload('contracts', contracts);
    expect(versionNo).toBe(1);
    expect(defs.getDefinition(id)?.name).toBe('contracts');
    const v = defs.getVersion(id, 1)!;
    expect(v.xml).toBe(contracts);
    expect(v.deployable).toBe(false);
    expect(v.lintReport).toBeNull();
  });

  it('saveVersion appends immutable versions and getLatestVersion returns the newest', () => {
    const defs = defStore();
    const { id } = defs.upload('contracts', contracts);
    const report = { findings: [], errorCount: 0, deployable: true };
    const v2 = defs.saveVersion(id, contracts.replace('Audit tracker', 'Audit tracker v2'), report);
    expect(v2).toBe(2);
    expect(defs.getLatestVersion(id)?.versionNo).toBe(2);
    expect(defs.getLatestVersion(id)?.deployable).toBe(true);
    // version 1 untouched
    expect(defs.getVersion(id, 1)?.xml).toBe(contracts);
  });

  it('setLintReport fills report + deployable without touching xml', () => {
    const defs = defStore();
    const { id } = defs.upload('contracts', contracts);
    defs.setLintReport(id, 1, { findings: [], errorCount: 0, deployable: true });
    const v = defs.getVersion(id, 1)!;
    expect(v.deployable).toBe(true);
    expect(v.xml).toBe(contracts);
  });

  it.skipIf(!existsSync(RFP_PATH))('uploads both real Input files (impl M3.1 verify)', () => {
    const defs = defStore();
    for (const url of [RFP_PATH, INTERVIEW_PATH]) {
      const xml = readFileSync(url, 'utf8');
      const { id } = defs.upload(path.basename(url.pathname, '.bpmn'), xml);
      expect(defs.getVersion(id, 1)?.xml).toBe(xml);
    }
    expect(defs.listDefinitions()).toHaveLength(2);
  });
});

describe('definitions API', () => {
  const stores: Array<{ close(): void }> = [];
  afterEach(() => stores.forEach((s) => s.close()));

  function build() {
    const dir = tmp();
    const store = new InstanceStore(path.join(dir, 'ff.db'));
    const definitions = new DefinitionStore(path.join(dir, 'ff.db'));
    stores.push(store, definitions);
    let inbox!: Inbox;
    const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
    inbox = new Inbox(store, host, { notify: async () => {} });
    return { app: buildApi({ store, host, inbox, definitions }), definitions };
  }

  it('uploads, lists, and fetches versions over HTTP', async () => {
    const { app } = build();
    const created = await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'contracts', xml: contracts },
    });
    expect(created.statusCode).toBe(201);
    const { id, versionNo } = created.json();
    expect(versionNo).toBe(1);

    const list = await app.inject({ method: 'GET', url: '/api/definitions' });
    expect(list.json().definitions.map((d: any) => d.id)).toContain(id);

    const v = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions/1` });
    expect(v.statusCode).toBe(200);
    expect(v.json().xml).toBe(contracts);

    const latest = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions/latest` });
    expect(latest.json().versionNo).toBe(1);

    const missing = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions/9` });
    expect(missing.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test definitions`
Expected: FAIL — `Cannot find module '../src/definitions/store.js'`.

- [ ] **Step 3: Implement the store**

`packages/server/src/definitions/store.ts`:

```ts
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { LintReport } from '@flowfabric/shared';

export interface DefinitionRow {
  id: string;
  name: string;
  createdAt: number;
}

export interface DefinitionVersionRow {
  definitionId: string;
  versionNo: number;
  xml: string;
  lintReport: LintReport | null;
  deployable: boolean;
  createdAt: number;
}

const VERSION_COLUMNS = `definition_id AS definitionId, version_no AS versionNo,
  xml, lint_report AS lintReport, deployable, created_at AS createdAt`;

type RawVersion = Omit<DefinitionVersionRow, 'lintReport' | 'deployable'> & {
  lintReport: string | null;
  deployable: number;
};

function coerce(row: RawVersion): DefinitionVersionRow {
  return {
    ...row,
    lintReport: row.lintReport ? (JSON.parse(row.lintReport) as LintReport) : null,
    deployable: !!row.deployable,
  };
}

/** BPMN file store: immutable versions, deployable flag (design §3, FR-4). */
export class DefinitionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS definition_versions (
        definition_id TEXT NOT NULL REFERENCES definitions(id),
        version_no INTEGER NOT NULL,
        xml TEXT NOT NULL,
        lint_report TEXT,
        deployable INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (definition_id, version_no)
      );
    `);
  }

  upload(name: string, xml: string): { id: string; versionNo: number } {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO definitions (id, name, created_at) VALUES (?, ?, ?)`)
      .run(id, name, Date.now());
    return { id, versionNo: this.saveVersion(id, xml) };
  }

  /** Appends the next version. Versions are immutable: xml is never updated (FR-4). */
  saveVersion(definitionId: string, xml: string, lintReport?: LintReport): number {
    if (!this.getDefinition(definitionId)) throw new Error(`no definition ${definitionId}`);
    const { next } = this.db
      .prepare(
        `SELECT COALESCE(MAX(version_no), 0) + 1 AS next
         FROM definition_versions WHERE definition_id = ?`,
      )
      .get(definitionId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO definition_versions
           (definition_id, version_no, xml, lint_report, deployable, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        definitionId,
        next,
        xml,
        lintReport ? JSON.stringify(lintReport) : null,
        lintReport?.deployable ? 1 : 0,
        Date.now(),
      );
    return next;
  }

  /** Records a lint run against an existing version (report only; xml stays immutable). */
  setLintReport(definitionId: string, versionNo: number, report: LintReport): void {
    const result = this.db
      .prepare(
        `UPDATE definition_versions SET lint_report = ?, deployable = ?
         WHERE definition_id = ? AND version_no = ?`,
      )
      .run(JSON.stringify(report), report.deployable ? 1 : 0, definitionId, versionNo);
    if (result.changes === 0) throw new Error(`no version ${versionNo} of ${definitionId}`);
  }

  getDefinition(id: string): DefinitionRow | undefined {
    return this.db
      .prepare(`SELECT id, name, created_at AS createdAt FROM definitions WHERE id = ?`)
      .get(id) as DefinitionRow | undefined;
  }

  listDefinitions(): DefinitionRow[] {
    return this.db
      .prepare(`SELECT id, name, created_at AS createdAt FROM definitions ORDER BY created_at`)
      .all() as DefinitionRow[];
  }

  getVersion(definitionId: string, versionNo: number): DefinitionVersionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM definition_versions
         WHERE definition_id = ? AND version_no = ?`,
      )
      .get(definitionId, versionNo) as RawVersion | undefined;
    return row ? coerce(row) : undefined;
  }

  getLatestVersion(definitionId: string): DefinitionVersionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM definition_versions
         WHERE definition_id = ? ORDER BY version_no DESC LIMIT 1`,
      )
      .get(definitionId) as RawVersion | undefined;
    return row ? coerce(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Wire the API routes**

In `packages/server/src/api/server.ts`:

```ts
import type { DefinitionStore } from '../definitions/store.js';

export interface ApiDeps {
  store: InstanceStore;
  host: EngineHost;
  inbox: Inbox;
  definitions?: DefinitionStore;
}
```

Inside `buildApi` (destructure `definitions` too), after the existing routes:

```ts
  if (definitions) {
    app.post('/api/definitions', async (req, reply) => {
      const { name, xml } = req.body as { name: string; xml: string };
      const { id, versionNo } = definitions.upload(name, xml);
      return reply.code(201).send({ id, versionNo });
    });

    app.get('/api/definitions', async () => ({ definitions: definitions.listDefinitions() }));

    app.get('/api/definitions/:id/versions/:v', async (req, reply) => {
      const { id, v } = req.params as { id: string; v: string };
      const version =
        v === 'latest' ? definitions.getLatestVersion(id) : definitions.getVersion(id, Number(v));
      if (!version) return reply.code(404).send({ error: 'not found' });
      return version;
    });
  }
```

Add to `packages/server/src/index.ts`:

```ts
export { DefinitionStore } from './definitions/store.js';
export type { DefinitionRow, DefinitionVersionRow } from './definitions/store.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @flowfabric/server test definitions && pnpm --filter @flowfabric/server test api`
Expected: PASS (existing api.test.ts untouched — `definitions` is optional).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/definitions packages/server/src/api/server.ts packages/server/src/index.ts packages/server/test/definitions.test.ts
git commit -m "feat(server): definition store with immutable versions and upload API (M3.1)"
```

---

### Task 3: Linter rules 1–3 — unsupported elements, missing contracts, unevaluable conditions (impl M3.2)

Pure function `lint(xml): Promise<LintReport>` (design §4.3). This task covers the three structural rules; Task 4 adds the graph rules and the label heuristic.

**Files:**
- Create: `packages/server/src/linter/lint.ts`
- Create: `packages/server/test/fixtures/messy.bpmn`
- Modify: `packages/server/src/index.ts` (export `lint`)
- Test: `packages/server/test/linter.test.ts`

**Interfaces:**
- Consumes: `LINT_RULES`, `LintFinding`, `LintReport`, `flowfabricModdle` (Task 1).
- Produces (used by Tasks 4, 7, 8): `async function lint(xml: string): Promise<LintReport>`. Element-scoped findings carry `nodeId`. Unparseable XML returns a single FF001 error finding (never throws).

- [ ] **Step 1: Create the messy fixture**

`packages/server/test/fixtures/messy.bpmn` — a miniature of what Signavio exports look like (generic tasks, prose gateway labels, instruction-bearing end label, no contracts). It is also the grill target in Task 7. Every rule below except FF005 must fire on it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:omgdc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:omgdi="http://www.omg.org/spec/DD/20100524/DI"
             id="messyDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="messyProcess" isExecutable="true">
    <startEvent id="start" name="Daily check starts" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="checkTracker" />
    <task id="checkTracker" name="Check the tracker" />
    <sequenceFlow id="f2" sourceRef="checkTracker" targetRef="gw" />
    <exclusiveGateway id="gw" name="At risk?" />
    <sequenceFlow id="flowYes" name="Yes" sourceRef="gw" targetRef="notify" />
    <sequenceFlow id="flowNo" name="No" sourceRef="gw" targetRef="endOk" />
    <task id="notify" name="Notify user" />
    <sequenceFlow id="f3" sourceRef="notify" targetRef="endStop" />
    <endEvent id="endOk" name="All good" />
    <endEvent id="endStop" name="Task ends here do not re-run" />
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="messyProcess">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start">
        <omgdc:Bounds x="100" y="100" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="checkTracker_di" bpmnElement="checkTracker">
        <omgdc:Bounds x="180" y="90" width="100" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gw_di" bpmnElement="gw">
        <omgdc:Bounds x="320" y="95" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="notify_di" bpmnElement="notify">
        <omgdc:Bounds x="410" y="90" width="100" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endOk_di" bpmnElement="endOk">
        <omgdc:Bounds x="330" y="200" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="endStop_di" bpmnElement="endStop">
        <omgdc:Bounds x="550" y="102" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="f1_di" bpmnElement="f1">
        <omgdi:waypoint x="136" y="118" /><omgdi:waypoint x="180" y="120" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2">
        <omgdi:waypoint x="280" y="120" /><omgdi:waypoint x="320" y="120" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flowYes_di" bpmnElement="flowYes">
        <omgdi:waypoint x="370" y="120" /><omgdi:waypoint x="410" y="120" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flowNo_di" bpmnElement="flowNo">
        <omgdi:waypoint x="345" y="145" /><omgdi:waypoint x="348" y="200" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f3_di" bpmnElement="f3">
        <omgdi:waypoint x="510" y="120" /><omgdi:waypoint x="550" y="120" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>
```

- [ ] **Step 2: Write the failing tests**

`packages/server/test/linter.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LINT_RULES, type LintReport } from '@flowfabric/shared';
import { lint } from '../src/linter/lint.js';

const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="d" targetNamespace="http://flowfabric.dev/spike">`;
const wrap = (body: string) => `${HEAD}<process id="p" isExecutable="true">${body}</process></definitions>`;

function byRule(report: LintReport, rule: string) {
  return report.findings.filter((f) => f.rule === rule);
}

describe('lint rule 1 — unsupported elements (FF001)', () => {
  it('flags generic tasks on the messy fixture', async () => {
    const report = await lint(messy);
    const ids = byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT).map((f) => f.nodeId);
    expect(ids).toContain('checkTracker');
    expect(ids).toContain('notify');
    expect(report.deployable).toBe(false);
  });

  it('flags parallel gateways and timeCycle timers', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="pg" />
      <parallelGateway id="pg" />
      <sequenceFlow id="f2" sourceRef="pg" targetRef="cycle" />
      <intermediateCatchEvent id="cycle">
        <timerEventDefinition><timeCycle xsi:type="tFormalExpression">R/PT24H</timeCycle></timerEventDefinition>
      </intermediateCatchEvent>
      <sequenceFlow id="f3" sourceRef="cycle" targetRef="end" />
      <endEvent id="end" />`));
    const ids = byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT).map((f) => f.nodeId);
    expect(ids).toContain('pg');
    expect(ids).toContain('cycle'); // timeDuration only (M1 finding)
  });

  it('accepts every profile element on the contracted fixture', async () => {
    const report = await lint(contracts);
    expect(byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT)).toEqual([]);
  });

  it('returns a single FF001 error for unparseable XML instead of throwing', async () => {
    const report = await lint('not xml at all');
    expect(report.errorCount).toBe(1);
    expect(report.findings[0].rule).toBe(LINT_RULES.UNSUPPORTED_ELEMENT);
  });
});

describe('lint rule 2 — missing contracts (FF002)', () => {
  it('flags serviceTask without prompt/outputSchema, scriptTask without command, userTask without formSchema', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
      <serviceTask id="svc" name="Agent w/o contract" />
      <sequenceFlow id="f2" sourceRef="svc" targetRef="scr" />
      <scriptTask id="scr" name="Code w/o command" />
      <sequenceFlow id="f3" sourceRef="scr" targetRef="usr" />
      <userTask id="usr" name="Human w/o form" />
      <sequenceFlow id="f4" sourceRef="usr" targetRef="end" />
      <endEvent id="end" />`));
    const ids = byRule(report, LINT_RULES.MISSING_CONTRACT).map((f) => f.nodeId);
    expect(ids).toEqual(expect.arrayContaining(['svc', 'scr', 'usr']));
  });

  it('flags an outputSchema that is not valid JSON', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
      <serviceTask id="svc">
        <extensionElements>
          <flowfabric:agentTask>
            <flowfabric:prompt>do things</flowfabric:prompt>
            <flowfabric:outputSchema>{broken</flowfabric:outputSchema>
          </flowfabric:agentTask>
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="f2" sourceRef="svc" targetRef="end" />
      <endEvent id="end" />`));
    expect(byRule(report, LINT_RULES.MISSING_CONTRACT).map((f) => f.nodeId)).toContain('svc');
  });

  it('passes the fully contracted fixture', async () => {
    const report = await lint(contracts);
    expect(byRule(report, LINT_RULES.MISSING_CONTRACT)).toEqual([]);
  });
});

describe('lint rule 3 — gateway conditions (FF003)', () => {
  it('flags prose-labelled flows without conditions on the messy fixture', async () => {
    const report = await lint(messy);
    const ids = byRule(report, LINT_RULES.UNEVALUABLE_CONDITION).map((f) => f.nodeId);
    expect(ids).toEqual(expect.arrayContaining(['flowYes', 'flowNo']));
  });

  it('accepts javascript conditions plus one default flow', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
      <exclusiveGateway id="gw" default="toB" />
      <sequenceFlow id="toA" sourceRef="gw" targetRef="endA">
        <conditionExpression xsi:type="tFormalExpression" language="javascript">
          const environment = this.environment; next(null, Boolean(environment.variables.x === true));
        </conditionExpression>
      </sequenceFlow>
      <sequenceFlow id="toB" sourceRef="gw" targetRef="endB" />
      <endEvent id="endA" /><endEvent id="endB" />`));
    expect(byRule(report, LINT_RULES.UNEVALUABLE_CONDITION)).toEqual([]);
  });

  it('rejects non-javascript condition formats (a ${...} body would crash the scripts hook)', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
      <exclusiveGateway id="gw" default="toB" />
      <sequenceFlow id="toA" sourceRef="gw" targetRef="endA">
        <conditionExpression xsi:type="tFormalExpression">\${environment.variables.x}</conditionExpression>
      </sequenceFlow>
      <sequenceFlow id="toB" sourceRef="gw" targetRef="endB" />
      <endEvent id="endA" /><endEvent id="endB" />`));
    expect(byRule(report, LINT_RULES.UNEVALUABLE_CONDITION).map((f) => f.nodeId)).toContain('toA');
  });

  it('ignores single-outgoing gateways (pure joins)', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="join" />
      <exclusiveGateway id="join" />
      <sequenceFlow id="f2" sourceRef="join" targetRef="end" />
      <endEvent id="end" />`));
    expect(byRule(report, LINT_RULES.UNEVALUABLE_CONDITION)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/server test linter`
Expected: FAIL — `Cannot find module '../src/linter/lint.js'`.

- [ ] **Step 4: Implement rules 1–3**

`packages/server/src/linter/lint.ts` (rules 4–6 are added in Task 4):

```ts
import { BpmnModdle } from 'bpmn-moddle';
import {
  flowfabricModdle,
  LINT_RULES,
  type LintFinding,
  type LintReport,
} from '@flowfabric/shared';

/** Structural elements that carry no execution semantics — allowed and ignored. */
const PASSIVE_TYPES = new Set([
  'bpmn:Collaboration', 'bpmn:Participant', 'bpmn:LaneSet', 'bpmn:Lane',
  'bpmn:TextAnnotation', 'bpmn:Association', 'bpmn:Group', 'bpmn:Category',
]);

const SUPPORTED_MESSAGE =
  'supported: start/end events (incl. terminate), exclusive gateways, user/script/service tasks, ' +
  'duration timer intermediate catch events, error boundary events (FR-6)';

function finding(
  rule: LintFinding['rule'],
  severity: LintFinding['severity'],
  message: string,
  nodeId?: string,
): LintFinding {
  return { rule, severity, message, ...(nodeId ? { nodeId } : {}) };
}

function report(findings: LintFinding[]): LintReport {
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  return { findings, errorCount, deployable: errorCount === 0 };
}

function defs(el: any): any[] {
  return el.eventDefinitions ?? [];
}

/** Deterministic deployability gate (FR-3, design §4.3). Pure; never throws. */
export async function lint(xml: string): Promise<LintReport> {
  const moddle = new BpmnModdle({ flowfabric: flowfabricModdle });
  let rootElement: any;
  try {
    ({ rootElement } = await moddle.fromXML(xml));
  } catch (err) {
    return report([
      finding(LINT_RULES.UNSUPPORTED_ELEMENT, 'error', `not parseable as BPMN 2.0: ${String(err)}`),
    ]);
  }

  const findings: LintFinding[] = [];
  for (const root of rootElement.rootElements ?? []) {
    if (root.$type === 'bpmn:Collaboration') {
      for (const mf of root.messageFlows ?? []) {
        findings.push(finding(
          LINT_RULES.UNSUPPORTED_ELEMENT, 'error',
          `message flows are not supported in v1; ${SUPPORTED_MESSAGE}`, mf.id,
        ));
      }
      continue;
    }
    if (root.$type !== 'bpmn:Process') continue;
    const elements: any[] = root.flowElements ?? [];
    ruleUnsupportedElements(elements, findings);
    ruleMissingContracts(elements, findings);
    ruleGatewayConditions(elements, findings);
  }
  return report(findings);
}

// Rule 1 (FF001): only profile elements may appear (FR-6).
function ruleUnsupportedElements(elements: any[], findings: LintFinding[]): void {
  const bad = (el: any, why: string) =>
    findings.push(finding(LINT_RULES.UNSUPPORTED_ELEMENT, 'error', `${why}; ${SUPPORTED_MESSAGE}`, el.id));

  for (const el of elements) {
    switch (el.$type) {
      case 'bpmn:SequenceFlow':
      case 'bpmn:ExclusiveGateway':
      case 'bpmn:UserTask':
      case 'bpmn:ScriptTask':
      case 'bpmn:ServiceTask':
        break;
      case 'bpmn:StartEvent':
        if (defs(el).length > 0) bad(el, `start event ${el.id} must be plain (no event definition)`);
        break;
      case 'bpmn:EndEvent': {
        const other = defs(el).filter((d: any) => d.$type !== 'bpmn:TerminateEventDefinition');
        if (other.length > 0) bad(el, `end event ${el.id} may only be plain or terminate`);
        break;
      }
      case 'bpmn:IntermediateCatchEvent': {
        const [def, ...rest] = defs(el);
        if (!def || rest.length > 0 || def.$type !== 'bpmn:TimerEventDefinition' || !def.timeDuration) {
          bad(el, `intermediate catch event ${el.id} must be a single timeDuration timer ` +
            `(timeCycle/timeDate fire once and break recurrence — M1 finding)`);
        }
        break;
      }
      case 'bpmn:BoundaryEvent': {
        const ok = defs(el).length === 1 && defs(el)[0].$type === 'bpmn:ErrorEventDefinition';
        if (!ok) bad(el, `boundary event ${el.id} must carry exactly one error event definition`);
        break;
      }
      default:
        if (!PASSIVE_TYPES.has(el.$type)) bad(el, `unsupported element ${el.$type} (${el.id})`);
    }
  }
}

// Rule 2 (FF002): every task carries its actor contract (FR-3).
function ruleMissingContracts(elements: any[], findings: LintFinding[]): void {
  const miss = (el: any, what: string) =>
    findings.push(finding(LINT_RULES.MISSING_CONTRACT, 'error', `${el.$type} ${el.id} ${what}`, el.id));
  const ext = (el: any, typeName: string) =>
    el.extensionElements?.values?.find((v: any) => v.$type === typeName);
  const jsonObject = (text: string | undefined) => {
    if (!text) return false;
    try {
      const parsed = JSON.parse(text);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  };

  for (const el of elements) {
    if (el.$type === 'bpmn:ServiceTask') {
      const a = ext(el, 'flowfabric:AgentTask');
      if (!a) miss(el, 'is missing its flowfabric:agentTask contract');
      else {
        if (!a.prompt?.text?.trim()) miss(el, 'has no agent prompt');
        if (!jsonObject(a.outputSchema?.text)) miss(el, 'has no valid JSON outputSchema');
      }
    } else if (el.$type === 'bpmn:ScriptTask') {
      const c = ext(el, 'flowfabric:CodeTask');
      if (!c) miss(el, 'is missing its flowfabric:codeTask contract');
      else {
        if (!c.command?.trim()) miss(el, 'has no command');
        if (!jsonObject(c.outputSchema?.text)) miss(el, 'has no valid JSON outputSchema');
      }
    } else if (el.$type === 'bpmn:UserTask') {
      const u = ext(el, 'flowfabric:UserTask');
      if (!u || !jsonObject(u.formSchema?.text)) miss(el, 'has no valid JSON formSchema');
    }
  }
}

// Rule 3 (FF003): every branching gateway path is evaluable (FR-3, FR-8).
function ruleGatewayConditions(elements: any[], findings: LintFinding[]): void {
  const flows = elements.filter((el) => el.$type === 'bpmn:SequenceFlow');
  for (const gw of elements) {
    if (gw.$type !== 'bpmn:ExclusiveGateway') continue;
    const outgoing = flows.filter((f) => f.sourceRef?.id === gw.id);
    if (outgoing.length <= 1) continue;
    for (const flow of outgoing) {
      if (gw.default?.id === flow.id) continue; // the one allowed unconditioned path
      const ce = flow.conditionExpression;
      const evaluable = !!ce?.body?.trim() && ce.language?.toLowerCase() === 'javascript';
      if (!evaluable) {
        const label = flow.name ? ` (label: "${flow.name}")` : '';
        findings.push(finding(
          LINT_RULES.UNEVALUABLE_CONDITION, 'error',
          `flow ${flow.id} out of gateway ${gw.id}${label} needs a javascript conditionExpression ` +
            `over process variables, or must be the gateway's default flow`,
          flow.id,
        ));
      }
    }
  }
}
```

Add to `packages/server/src/index.ts`:

```ts
export { lint } from './linter/lint.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @flowfabric/server test linter`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/linter packages/server/src/index.ts packages/server/test/linter.test.ts packages/server/test/fixtures/messy.bpmn
git commit -m "feat(server): linter rules 1-3 - element whitelist, contracts, gateway conditions (M3.2)"
```

---

### Task 4: Linter rules 4–6, lint endpoint, refined fixture, real-file assertions (impl M3.2)

Rule 4 (undeclared variables) needs graph reachability; rule 5 (orphans) reuses the same graph; rule 6 is the label heuristic. Then: the lint API endpoint stores the report per version, the raw rfp-daily must fail with specific findings, and a hand-refined fixture must pass. The refined fixture (`daily-loop-refined.bpmn`) mirrors the rfp-daily shape (init-check branch, audit loop, duration timer, terminate end) and is reused by Task 9's E2E.

**Files:**
- Modify: `packages/server/src/linter/lint.ts` (rules 4–6)
- Create: `packages/server/test/fixtures/daily-loop-refined.bpmn`
- Modify: `packages/server/src/api/server.ts` (lint route)
- Test: `packages/server/test/linter.test.ts` (extend), `packages/server/test/definitions.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `lint` internals (`finding`, `PASSIVE_TYPES`), Task 2's `DefinitionStore.setLintReport`.
- Produces: complete `lint()`; route `POST /api/definitions/:id/versions/:v/lint` → 200 `LintReport` (also persisted on the version); fixture `daily-loop-refined.bpmn` with node ids `start, checkInit, gwInit, provideDeadline, updateTracker, endInit, auditTracker, reviewCycle, gwLoop, wait24h, endDone` (Task 9 relies on these exact ids).

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/linter.test.ts` (add `existsSync` to the `node:fs` import):

```ts
const refined = readFileSync(new URL('./fixtures/daily-loop-refined.bpmn', import.meta.url), 'utf8');
const RFP_PATH = new URL('../../../Input/bpmn/rfp-daily-routine.bpmn', import.meta.url);
const INTERVIEW_PATH = new URL('../../../Input/bpmn/interview-process.bpmn', import.meta.url);

describe('lint rule 4 — undeclared variables (FF004)', () => {
  it('flags an input no upstream task produces and no instance input declares', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
      <serviceTask id="svc">
        <extensionElements>
          <flowfabric:agentTask>
            <flowfabric:prompt>audit</flowfabric:prompt>
            <flowfabric:input name="deadline" type="string" />
            <flowfabric:outputSchema>{"type":"object","properties":{"ok":{"type":"boolean"}}}</flowfabric:outputSchema>
          </flowfabric:agentTask>
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="f2" sourceRef="svc" targetRef="end" />
      <endEvent id="end" />`));
    const found = byRule(report, LINT_RULES.UNDECLARED_VARIABLE);
    expect(found.map((f) => f.nodeId)).toContain('svc');
    expect(found[0].message).toContain('deadline');
  });

  it('accepts variables produced upstream, declared as instance inputs, or referenced by conditions', async () => {
    const report = await lint(wrap(`
      <extensionElements>
        <flowfabric:instanceInputs><flowfabric:input name="deadline" type="string" /></flowfabric:instanceInputs>
      </extensionElements>
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
      <serviceTask id="svc">
        <extensionElements>
          <flowfabric:agentTask>
            <flowfabric:prompt>audit</flowfabric:prompt>
            <flowfabric:input name="deadline" type="string" />
            <flowfabric:outputSchema>{"type":"object","properties":{"atRisk":{"type":"boolean"}}}</flowfabric:outputSchema>
          </flowfabric:agentTask>
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="f2" sourceRef="svc" targetRef="gw" />
      <exclusiveGateway id="gw" default="toB" />
      <sequenceFlow id="toA" sourceRef="gw" targetRef="endA">
        <conditionExpression xsi:type="tFormalExpression" language="javascript">
          const environment = this.environment; next(null, Boolean(environment.variables.atRisk === true));
        </conditionExpression>
      </sequenceFlow>
      <sequenceFlow id="toB" sourceRef="gw" targetRef="endB" />
      <endEvent id="endA" /><endEvent id="endB" />`));
    expect(byRule(report, LINT_RULES.UNDECLARED_VARIABLE)).toEqual([]);
  });

  it('flags a condition variable produced only downstream of the gateway', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
      <exclusiveGateway id="gw" default="toB" />
      <sequenceFlow id="toA" sourceRef="gw" targetRef="svc">
        <conditionExpression xsi:type="tFormalExpression" language="javascript">
          const environment = this.environment; next(null, Boolean(environment.variables.atRisk === true));
        </conditionExpression>
      </sequenceFlow>
      <serviceTask id="svc">
        <extensionElements>
          <flowfabric:agentTask>
            <flowfabric:prompt>audit</flowfabric:prompt>
            <flowfabric:outputSchema>{"type":"object","properties":{"atRisk":{"type":"boolean"}}}</flowfabric:outputSchema>
          </flowfabric:agentTask>
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="f2" sourceRef="svc" targetRef="endA" />
      <sequenceFlow id="toB" sourceRef="gw" targetRef="endB" />
      <endEvent id="endA" /><endEvent id="endB" />`));
    expect(byRule(report, LINT_RULES.UNDECLARED_VARIABLE).map((f) => f.nodeId)).toContain('gw');
  });
});

describe('lint rule 5 — orphan nodes (FF005)', () => {
  it('flags nodes unreachable from the start event', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="end" />
      <endEvent id="end" />
      <userTask id="orphan" name="Old step">
        <extensionElements>
          <flowfabric:userTask><flowfabric:formSchema>{"type":"object"}</flowfabric:formSchema></flowfabric:userTask>
        </extensionElements>
      </userTask>`));
    expect(byRule(report, LINT_RULES.ORPHAN_NODE).map((f) => f.nodeId)).toEqual(['orphan']);
  });

  it('treats boundary events and their handler paths as reachable', async () => {
    const report = await lint(contracts.replace(
      '<endEvent id="end" />',
      `<endEvent id="end" />
       <boundaryEvent id="guard" attachedToRef="agentTask"><errorEventDefinition /></boundaryEvent>
       <sequenceFlow id="fErr" sourceRef="guard" targetRef="endErr" />
       <endEvent id="endErr" />`,
    ));
    expect(byRule(report, LINT_RULES.ORPHAN_NODE)).toEqual([]);
  });
});

describe('lint rule 6 — instruction-bearing labels (FF006)', () => {
  it('warns on "do not re-run" / "ends here" labels without blocking deployment', async () => {
    const report = await lint(messy);
    const found = byRule(report, LINT_RULES.INSTRUCTION_LABEL);
    expect(found.map((f) => f.nodeId)).toContain('endStop');
    expect(found.every((f) => f.severity === 'warning')).toBe(true);
  });
});

describe('lint verdicts on whole files (impl M3.2 verify)', () => {
  it('hand-refined daily-loop fixture is deployable', async () => {
    const report = await lint(refined);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.deployable).toBe(true);
  });

  it.skipIf(!existsSync(RFP_PATH))('raw rfp-daily fails with generic-task, condition, and label findings', async () => {
    const report = await lint(readFileSync(RFP_PATH, 'utf8'));
    expect(report.deployable).toBe(false);
    const rules = new Set(report.findings.map((f) => f.rule));
    expect(rules).toContain(LINT_RULES.UNSUPPORTED_ELEMENT);   // 19 generic <task> elements
    expect(rules).toContain(LINT_RULES.UNEVALUABLE_CONDITION); // prose gateway labels ("Yes"/"No")
    expect(rules).toContain(LINT_RULES.INSTRUCTION_LABEL);     // "Task Ends Here Do No Re-Run"
  });

  it.skipIf(!existsSync(INTERVIEW_PATH))('interview-process lints: no unsupported elements, but contracts and conditions missing', async () => {
    const report = await lint(readFileSync(INTERVIEW_PATH, 'utf8'));
    expect(report.deployable).toBe(false);
    const rules = new Set(report.findings.map((f) => f.rule));
    expect(rules).toContain(LINT_RULES.MISSING_CONTRACT);      // 13 userTasks without formSchema
    expect(rules).toContain(LINT_RULES.UNEVALUABLE_CONDITION); // 6 gateways without conditions
    expect(byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT)).toEqual([]); // userTasks + terminate ends are profile elements
  });
});
```

Append to `packages/server/test/definitions.test.ts`, inside the `definitions API` describe:

```ts
  it('lints a version on demand and stores the report', async () => {
    const { app, definitions } = build();
    const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
    const { id } = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'messy', xml: messy },
    })).json();
    const res = await app.inject({ method: 'POST', url: `/api/definitions/${id}/versions/1/lint` });
    expect(res.statusCode).toBe(200);
    expect(res.json().deployable).toBe(false);
    expect(definitions.getVersion(id, 1)?.lintReport?.errorCount).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/server test linter`
Expected: FAIL — rules 4–6 not implemented, `daily-loop-refined.bpmn` missing.

- [ ] **Step 3: Implement rules 4–6**

In `packages/server/src/linter/lint.ts`, replace the three rule calls in the process loop with:

```ts
    const elements: any[] = root.flowElements ?? [];
    ruleUnsupportedElements(elements, findings);
    ruleMissingContracts(elements, findings);
    ruleGatewayConditions(elements, findings);
    const graph = buildGraph(elements);
    ruleUndeclaredVariables(root, elements, graph, findings);
    ruleOrphanNodes(elements, graph, findings);
    ruleInstructionLabels(elements, findings);
```

And append the new rule functions:

```ts
interface Graph {
  /** nodeId -> directly following nodeIds (sequence flows + host->boundary). */
  next: Map<string, string[]>;
  nodeIds: Set<string>;
}

function buildGraph(elements: any[]): Graph {
  const next = new Map<string, string[]>();
  const nodeIds = new Set<string>();
  const push = (from: string, to: string) => {
    if (!next.has(from)) next.set(from, []);
    next.get(from)!.push(to);
  };
  for (const el of elements) {
    if (el.$type === 'bpmn:SequenceFlow') {
      if (el.sourceRef?.id && el.targetRef?.id) push(el.sourceRef.id, el.targetRef.id);
    } else if (!PASSIVE_TYPES.has(el.$type)) {
      nodeIds.add(el.id);
      // a boundary event is reachable whenever its host is
      if (el.$type === 'bpmn:BoundaryEvent' && el.attachedToRef?.id) push(el.attachedToRef.id, el.id);
    }
  }
  return { next, nodeIds };
}

function reachableFrom(graph: Graph, startIds: string[]): Set<string> {
  const seen = new Set<string>(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    for (const to of graph.next.get(queue.shift()!) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

const CONDITION_VAR = /environment\.variables\.([A-Za-z_$][A-Za-z0-9_$]*)/g;

// Rule 4 (FF004): every consumed variable is produced strictly upstream or declared
// as an instance input (FR-3). "Upstream" = the consumer is reachable from the producer.
function ruleUndeclaredVariables(proc: any, elements: any[], graph: Graph, findings: LintFinding[]): void {
  const ext = (el: any, typeName: string) =>
    el.extensionElements?.values?.find((v: any) => v.$type === typeName);
  const schemaProps = (text: string | undefined): string[] => {
    try {
      return Object.keys(JSON.parse(text ?? '{}').properties ?? {});
    } catch {
      return [];
    }
  };

  const instanceInputs = new Set<string>(
    (ext(proc, 'flowfabric:InstanceInputs')?.inputs ?? []).map((i: any) => i.name),
  );

  const producers = new Map<string, string[]>(); // variable name -> producing node ids
  const produce = (name: string, nodeId: string) => {
    if (!producers.has(name)) producers.set(name, []);
    producers.get(name)!.push(nodeId);
  };
  for (const el of elements) {
    const contract = ext(el, 'flowfabric:AgentTask') ?? ext(el, 'flowfabric:CodeTask');
    if (contract) for (const p of schemaProps(contract.outputSchema?.text)) produce(p, el.id);
    const user = ext(el, 'flowfabric:UserTask');
    if (user) for (const p of schemaProps(user.formSchema?.text)) produce(p, el.id);
  }

  // consumers: declared task inputs + variables referenced in gateway conditions
  const consumers: Array<{ nodeId: string; variable: string }> = [];
  for (const el of elements) {
    const contract = ext(el, 'flowfabric:AgentTask') ?? ext(el, 'flowfabric:CodeTask');
    for (const input of contract?.inputs ?? []) consumers.push({ nodeId: el.id, variable: input.name });
    if (el.$type === 'bpmn:SequenceFlow' && el.conditionExpression?.body && el.sourceRef?.id) {
      for (const m of el.conditionExpression.body.matchAll(CONDITION_VAR)) {
        consumers.push({ nodeId: el.sourceRef.id, variable: m[1] });
      }
    }
  }

  const reachCache = new Map<string, Set<string>>();
  const reaches = (from: string, to: string) => {
    if (!reachCache.has(from)) reachCache.set(from, reachableFrom(graph, graph.next.get(from) ?? []));
    return reachCache.get(from)!.has(to);
  };

  const flagged = new Set<string>();
  for (const { nodeId, variable } of consumers) {
    if (instanceInputs.has(variable)) continue;
    const ok = (producers.get(variable) ?? []).some((p) => p !== nodeId && reaches(p, nodeId));
    const key = `${nodeId}:${variable}`;
    if (!ok && !flagged.has(key)) {
      flagged.add(key);
      findings.push(finding(
        LINT_RULES.UNDECLARED_VARIABLE, 'error',
        `variable "${variable}" used at ${nodeId} is not produced upstream and not declared as an instance input`,
        nodeId,
      ));
    }
  }
}

// Rule 5 (FF005): every flow node is reachable from a start event.
function ruleOrphanNodes(elements: any[], graph: Graph, findings: LintFinding[]): void {
  const startIds = elements.filter((el) => el.$type === 'bpmn:StartEvent').map((el) => el.id);
  const reachable = reachableFrom(graph, startIds);
  for (const id of graph.nodeIds) {
    if (!reachable.has(id)) {
      findings.push(finding(
        LINT_RULES.ORPHAN_NODE, 'error',
        `node ${id} is unreachable from any start event; no removeNode patch op exists — delete it in the source editor and re-upload`,
        id,
      ));
    }
  }
}

// Rule 6 (FF006): instruction-bearing labels belong in BPMN semantics, not prose.
const INSTRUCTION_LABEL = /(do\s+no?t?\s+re-?\s?run|ends?\s+here)/i;

function ruleInstructionLabels(elements: any[], findings: LintFinding[]): void {
  for (const el of elements) {
    if (el.$type === 'bpmn:SequenceFlow' || PASSIVE_TYPES.has(el.$type)) continue;
    if (typeof el.name === 'string' && INSTRUCTION_LABEL.test(el.name)) {
      findings.push(finding(
        LINT_RULES.INSTRUCTION_LABEL, 'warning',
        `label "${el.name}" on ${el.id} carries execution instructions; model it as a terminate end event or loop condition instead`,
        el.id,
      ));
    }
  }
}
```

- [ ] **Step 4: Create the refined fixture**

`packages/server/test/fixtures/daily-loop-refined.bpmn` — the rfp-daily shape, fully contracted, deployable. Timer is `PT2S` so Task 9's E2E can loop inside the test timeout:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="dailyLoopDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="dailyLoop" isExecutable="true">
    <extensionElements>
      <flowfabric:instanceInputs>
        <flowfabric:input name="submissionDeadline" type="string" />
      </flowfabric:instanceInputs>
    </extensionElements>
    <startEvent id="start" name="Daily run starts" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="checkInit" />
    <serviceTask id="checkInit" name="Check input folder for initializer">
      <extensionElements>
        <flowfabric:agentTask retries="1" timeoutSeconds="120">
          <flowfabric:prompt>Check whether the workspace Input folder contains an initializer file.</flowfabric:prompt>
          <flowfabric:tools>Read,Glob</flowfabric:tools>
          <flowfabric:outputSchema>{"type":"object","required":["containsInitializer"],"properties":{"containsInitializer":{"type":"boolean"}},"additionalProperties":true}</flowfabric:outputSchema>
        </flowfabric:agentTask>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="checkInit" targetRef="gwInit" />
    <exclusiveGateway id="gwInit" name="Contains initializer?" default="toAudit" />
    <sequenceFlow id="toInit" sourceRef="gwInit" targetRef="provideDeadline">
      <conditionExpression xsi:type="tFormalExpression" language="javascript"><![CDATA[
        const environment = this.environment; next(null, Boolean(environment.variables.containsInitializer === false));
      ]]></conditionExpression>
    </sequenceFlow>
    <userTask id="provideDeadline" name="Provide submission deadline">
      <extensionElements>
        <flowfabric:userTask>
          <flowfabric:formSchema>{"type":"object","required":["submissionDeadline"],"properties":{"submissionDeadline":{"type":"string"}},"additionalProperties":false}</flowfabric:formSchema>
        </flowfabric:userTask>
      </extensionElements>
    </userTask>
    <sequenceFlow id="f3" sourceRef="provideDeadline" targetRef="updateTracker" />
    <scriptTask id="updateTracker" name="Update tracker with deadline">
      <extensionElements>
        <flowfabric:codeTask command="node -e &quot;console.log(JSON.stringify({trackerUpdated:true}))&quot;" retries="1" timeoutSeconds="30">
          <flowfabric:input name="submissionDeadline" type="string" />
          <flowfabric:outputSchema>{"type":"object","required":["trackerUpdated"],"properties":{"trackerUpdated":{"type":"boolean"}},"additionalProperties":true}</flowfabric:outputSchema>
        </flowfabric:codeTask>
      </extensionElements>
    </scriptTask>
    <sequenceFlow id="f4" sourceRef="updateTracker" targetRef="endInit" />
    <endEvent id="endInit" name="Initialisation complete">
      <terminateEventDefinition />
    </endEvent>
    <sequenceFlow id="toAudit" sourceRef="gwInit" targetRef="auditTracker" />
    <serviceTask id="auditTracker" name="Audit tracker for at-risk tasks">
      <extensionElements>
        <flowfabric:agentTask retries="1" timeoutSeconds="300">
          <flowfabric:prompt>Audit the project tracker; flag tasks at risk against the submission deadline.</flowfabric:prompt>
          <flowfabric:tools>Read,Grep,Glob</flowfabric:tools>
          <flowfabric:boundaries>Never modify files outside the tracker folder.</flowfabric:boundaries>
          <flowfabric:input name="submissionDeadline" type="string" />
          <flowfabric:outputSchema>{"type":"object","required":["atRiskTasks"],"properties":{"atRiskTasks":{"type":"array","items":{"type":"string"}}},"additionalProperties":true}</flowfabric:outputSchema>
        </flowfabric:agentTask>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f5" sourceRef="auditTracker" targetRef="reviewCycle" />
    <userTask id="reviewCycle" name="Review daily result">
      <extensionElements>
        <flowfabric:userTask>
          <flowfabric:formSchema>{"type":"object","required":["continueLoop"],"properties":{"continueLoop":{"type":"boolean"}},"additionalProperties":false}</flowfabric:formSchema>
        </flowfabric:userTask>
      </extensionElements>
    </userTask>
    <sequenceFlow id="f6" sourceRef="reviewCycle" targetRef="gwLoop" />
    <exclusiveGateway id="gwLoop" name="Run another cycle?" default="toDone" />
    <sequenceFlow id="toWait" sourceRef="gwLoop" targetRef="wait24h">
      <conditionExpression xsi:type="tFormalExpression" language="javascript"><![CDATA[
        const environment = this.environment; next(null, Boolean(environment.variables.continueLoop === true));
      ]]></conditionExpression>
    </sequenceFlow>
    <intermediateCatchEvent id="wait24h" name="Wait for next cycle">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression">PT2S</timeDuration>
      </timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="f7" sourceRef="wait24h" targetRef="auditTracker" />
    <sequenceFlow id="toDone" sourceRef="gwLoop" targetRef="endDone" />
    <endEvent id="endDone" name="Daily run complete" />
  </process>
</definitions>
```

- [ ] **Step 5: Wire the lint endpoint**

In `packages/server/src/api/server.ts`, add `import { lint } from '../linter/lint.js';` and, inside the `if (definitions)` block:

```ts
    app.post('/api/definitions/:id/versions/:v/lint', async (req, reply) => {
      const { id, v } = req.params as { id: string; v: string };
      const version =
        v === 'latest' ? definitions.getLatestVersion(id) : definitions.getVersion(id, Number(v));
      if (!version) return reply.code(404).send({ error: 'not found' });
      const report = await lint(version.xml);
      definitions.setLintReport(version.definitionId, version.versionNo, report);
      return report;
    });
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm build && pnpm test`
Expected: PASS, including the two `skipIf` real-file tests on this machine (Input files present). If the raw-rfp assertions fail on finding classes, read the actual report before touching the rules — the fixture assumptions (19 generic `<task>`, prose flow labels, no conditions, "Do No Re-Run" labels) were verified against the file on 2026-07-18.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/linter packages/server/src/api/server.ts packages/server/test
git commit -m "feat(server): linter rules 4-6, lint endpoint, refined daily-loop fixture (M3.2)"
```

---

### Task 5: Patch ops — in-place operations (impl M3.3)

`applyPatchOps(xml, ops)` parses once with moddle, applies typed ops to the model tree, serializes once. This task implements the five ops that mutate existing elements without changing the node set: `setTaskContract`, `setGatewayCondition`, `replaceLabel`, `setTimerDefinition`, `declareInstanceInput`. Structural ops follow in Task 6. The agent never edits XML directly, so DI layout is untouched by construction (design §7, risk #3).

**Files:**
- Create: `packages/server/src/patch-ops/apply.ts`
- Modify: `packages/server/src/index.ts` (exports)
- Test: `packages/server/test/patch-ops.test.ts`

**Interfaces:**
- Consumes: `flowfabricModdle`, `TaskContract` (shared), `readProfile` + `lint` in tests.
- Produces (used by Tasks 6, 7):

```ts
type PatchOp =
  | { op: 'setTaskType'; nodeId: string; bpmnType: 'bpmn:UserTask' | 'bpmn:ScriptTask' | 'bpmn:ServiceTask' }
  | { op: 'setTaskContract'; nodeId: string; contract: TaskContract }
  | { op: 'setGatewayCondition'; flowId: string; expression: string; isDefault?: boolean }
  | { op: 'replaceLabel'; nodeId: string; newLabel: string }
  | { op: 'convertToTerminateEnd'; nodeId: string }
  | { op: 'addErrorBoundary'; nodeId: string; targetId: string }
  | { op: 'setTimerDefinition'; nodeId: string; iso8601: string }
  | { op: 'declareInstanceInput'; name: string; type: string };
interface PatchDiff { op: string; target: string; summary: string }
interface PatchResult { xml: string; diff: PatchDiff[] }
class PatchOpError extends Error {}
async function applyPatchOps(xml: string, ops: PatchOp[]): Promise<PatchResult>
```

- `setGatewayCondition` convention: `expression` is a JS boolean expression over `environment.variables.<name>`; the op wraps it as `const environment = this.environment; next(null, Boolean(<expression>));` with `language="javascript"` — exactly the format rule 3 accepts and `createDispatch` compiles. `isDefault: true` sets the gateway `default` attribute and strips any condition from the flow.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/patch-ops.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LINT_RULES } from '@flowfabric/shared';
import { applyPatchOps, PatchOpError } from '../src/patch-ops/apply.js';
import { readProfile } from '../src/profile/read.js';
import { lint } from '../src/linter/lint.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');

describe('applyPatchOps — in-place ops', () => {
  it('setTaskContract writes an agent contract readable by readProfile', async () => {
    const { xml, diff } = await applyPatchOps(contracts, [{
      op: 'setTaskContract',
      nodeId: 'agentTask',
      contract: {
        kind: 'agent', retries: 3, timeoutSeconds: 120,
        prompt: 'New prompt', tools: ['Read'], boundaries: 'Stay in docs/',
        inputs: [{ name: 'deadline', type: 'string' }],
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      },
    }]);
    const profile = await readProfile(xml);
    const contract = profile.contracts.get('agentTask');
    expect(contract).toMatchObject({ kind: 'agent', retries: 3, prompt: 'New prompt', tools: ['Read'] });
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ op: 'setTaskContract', target: 'agentTask' });
  });

  it('setTaskContract rejects a contract kind that does not match the element type', async () => {
    await expect(applyPatchOps(contracts, [{
      op: 'setTaskContract', nodeId: 'agentTask',
      contract: { kind: 'user', formSchema: { type: 'object' } },
    }])).rejects.toThrow(PatchOpError);
  });

  it('setGatewayCondition writes a javascript condition that clears FF003, and isDefault sets the default flow', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'setGatewayCondition', flowId: 'flowYes', expression: 'environment.variables.atRisk === true' },
      { op: 'setGatewayCondition', flowId: 'flowNo', isDefault: true, expression: '' },
    ]);
    expect(xml).toContain('language="javascript"');
    expect(xml).toContain('default="flowNo"');
    const report = await lint(xml);
    expect(report.findings.filter((f) => f.rule === LINT_RULES.UNEVALUABLE_CONDITION)).toEqual([]);
  });

  it('replaceLabel renames a node', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'replaceLabel', nodeId: 'endStop', newLabel: 'At-risk path handled' },
    ]);
    expect(xml).toContain('At-risk path handled');
    expect(xml).not.toContain('Task ends here do not re-run');
  });

  it('setTimerDefinition rewrites a duration', async () => {
    const timer = readFileSync(new URL('./fixtures/loop.bpmn', import.meta.url), 'utf8');
    const { xml } = await applyPatchOps(timer, [
      { op: 'setTimerDefinition', nodeId: 'wait', iso8601: 'PT24H' },
    ]);
    expect(xml).toContain('PT24H');
  });

  it('declareInstanceInput adds a process-level instance input readable by readProfile', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'declareInstanceInput', name: 'submissionDeadline', type: 'string' },
    ]);
    const profile = await readProfile(xml);
    expect(profile.instanceInputs).toEqual([{ name: 'submissionDeadline', type: 'string' }]);
  });

  it('throws PatchOpError for an unknown node and leaves ops atomic (no partial result)', async () => {
    await expect(applyPatchOps(messy, [
      { op: 'replaceLabel', nodeId: 'endStop', newLabel: 'x' },
      { op: 'replaceLabel', nodeId: 'nope', newLabel: 'y' },
    ])).rejects.toThrow(PatchOpError);
  });

  it('an empty op list round-trips contracts intact (baseline for DI comparisons)', async () => {
    const { xml, diff } = await applyPatchOps(contracts, []);
    expect(diff).toEqual([]);
    const profile = await readProfile(xml);
    expect(profile.contracts.get('agentTask')?.kind).toBe('agent');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/server test patch-ops`
Expected: FAIL — `Cannot find module '../src/patch-ops/apply.js'`.

- [ ] **Step 3: Implement**

`packages/server/src/patch-ops/apply.ts`:

```ts
import { BpmnModdle } from 'bpmn-moddle';
import { flowfabricModdle, type TaskContract } from '@flowfabric/shared';

export type PatchOp =
  | { op: 'setTaskType'; nodeId: string; bpmnType: 'bpmn:UserTask' | 'bpmn:ScriptTask' | 'bpmn:ServiceTask' }
  | { op: 'setTaskContract'; nodeId: string; contract: TaskContract }
  | { op: 'setGatewayCondition'; flowId: string; expression: string; isDefault?: boolean }
  | { op: 'replaceLabel'; nodeId: string; newLabel: string }
  | { op: 'convertToTerminateEnd'; nodeId: string }
  | { op: 'addErrorBoundary'; nodeId: string; targetId: string }
  | { op: 'setTimerDefinition'; nodeId: string; iso8601: string }
  | { op: 'declareInstanceInput'; name: string; type: string };

export interface PatchDiff {
  op: string;
  target: string;
  summary: string;
}

export interface PatchResult {
  xml: string;
  diff: PatchDiff[];
}

/** Typed failure: unknown node, kind mismatch, unsupported target. The grill
 * returns the message to the agent as a rejected tool call. */
export class PatchOpError extends Error {}

const CONTRACT_HOST: Record<string, TaskContract['kind']> = {
  'bpmn:ServiceTask': 'agent',
  'bpmn:ScriptTask': 'code',
  'bpmn:UserTask': 'user',
};

const FLOWFABRIC_CONTRACT_TYPES = ['flowfabric:AgentTask', 'flowfabric:CodeTask', 'flowfabric:UserTask'];

/** Apply typed edit ops via moddle — never raw XML (design §7, risk #3).
 * All-or-nothing: any failing op rejects the whole call, nothing is serialized. */
export async function applyPatchOps(xml: string, ops: PatchOp[]): Promise<PatchResult> {
  const moddle = new BpmnModdle({ flowfabric: flowfabricModdle });
  const parsed = await moddle.fromXML(xml);
  const definitions = parsed.rootElement;
  const diff: PatchDiff[] = [];
  for (const op of ops) diff.push(applyOne(moddle, definitions, op));
  const { xml: outXml } = await moddle.toXML(definitions, { format: true });
  return { xml: outXml, diff };
}

function processes(definitions: any): any[] {
  return (definitions.rootElements ?? []).filter((r: any) => r.$type === 'bpmn:Process');
}

function findElement(definitions: any, id: string): { proc: any; el: any } {
  for (const proc of processes(definitions)) {
    const el = (proc.flowElements ?? []).find((e: any) => e.id === id);
    if (el) return { proc, el };
  }
  throw new PatchOpError(`no flow element with id "${id}"`);
}

function ensureExtensionElements(moddle: any, el: any): any {
  if (!el.extensionElements) {
    el.extensionElements = moddle.create('bpmn:ExtensionElements', { values: [] });
    el.extensionElements.$parent = el;
  }
  el.extensionElements.values ??= [];
  return el.extensionElements;
}

function bodyEl(moddle: any, type: string, text: string): any {
  return moddle.create(type, { text });
}

function buildContractElement(moddle: any, contract: TaskContract): any {
  if (contract.kind === 'agent') {
    return moddle.create('flowfabric:AgentTask', {
      retries: contract.retries,
      timeoutSeconds: contract.timeoutSeconds,
      prompt: bodyEl(moddle, 'flowfabric:Prompt', contract.prompt),
      tools: bodyEl(moddle, 'flowfabric:Tools', contract.tools.join(',')),
      ...(contract.boundaries
        ? { boundaries: bodyEl(moddle, 'flowfabric:Boundaries', contract.boundaries) }
        : {}),
      inputs: contract.inputs.map((i) => moddle.create('flowfabric:Input', { name: i.name, type: i.type })),
      outputSchema: bodyEl(moddle, 'flowfabric:OutputSchema', JSON.stringify(contract.outputSchema)),
    });
  }
  if (contract.kind === 'code') {
    return moddle.create('flowfabric:CodeTask', {
      command: contract.command,
      retries: contract.retries,
      timeoutSeconds: contract.timeoutSeconds,
      inputs: contract.inputs.map((i) => moddle.create('flowfabric:Input', { name: i.name, type: i.type })),
      outputSchema: bodyEl(moddle, 'flowfabric:OutputSchema', JSON.stringify(contract.outputSchema)),
    });
  }
  return moddle.create('flowfabric:UserTask', {
    formSchema: bodyEl(moddle, 'flowfabric:FormSchema', JSON.stringify(contract.formSchema)),
  });
}

function applyOne(moddle: any, definitions: any, op: PatchOp): PatchDiff {
  switch (op.op) {
    case 'setTaskContract': {
      const { el } = findElement(definitions, op.nodeId);
      const expected = CONTRACT_HOST[el.$type];
      if (expected !== op.contract.kind) {
        throw new PatchOpError(
          `contract kind "${op.contract.kind}" does not fit ${el.$type} ${op.nodeId} (expected "${expected ?? 'none'}"); ` +
            `run setTaskType first`,
        );
      }
      const ext = ensureExtensionElements(moddle, el);
      // replace any previous flowfabric contract, keep foreign extensions (e.g. Signavio metadata)
      ext.values = ext.values.filter((v: any) => !FLOWFABRIC_CONTRACT_TYPES.includes(v.$type));
      const contractEl = buildContractElement(moddle, op.contract);
      contractEl.$parent = ext;
      ext.values.push(contractEl);
      return { op: op.op, target: op.nodeId, summary: `${op.contract.kind} contract set on ${op.nodeId}` };
    }
    case 'setGatewayCondition': {
      const { el: flow } = findElement(definitions, op.flowId);
      if (flow.$type !== 'bpmn:SequenceFlow') throw new PatchOpError(`${op.flowId} is not a sequence flow`);
      const gateway = flow.sourceRef;
      if (gateway?.$type !== 'bpmn:ExclusiveGateway') {
        throw new PatchOpError(`${op.flowId} does not leave an exclusive gateway`);
      }
      if (op.isDefault) {
        gateway.default = flow;
        delete flow.conditionExpression;
        return { op: op.op, target: op.flowId, summary: `${op.flowId} is now the default flow of ${gateway.id}` };
      }
      if (!op.expression.trim()) throw new PatchOpError(`empty condition expression for ${op.flowId}`);
      flow.conditionExpression = moddle.create('bpmn:FormalExpression', {
        language: 'javascript',
        body: `const environment = this.environment; next(null, Boolean(${op.expression}));`,
      });
      flow.conditionExpression.$parent = flow;
      if (gateway.default === flow) delete gateway.default;
      return { op: op.op, target: op.flowId, summary: `condition on ${op.flowId}: ${op.expression}` };
    }
    case 'replaceLabel': {
      const { el } = findElement(definitions, op.nodeId);
      const old = el.name ?? '';
      el.name = op.newLabel;
      return { op: op.op, target: op.nodeId, summary: `label "${old}" -> "${op.newLabel}"` };
    }
    case 'setTimerDefinition': {
      const { el } = findElement(definitions, op.nodeId);
      const timer = (el.eventDefinitions ?? []).find((d: any) => d.$type === 'bpmn:TimerEventDefinition');
      if (el.$type !== 'bpmn:IntermediateCatchEvent' || !timer) {
        throw new PatchOpError(`${op.nodeId} is not a timer intermediate catch event`);
      }
      timer.timeDuration = moddle.create('bpmn:FormalExpression', { body: op.iso8601 });
      timer.timeDuration.$parent = timer;
      delete timer.timeCycle;
      delete timer.timeDate;
      return { op: op.op, target: op.nodeId, summary: `timer ${op.nodeId} duration = ${op.iso8601}` };
    }
    case 'declareInstanceInput': {
      const [proc] = processes(definitions);
      if (!proc) throw new PatchOpError('no process in definitions');
      const ext = ensureExtensionElements(moddle, proc);
      let ii = ext.values.find((v: any) => v.$type === 'flowfabric:InstanceInputs');
      if (!ii) {
        ii = moddle.create('flowfabric:InstanceInputs', { inputs: [] });
        ii.$parent = ext;
        ext.values.push(ii);
      }
      ii.inputs ??= [];
      if (!ii.inputs.some((i: any) => i.name === op.name)) {
        ii.inputs.push(moddle.create('flowfabric:Input', { name: op.name, type: op.type }));
      }
      return { op: op.op, target: op.name, summary: `instance input ${op.name}: ${op.type}` };
    }
    case 'setTaskType':
    case 'convertToTerminateEnd':
    case 'addErrorBoundary':
      throw new PatchOpError(`op ${op.op} not implemented yet (Task 6)`);
    default: {
      const never: never = op;
      throw new PatchOpError(`unknown op ${JSON.stringify(never)}`);
    }
  }
}
```

Add to `packages/server/src/index.ts`:

```ts
export { applyPatchOps, PatchOpError } from './patch-ops/apply.js';
export type { PatchOp, PatchDiff, PatchResult } from './patch-ops/apply.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flowfabric/server test patch-ops`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/patch-ops packages/server/src/index.ts packages/server/test/patch-ops.test.ts
git commit -m "feat(server): patch ops - contracts, conditions, labels, timers, instance inputs (M3.3)"
```

---

### Task 6: Patch ops — structural operations + DI stability (impl M3.3, risk #3)

`setTaskType` is the hard one: moddle elements are linked by object reference (flows' `sourceRef`/`targetRef`, lane `flowNodeRef`, DI `bpmnElement`), so retyping means creating a new element and re-pointing every reference. `convertToTerminateEnd` handles both real end events and dead-end tasks (rfp-daily's "Task Ends Here Do No Re-Run" nodes may be either). `addErrorBoundary` is the only op that adds elements — it also adds its own DI shape/edge so the file still opens in stock editors. Closes with the risk-#3 verification: DI byte-identical outside targeted elements, on the fixture and on the real Signavio export.

**Files:**
- Modify: `packages/server/src/patch-ops/apply.ts`
- Test: `packages/server/test/patch-ops.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5's `applyOne` switch, helpers.
- Produces: complete op set. `convertToTerminateEnd` accepts an `EndEvent` (adds terminate definition) or any flow node with no outgoing flows (retypes it to a terminate `EndEvent`); anything with outgoing flows → `PatchOpError`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/patch-ops.test.ts`:

```ts
import { existsSync } from 'node:fs';
const RFP_PATH = new URL('../../../Input/bpmn/rfp-daily-routine.bpmn', import.meta.url);

/** The <bpmndi:...> section of a serialized file. Compared across two outputs of
 * applyPatchOps so both sides share identical serializer formatting. */
function diSection(xml: string): string {
  const start = xml.indexOf('<bpmndi:');
  const end = xml.lastIndexOf('</bpmndi:BPMNDiagram>');
  if (start === -1 || end === -1) throw new Error('no DI section');
  return xml.slice(start, end);
}

describe('applyPatchOps — structural ops', () => {
  it('setTaskType retypes a generic task and re-points flows, lanes, and DI', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'setTaskType', nodeId: 'checkTracker', bpmnType: 'bpmn:ServiceTask' },
    ]);
    expect(xml).toContain('serviceTask');
    // flows still reference the node
    expect(xml).toMatch(/sourceRef="checkTracker"/);
    expect(xml).toMatch(/targetRef="checkTracker"/);
    // DI shape still references the node
    expect(xml).toContain('bpmnElement="checkTracker"');
  });

  it('setTaskType keeps existing extensionElements (contract survives retype)', async () => {
    const first = await applyPatchOps(messy, [
      { op: 'setTaskType', nodeId: 'checkTracker', bpmnType: 'bpmn:ServiceTask' },
      { op: 'setTaskContract', nodeId: 'checkTracker', contract: {
        kind: 'agent', retries: 0, timeoutSeconds: 60, prompt: 'check', tools: ['Read'],
        inputs: [], outputSchema: { type: 'object', properties: { atRisk: { type: 'boolean' } } },
      } },
    ]);
    const profile = await readProfile(first.xml);
    expect(profile.contracts.get('checkTracker')?.kind).toBe('agent');
  });

  it('convertToTerminateEnd adds a terminate definition to an end event', async () => {
    const { xml } = await applyPatchOps(messy, [{ op: 'convertToTerminateEnd', nodeId: 'endStop' }]);
    const profile = await readProfile(xml);
    expect(profile.terminateEnds).toEqual(new Set(['endStop']));
  });

  it('convertToTerminateEnd rejects a node with outgoing flows', async () => {
    await expect(applyPatchOps(messy, [{ op: 'convertToTerminateEnd', nodeId: 'checkTracker' }]))
      .rejects.toThrow(PatchOpError);
  });

  it('addErrorBoundary attaches a boundary + handler flow and registers in the profile', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'addErrorBoundary', nodeId: 'notify', targetId: 'endOk' },
    ]);
    const profile = await readProfile(xml);
    expect(profile.errorBoundaryHosts).toEqual(new Set(['notify']));
    // boundary got its own DI shape so stock editors still render the file
    expect(xml).toContain('bpmnElement="Boundary_notify"');
  });

  it('in-place ops leave the DI section byte-identical (risk #3)', async () => {
    const base = await applyPatchOps(messy, []);
    const patched = await applyPatchOps(messy, [
      { op: 'setTaskType', nodeId: 'checkTracker', bpmnType: 'bpmn:ServiceTask' },
      { op: 'setGatewayCondition', flowId: 'flowYes', expression: 'environment.variables.atRisk === true' },
      { op: 'setGatewayCondition', flowId: 'flowNo', isDefault: true, expression: '' },
      { op: 'replaceLabel', nodeId: 'endStop', newLabel: 'Handled' },
      { op: 'convertToTerminateEnd', nodeId: 'endStop' },
      { op: 'declareInstanceInput', name: 'deadline', type: 'string' },
    ]);
    expect(diSection(patched.xml)).toBe(diSection(base.xml));
  });

  it.skipIf(!existsSync(RFP_PATH))('real Signavio export: retype + label ops leave DI untouched', async () => {
    const raw = readFileSync(RFP_PATH, 'utf8');
    const base = await applyPatchOps(raw, []);
    // pick a generic task id out of the parsed model rather than hardcoding Signavio sids
    const profileless = await lint(raw);
    const genericTaskId = profileless.findings.find(
      (f) => f.rule === LINT_RULES.UNSUPPORTED_ELEMENT && f.nodeId,
    )!.nodeId!;
    const patched = await applyPatchOps(raw, [
      { op: 'setTaskType', nodeId: genericTaskId, bpmnType: 'bpmn:ServiceTask' },
      { op: 'replaceLabel', nodeId: genericTaskId, newLabel: 'Retyped by patch-ops test' },
    ]);
    expect(diSection(patched.xml)).toBe(diSection(base.xml));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/server test patch-ops`
Expected: FAIL — `op setTaskType not implemented yet (Task 6)`.

- [ ] **Step 3: Implement the structural ops**

In `packages/server/src/patch-ops/apply.ts`, add the reference-surgery helper:

```ts
/** Replace oldEl with newEl in the process and re-point every object reference:
 * sequence flows, boundary attachments, lane refs, and DI plane elements. */
function replaceElement(proc: any, definitions: any, oldEl: any, newEl: any): void {
  const idx = proc.flowElements.indexOf(oldEl);
  proc.flowElements.splice(idx, 1, newEl);
  newEl.$parent = proc;
  for (const el of proc.flowElements) {
    if (el.$type === 'bpmn:SequenceFlow') {
      if (el.sourceRef === oldEl) el.sourceRef = newEl;
      if (el.targetRef === oldEl) el.targetRef = newEl;
    } else if (el.$type === 'bpmn:BoundaryEvent' && el.attachedToRef === oldEl) {
      el.attachedToRef = newEl;
    }
  }
  for (const laneSet of proc.laneSets ?? []) {
    for (const lane of laneSet.lanes ?? []) {
      const refs = lane.flowNodeRef ?? [];
      const i = refs.indexOf(oldEl);
      if (i !== -1) refs.splice(i, 1, newEl);
    }
  }
  for (const diagram of definitions.diagrams ?? []) {
    for (const pe of diagram.plane?.planeElement ?? []) {
      if (pe.bpmnElement === oldEl) pe.bpmnElement = newEl;
    }
  }
}

function retype(moddle: any, definitions: any, nodeId: string, bpmnType: string): any {
  const { proc, el } = findElement(definitions, nodeId);
  if (el.$type === bpmnType) return el;
  const newEl = moddle.create(bpmnType, {
    id: el.id,
    ...(el.name !== undefined ? { name: el.name } : {}),
    ...(el.documentation ? { documentation: el.documentation } : {}),
    ...(el.extensionElements ? { extensionElements: el.extensionElements } : {}),
    ...(el.incoming ? { incoming: el.incoming } : {}),
    ...(el.outgoing ? { outgoing: el.outgoing } : {}),
  });
  if (newEl.extensionElements) newEl.extensionElements.$parent = newEl;
  replaceElement(proc, definitions, el, newEl);
  return newEl;
}
```

Replace the three placeholder cases in `applyOne`:

```ts
    case 'setTaskType': {
      const { el } = findElement(definitions, op.nodeId);
      const from = el.$type;
      retype(moddle, definitions, op.nodeId, op.bpmnType);
      return { op: op.op, target: op.nodeId, summary: `${op.nodeId}: ${from} -> ${op.bpmnType}` };
    }
    case 'convertToTerminateEnd': {
      const { proc, el } = findElement(definitions, op.nodeId);
      const outgoing = (proc.flowElements ?? []).filter(
        (e: any) => e.$type === 'bpmn:SequenceFlow' && e.sourceRef?.id === op.nodeId,
      );
      if (outgoing.length > 0) {
        throw new PatchOpError(`${op.nodeId} has outgoing flows and cannot become a terminate end`);
      }
      const end = el.$type === 'bpmn:EndEvent' ? el : retype(moddle, definitions, op.nodeId, 'bpmn:EndEvent');
      const terminate = moddle.create('bpmn:TerminateEventDefinition', {});
      terminate.$parent = end;
      end.eventDefinitions = [terminate];
      return { op: op.op, target: op.nodeId, summary: `${op.nodeId} is now a terminate end event` };
    }
    case 'addErrorBoundary': {
      const { proc, el: host } = findElement(definitions, op.nodeId);
      const { el: target } = findElement(definitions, op.targetId);
      if (!CONTRACT_HOST[host.$type]) throw new PatchOpError(`${op.nodeId} is not a task`);
      const boundaryId = `Boundary_${op.nodeId}`;
      if ((proc.flowElements ?? []).some((e: any) => e.id === boundaryId)) {
        throw new PatchOpError(`${op.nodeId} already has an error boundary`);
      }
      const errorDef = moddle.create('bpmn:ErrorEventDefinition', {});
      const boundary = moddle.create('bpmn:BoundaryEvent', {
        id: boundaryId,
        attachedToRef: host,
        cancelActivity: true,
        eventDefinitions: [errorDef],
      });
      errorDef.$parent = boundary;
      const flow = moddle.create('bpmn:SequenceFlow', {
        id: `Flow_${boundaryId}`,
        sourceRef: boundary,
        targetRef: target,
      });
      boundary.outgoing = [flow];
      (target.incoming ??= []).push(flow);
      boundary.$parent = proc;
      flow.$parent = proc;
      proc.flowElements.push(boundary, flow);
      addBoundaryDi(moddle, definitions, host, target, boundary, flow);
      return { op: op.op, target: op.nodeId, summary: `error boundary on ${op.nodeId} -> ${op.targetId}` };
    }
```

And the DI generator:

```ts
/** Give the new boundary + flow their own DI so the file still renders in
 * stock editors. Positions are approximate (bottom-right of the host shape);
 * a human can nudge them later — layout of existing elements is never touched. */
function addBoundaryDi(moddle: any, definitions: any, host: any, target: any, boundary: any, flow: any): void {
  for (const diagram of definitions.diagrams ?? []) {
    const plane = diagram.plane;
    if (!plane) continue;
    const shapes = plane.planeElement ?? [];
    const hostShape = shapes.find((pe: any) => pe.bpmnElement === host && pe.$type === 'bpmndi:BPMNShape');
    const targetShape = shapes.find((pe: any) => pe.bpmnElement === target && pe.$type === 'bpmndi:BPMNShape');
    if (!hostShape?.bounds) return; // no DI in this file — nothing to extend
    const b = hostShape.bounds;
    const boundaryBounds = moddle.create('dc:Bounds', {
      x: b.x + b.width - 18, y: b.y + b.height - 18, width: 36, height: 36,
    });
    const boundaryShape = moddle.create('bpmndi:BPMNShape', {
      id: `${boundary.id}_di`, bpmnElement: boundary, bounds: boundaryBounds,
    });
    const from = moddle.create('dc:Point', { x: b.x + b.width, y: b.y + b.height });
    const to = targetShape?.bounds
      ? moddle.create('dc:Point', {
          x: targetShape.bounds.x + targetShape.bounds.width / 2,
          y: targetShape.bounds.y + targetShape.bounds.height / 2,
        })
      : moddle.create('dc:Point', { x: b.x + b.width + 100, y: b.y + b.height + 60 });
    const edge = moddle.create('bpmndi:BPMNEdge', {
      id: `${flow.id}_di`, bpmnElement: flow, waypoint: [from, to],
    });
    boundaryShape.$parent = plane;
    edge.$parent = plane;
    plane.planeElement = [...shapes, boundaryShape, edge];
    return;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flowfabric/server test patch-ops`
Expected: PASS, including the real-file DI test. If moddle's `dc:`/`bpmndi:` prefixes differ in the Signavio file (it uses `omgdc:`/`omgdi:`), the `diSection` comparison still holds — both sides come from the same serializer. If `moddle.create('dc:Bounds', ...)` fails on prefix resolution, use the descriptor names moddle reports in the parsed shapes (`hostShape.bounds.$type`) and create with that exact type string.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/patch-ops packages/server/test/patch-ops.test.ts
git commit -m "feat(server): structural patch ops with reference surgery and DI stability (M3.3)"
```

---

### Task 7: Grill session host (impl M3.4)

`GrillSession` hosts a Claude Agent SDK chat over one definition: the diagram XML + lint report go into the first prompt, `propose_patch_ops` is the only mutating tool (an in-process SDK MCP server), every accepted op batch re-lints and feeds findings back as the tool result (design §7). The SDK transport is the same `AgentQueryFn` seam `AgentRunner` uses, so tests script the session without live calls: the deterministic core (`applyOps` → re-lint → events) is driven directly, exactly as the SDK tool handler drives it.

**Files:**
- Create: `packages/server/src/grill/session.ts`
- Modify: `packages/server/package.json` (add `zod: ^4` — the SDK's `tool()` takes zod schemas)
- Modify: `packages/server/src/index.ts` (exports)
- Test: `packages/server/test/grill.test.ts`

**Interfaces:**
- Consumes: `applyPatchOps`/`PatchOp`/`PatchOpError` (Tasks 5–6), `lint` (Task 4), `DefinitionStore` (Task 2), `AgentQueryFn` (existing).
- Produces (used by Task 8):

```ts
type GrillEvent =
  | { type: 'chat'; message: Record<string, unknown> }
  | { type: 'op-applied'; diff: PatchDiff[] }
  | { type: 'lint-updated'; report: LintReport }
  | { type: 'op-rejected'; error: string }
  | { type: 'turn-done' }
  | { type: 'error'; error: string };
class GrillSession {
  readonly id: string;
  readonly definitionId: string;
  get xml(): string;                 // working copy, mutated only by applyOps
  get lintReport(): LintReport;
  onEvent(listener: (e: GrillEvent) => void): () => void;
  applyOps(ops: PatchOp[]): Promise<{ diff: PatchDiff[]; report: LintReport }>;
  send(text: string): Promise<void>; // one SDK turn; resumes prior session
  saveVersion(): { versionNo: number; deployable: boolean };
}
class GrillHost {
  constructor(deps: { definitions: DefinitionStore; queryFn?: AgentQueryFn });
  start(definitionId: string): Promise<GrillSession>; // latest version; throws if none
  get(id: string): GrillSession | undefined;
}
```

- [ ] **Step 1: Add the zod dependency**

In `packages/server/package.json` dependencies, add `"zod": "^4"`, then run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

`packages/server/test/grill.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DefinitionStore } from '../src/definitions/store.js';
import { GrillHost, type GrillEvent } from '../src/grill/session.js';
import type { AgentQueryFn } from '../src/runners/agent.js';
import type { PatchOp } from '../src/patch-ops/apply.js';

const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

/** Mock SDK transport: records calls, replays a scripted assistant turn. */
function mockQuery() {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const queryFn: AgentQueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Which actor runs "Check the tracker"?' }] } };
      yield { type: 'result', subtype: 'success', result: 'asked', session_id: `s-${calls.length}` };
    })();
  };
  return { calls, queryFn };
}

describe('GrillSession', () => {
  const stores: DefinitionStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  async function openSession(queryFn?: AgentQueryFn) {
    const definitions = new DefinitionStore(path.join(tmp(), 'ff.db'));
    stores.push(definitions);
    const { id } = definitions.upload('messy', messy);
    const host = new GrillHost({ definitions, ...(queryFn ? { queryFn } : {}) });
    return { definitions, defId: id, session: await host.start(id), host };
  }

  // The exact op sequence a live grill would propose for messy.bpmn. Reused by the
  // scripted-session verify (impl M3.4): messy -> deployable without manual XML edits.
  const REFINEMENT_OPS: PatchOp[][] = [
    [{ op: 'setTaskType', nodeId: 'checkTracker', bpmnType: 'bpmn:ServiceTask' },
     { op: 'setTaskContract', nodeId: 'checkTracker', contract: {
       kind: 'agent', retries: 1, timeoutSeconds: 120, prompt: 'Check the tracker for at-risk tasks.',
       tools: ['Read', 'Grep'], inputs: [{ name: 'deadline', type: 'string' }],
       outputSchema: { type: 'object', required: ['atRisk'], properties: { atRisk: { type: 'boolean' } } },
     } }],
    [{ op: 'setTaskType', nodeId: 'notify', bpmnType: 'bpmn:ScriptTask' },
     { op: 'setTaskContract', nodeId: 'notify', contract: {
       kind: 'code', retries: 0, timeoutSeconds: 30, command: 'node notify.js',
       inputs: [], outputSchema: { type: 'object', required: ['notified'], properties: { notified: { type: 'boolean' } } },
     } }],
    [{ op: 'setGatewayCondition', flowId: 'flowYes', expression: 'environment.variables.atRisk === true' },
     { op: 'setGatewayCondition', flowId: 'flowNo', isDefault: true, expression: '' }],
    [{ op: 'replaceLabel', nodeId: 'endStop', newLabel: 'At-risk path handled' },
     { op: 'convertToTerminateEnd', nodeId: 'endStop' }],
    [{ op: 'declareInstanceInput', name: 'deadline', type: 'string' }],
  ];

  it('starts with the uploaded xml and a failing lint report', async () => {
    const { session } = await openSession();
    expect(session.xml).toBe(messy);
    expect(session.lintReport.deployable).toBe(false);
  });

  it('scripted refinement drives messy.bpmn to deployable, emitting op + lint events (impl M3.4 verify)', async () => {
    const { session } = await openSession();
    const events: GrillEvent[] = [];
    session.onEvent((e) => events.push(e));

    let errorsBefore = session.lintReport.errorCount;
    for (const batch of REFINEMENT_OPS) {
      const { report } = await session.applyOps(batch);
      expect(report.errorCount).toBeLessThanOrEqual(errorsBefore);
      errorsBefore = report.errorCount;
    }
    expect(session.lintReport.deployable).toBe(true);
    expect(events.filter((e) => e.type === 'op-applied')).toHaveLength(REFINEMENT_OPS.length);
    expect(events.filter((e) => e.type === 'lint-updated')).toHaveLength(REFINEMENT_OPS.length);
  });

  it('rejected ops leave the working copy and report untouched', async () => {
    const { session } = await openSession();
    const before = session.xml;
    await expect(session.applyOps([{ op: 'replaceLabel', nodeId: 'ghost', newLabel: 'x' }]))
      .rejects.toThrow();
    expect(session.xml).toBe(before);
  });

  it('send() passes the diagram + lint briefing on turn 1, resumes the SDK session on turn 2', async () => {
    const { calls, queryFn } = mockQuery();
    const { session } = await openSession(queryFn);
    const events: GrillEvent[] = [];
    session.onEvent((e) => events.push(e));

    await session.send('Let us start');
    expect(calls[0].prompt).toContain('propose_patch_ops');
    expect(calls[0].prompt).toContain('<process');           // diagram is in the briefing
    expect(calls[0].prompt).toContain('FF001');              // lint findings are in the briefing
    expect(calls[0].options.resume).toBeUndefined();
    expect((calls[0].options.allowedTools as string[])).toContain('mcp__flowfabric__propose_patch_ops');

    await session.send('Continue');
    expect(calls[1].options.resume).toBe('s-1');
    expect(events.filter((e) => e.type === 'chat').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.type === 'turn-done')).toHaveLength(2);
  });

  it('saveVersion persists the working copy with its lint report (FR-4)', async () => {
    const { session, definitions, defId } = await openSession();
    for (const batch of REFINEMENT_OPS) await session.applyOps(batch);
    const { versionNo, deployable } = session.saveVersion();
    expect(versionNo).toBe(2);
    expect(deployable).toBe(true);
    const v2 = definitions.getVersion(defId, 2)!;
    expect(v2.deployable).toBe(true);
    expect(v2.xml).toBe(session.xml);
    expect(definitions.getVersion(defId, 1)!.xml).toBe(messy); // v1 immutable
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/server test grill`
Expected: FAIL — `Cannot find module '../src/grill/session.js'`.

- [ ] **Step 4: Implement**

`packages/server/src/grill/session.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { LintReport } from '@flowfabric/shared';
import type { AgentQueryFn } from '../runners/agent.js';
import { lint } from '../linter/lint.js';
import { applyPatchOps, type PatchDiff, type PatchOp } from '../patch-ops/apply.js';
import type { DefinitionStore } from '../definitions/store.js';

export type GrillEvent =
  | { type: 'chat'; message: Record<string, unknown> }
  | { type: 'op-applied'; diff: PatchDiff[] }
  | { type: 'lint-updated'; report: LintReport }
  | { type: 'op-rejected'; error: string }
  | { type: 'turn-done' }
  | { type: 'error'; error: string };

export interface GrillDeps {
  definitions: DefinitionStore;
  queryFn?: AgentQueryFn;
}

const OP_CATALOG = `Available patch ops (the ONLY way to change the diagram — never output XML):
- {"op":"setTaskType","nodeId":"...","bpmnType":"bpmn:ServiceTask"|"bpmn:ScriptTask"|"bpmn:UserTask"}
  serviceTask = agent (Claude), scriptTask = deterministic code, userTask = human.
- {"op":"setTaskContract","nodeId":"...","contract":{...}} where contract is one of
  {"kind":"agent","retries":n,"timeoutSeconds":n,"prompt":"...","tools":["Read",...],"boundaries":"...","inputs":[{"name":"...","type":"..."}],"outputSchema":{JSON Schema}}
  {"kind":"code","retries":n,"timeoutSeconds":n,"command":"...","inputs":[...],"outputSchema":{...}}
  {"kind":"user","formSchema":{JSON Schema}}
- {"op":"setGatewayCondition","flowId":"...","expression":"environment.variables.<name> === ...","isDefault":false}
  expression is a JavaScript boolean over process variables; pass isDefault:true (empty expression) for the fallback flow.
- {"op":"replaceLabel","nodeId":"...","newLabel":"..."}
- {"op":"convertToTerminateEnd","nodeId":"..."} (end events or dead-end tasks)
- {"op":"addErrorBoundary","nodeId":"<task>","targetId":"<handler node>"}
- {"op":"setTimerDefinition","nodeId":"<timer event>","iso8601":"PT24H"}
- {"op":"declareInstanceInput","name":"...","type":"..."}
There is no removeNode op: if the lint report shows an orphan node (FF005), tell the user to
delete it in their BPMN editor and re-upload — do not try to patch around it.`;

function briefing(xml: string, report: LintReport): string {
  return [
    'You are the Flow Fabric refinement ("grilling") agent. A BPMN diagram was uploaded that is not yet',
    'executable. Walk the diagram node by node and interrogate the user to: assign each task an actor,',
    'write task contracts, convert prose gateway labels into evaluable conditions, and replace',
    'instruction-bearing labels with proper BPMN semantics (terminate ends, loop conditions).',
    'Ask focused questions, one node (or small group) at a time. Apply agreed changes by calling the',
    'propose_patch_ops tool; its result carries the applied diff and the fresh lint report - drive the',
    'error count to zero. Never print or edit XML yourself.',
    '',
    OP_CATALOG,
    '',
    `Current lint report:\n${JSON.stringify(report, null, 2)}`,
    '',
    `The diagram:\n${xml}`,
  ].join('\n');
}

export class GrillSession {
  readonly id = randomUUID();
  private emitter = new EventEmitter();
  private sdkSessionId: string | undefined;
  private currentXml: string;
  private report: LintReport;
  private queryFn: AgentQueryFn;

  private constructor(
    readonly definitionId: string,
    xml: string,
    report: LintReport,
    private definitions: DefinitionStore,
    queryFn: AgentQueryFn | undefined,
  ) {
    this.currentXml = xml;
    this.report = report;
    this.queryFn = queryFn ?? (query as unknown as AgentQueryFn);
  }

  static async open(definitionId: string, xml: string, deps: GrillDeps): Promise<GrillSession> {
    return new GrillSession(definitionId, xml, await lint(xml), deps.definitions, deps.queryFn);
  }

  get xml(): string {
    return this.currentXml;
  }

  get lintReport(): LintReport {
    return this.report;
  }

  onEvent(listener: (e: GrillEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  private emit(event: GrillEvent): void {
    this.emitter.emit('event', event);
  }

  /** Deterministic core: apply ops, re-lint, emit. Called by the SDK tool handler
   * and directly by tests/CLI. Atomic - a failing op changes nothing. */
  async applyOps(ops: PatchOp[]): Promise<{ diff: PatchDiff[]; report: LintReport }> {
    try {
      const { xml, diff } = await applyPatchOps(this.currentXml, ops);
      this.currentXml = xml;
      this.report = await lint(xml);
      this.emit({ type: 'op-applied', diff });
      this.emit({ type: 'lint-updated', report: this.report });
      return { diff, report: this.report };
    } catch (err) {
      this.emit({ type: 'op-rejected', error: String(err) });
      throw err;
    }
  }

  /** One chat turn. First turn carries the briefing (diagram + lint + op catalog);
   * later turns resume the SDK session (design §7). */
  async send(text: string): Promise<void> {
    const server = createSdkMcpServer({
      name: 'flowfabric',
      version: '1.0.0',
      tools: [
        tool(
          'propose_patch_ops',
          'Apply typed BPMN patch operations to the working diagram. Returns the applied diff and the new lint report.',
          { ops: z.array(z.record(z.string(), z.unknown())) },
          async ({ ops }) => {
            try {
              const { diff, report } = await this.applyOps(ops as unknown as PatchOp[]);
              return { content: [{ type: 'text', text: JSON.stringify({ applied: diff, lint: report }) }] };
            } catch (err) {
              return { content: [{ type: 'text', text: `PATCH REJECTED: ${String(err)}` }], isError: true };
            }
          },
        ),
      ],
    });
    const options: Record<string, unknown> = {
      mcpServers: { flowfabric: server },
      allowedTools: ['mcp__flowfabric__propose_patch_ops'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      maxTurns: 30,
      ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
    };
    const prompt = this.sdkSessionId ? text : `${briefing(this.currentXml, this.report)}\n\nUser: ${text}`;
    try {
      for await (const message of this.queryFn({ prompt, options })) {
        this.emit({ type: 'chat', message });
        if (message.type === 'result' && typeof message.session_id === 'string') {
          this.sdkSessionId = message.session_id;
        }
      }
      this.emit({ type: 'turn-done' });
    } catch (err) {
      this.emit({ type: 'error', error: String(err) });
      throw err;
    }
  }

  /** Persist the working copy as the next immutable version (FR-4). */
  saveVersion(): { versionNo: number; deployable: boolean } {
    const versionNo = this.definitions.saveVersion(this.definitionId, this.currentXml, this.report);
    return { versionNo, deployable: this.report.deployable };
  }
}

export class GrillHost {
  private sessions = new Map<string, GrillSession>();

  constructor(private deps: GrillDeps) {}

  async start(definitionId: string): Promise<GrillSession> {
    const version = this.deps.definitions.getLatestVersion(definitionId);
    if (!version) throw new Error(`no versions for definition ${definitionId}`);
    const session = await GrillSession.open(definitionId, version.xml, this.deps);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): GrillSession | undefined {
    return this.sessions.get(id);
  }
}
```

Add to `packages/server/src/index.ts`:

```ts
export { GrillSession, GrillHost } from './grill/session.js';
export type { GrillEvent, GrillDeps } from './grill/session.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @flowfabric/server test grill`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/grill packages/server/src/index.ts packages/server/package.json pnpm-lock.yaml packages/server/test/grill.test.ts
git commit -m "feat(server): grill session host with propose_patch_ops tool and re-lint loop (M3.4)"
```

---

### Task 8: Grill API + instances-by-version + daemon entrypoint (impl M3.4, M2 deferral)

Expose the grill over REST + SSE (design §8), let `POST /api/instances` start from a stored definition version (deployable versions only — the linter is the deployment gate, FR-3), and add the daemon that M2 deferred to M3: one process wiring store + host + inbox + notifier + definitions + grill + API + `resumeAll()`.

**Files:**
- Modify: `packages/server/src/api/server.ts` (grill routes, instances-by-version)
- Create: `packages/server/src/daemon.ts`
- Modify: `packages/server/package.json` (`dev` script)
- Test: `packages/server/test/grill-api.test.ts`

**Interfaces:**
- Consumes: `GrillHost`/`GrillSession` (Task 7), `DefinitionStore` (Task 2).
- Produces:
  - `ApiDeps` gains `grill?: GrillHost`.
  - `POST /api/grill/sessions` `{definitionId}` → 201 `{sessionId, lint}`; 404 unknown definition.
  - `POST /api/grill/sessions/:id/messages` `{text}` → 202 (turn runs async; watch SSE).
  - `POST /api/grill/sessions/:id/save-version` → 200 `{versionNo, deployable}`.
  - `GET /api/grill/sessions/:id/events` → SSE of `GrillEvent`s.
  - `POST /api/instances` body gains `definitionId?: string; version?: number` (alternative to `source`); resolves the version xml as engine source, instance name = definition name. 404 unknown version; 400 not deployable.
  - `pnpm --filter @flowfabric/server dev` boots the daemon on `FF_PORT` (default 4400), data dir `FF_DATA_DIR` (default `~/.flow-fabric`).

- [ ] **Step 1: Write the failing tests**

`packages/server/test/grill-api.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { DefinitionStore } from '../src/definitions/store.js';
import { GrillHost } from '../src/grill/session.js';
import { buildApi } from '../src/api/server.js';
import type { AgentQueryFn } from '../src/runners/agent.js';

const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
const refined = readFileSync(new URL('./fixtures/daily-loop-refined.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

const echoQuery: AgentQueryFn = ({ options }) =>
  (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
    yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's-1', options };
  })();

function build() {
  const dir = tmp();
  const store = new InstanceStore(path.join(dir, 'ff.db'));
  const definitions = new DefinitionStore(path.join(dir, 'ff.db'));
  let inbox!: Inbox;
  const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
  inbox = new Inbox(store, host, { notify: async () => {} });
  const grill = new GrillHost({ definitions, queryFn: echoQuery });
  const app = buildApi({ store, host, inbox, definitions, grill });
  return { store, definitions, app };
}

describe('grill API', () => {
  const closers: Array<{ close(): void }> = [];
  afterEach(() => closers.forEach((s) => s.close()));

  it('creates a session, accepts messages, saves a version', async () => {
    const { store, definitions, app } = build();
    closers.push(store, definitions);
    const { id } = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'messy', xml: messy },
    })).json();

    const created = await app.inject({
      method: 'POST', url: '/api/grill/sessions', payload: { definitionId: id },
    });
    expect(created.statusCode).toBe(201);
    const { sessionId, lint } = created.json();
    expect(lint.deployable).toBe(false);

    const msg = await app.inject({
      method: 'POST', url: `/api/grill/sessions/${sessionId}/messages`, payload: { text: 'start' },
    });
    expect(msg.statusCode).toBe(202);

    const saved = await app.inject({
      method: 'POST', url: `/api/grill/sessions/${sessionId}/save-version`,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().versionNo).toBe(2);
    expect(definitions.getVersion(id, 2)).toBeDefined();
  });

  it('404s on unknown definition or session', async () => {
    const { store, definitions, app } = build();
    closers.push(store, definitions);
    const bad = await app.inject({
      method: 'POST', url: '/api/grill/sessions', payload: { definitionId: 'ghost' },
    });
    expect(bad.statusCode).toBe(404);
    const badMsg = await app.inject({
      method: 'POST', url: '/api/grill/sessions/ghost/messages', payload: { text: 'x' },
    });
    expect(badMsg.statusCode).toBe(404);
  });
});

describe('instances from stored versions', () => {
  const closers: Array<{ close(): void }> = [];
  afterEach(() => closers.forEach((s) => s.close()));

  it('starts a dry run from a deployable version and 400s on a non-deployable one', async () => {
    const { store, definitions, app } = build();
    closers.push(store, definitions);

    // deployable definition
    const dep = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'daily', xml: refined },
    })).json();
    await app.inject({ method: 'POST', url: `/api/definitions/${dep.id}/versions/1/lint` });
    const started = await app.inject({
      method: 'POST', url: '/api/instances',
      payload: { definitionId: dep.id, workspacePath: tmp(), dryRun: true,
                 inputs: { submissionDeadline: '2026-08-01' } },
    });
    expect(started.statusCode).toBe(201);
    expect(store.listInstances().at(-1)?.name).toBe('daily');

    // non-deployable definition
    const raw = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'messy', xml: messy },
    })).json();
    await app.inject({ method: 'POST', url: `/api/definitions/${raw.id}/versions/1/lint` });
    const refused = await app.inject({
      method: 'POST', url: '/api/instances',
      payload: { definitionId: raw.id, workspacePath: tmp(), dryRun: true },
    });
    expect(refused.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/server test grill-api`
Expected: FAIL — grill routes missing (404s where 201/202 expected), version-start unsupported.

- [ ] **Step 3: Implement the routes**

In `packages/server/src/api/server.ts`:

- add `import type { GrillHost } from '../grill/session.js';` and extend `ApiDeps` with `grill?: GrillHost;` (destructure it in `buildApi`).
- in `POST /api/instances`, before `const id = randomUUID();`, resolve `source`/`name` from a stored version when `definitionId` is present:

```ts
    const body = req.body as {
      name?: string;
      source?: string;
      definitionId?: string;
      version?: number;
      workspacePath: string;
      dryRun?: boolean;
      inputs?: Record<string, unknown>;
      stubOverrides?: Record<string, Record<string, unknown>>;
    };
    let name = body.name ?? 'instance';
    let source = body.source;
    if (body.definitionId) {
      if (!definitions) return reply.code(400).send({ error: 'no definition store configured' });
      const version = body.version !== undefined
        ? definitions.getVersion(body.definitionId, body.version)
        : definitions.getLatestVersion(body.definitionId);
      if (!version) return reply.code(404).send({ error: 'definition version not found' });
      if (!version.deployable) {
        return reply.code(400).send({ error: `version ${version.versionNo} is not deployable; lint it clean first (FR-3)` });
      }
      source = version.xml;
      name = definitions.getDefinition(body.definitionId)?.name ?? name;
    }
    if (!source) return reply.code(400).send({ error: 'source or definitionId required' });
```

(and use `name`/`source` in the `host.start({...})` call in place of `body.name`/`body.source`).

- after the definitions block, add the grill routes:

```ts
  if (grill) {
    app.post('/api/grill/sessions', async (req, reply) => {
      const { definitionId } = req.body as { definitionId: string };
      try {
        const session = await grill.start(definitionId);
        return reply.code(201).send({ sessionId: session.id, lint: session.lintReport });
      } catch (err) {
        return reply.code(404).send({ error: String(err) });
      }
    });

    app.post('/api/grill/sessions/:id/messages', async (req, reply) => {
      const session = grill.get((req.params as { id: string }).id);
      if (!session) return reply.code(404).send({ error: 'no such session' });
      const { text } = req.body as { text: string };
      // The turn streams over SSE; the POST only acknowledges receipt.
      session.send(text).catch((err) => app.log.error({ err }, 'grill turn failed'));
      return reply.code(202).send({ accepted: true });
    });

    app.post('/api/grill/sessions/:id/save-version', async (req, reply) => {
      const session = grill.get((req.params as { id: string }).id);
      if (!session) return reply.code(404).send({ error: 'no such session' });
      return session.saveVersion();
    });

    app.get('/api/grill/sessions/:id/events', async (req, reply) => {
      const session = grill.get((req.params as { id: string }).id);
      if (!session) return reply.code(404).send({ error: 'no such session' });
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      reply.raw.write(': connected\n\n');
      const unsubscribe = session.onEvent((event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      req.raw.on('close', () => {
        unsubscribe();
        reply.raw.end();
      });
      return reply;
    });
  }
```

- [ ] **Step 4: Implement the daemon**

`packages/server/src/daemon.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstanceStore } from './engine-host/store.js';
import { EngineHost } from './engine-host/engine-host.js';
import { Inbox } from './inbox/inbox.js';
import { MacNotifier } from './notify/notifier.js';
import { AgentRunner } from './runners/agent.js';
import { CodeRunner } from './runners/code.js';
import { DefinitionStore } from './definitions/store.js';
import { GrillHost } from './grill/session.js';
import { buildApi } from './api/server.js';

const dataDir = process.env.FF_DATA_DIR ?? path.join(os.homedir(), '.flow-fabric');
const port = Number(process.env.FF_PORT ?? 4400);
fs.mkdirSync(path.join(dataDir, 'transcripts'), { recursive: true });

const dbPath = path.join(dataDir, 'flow-fabric.db');
const store = new InstanceStore(dbPath);
const definitions = new DefinitionStore(dbPath);
const notifier = new MacNotifier();
let inbox!: Inbox;
const host = new EngineHost(store, {
  runners: { agent: new AgentRunner(), code: new CodeRunner() },
  dataDir,
  notifier,
  onUserTaskWait: (info) => inbox.handleWait(info),
});
inbox = new Inbox(store, host, notifier);
const grill = new GrillHost({ definitions });
const app = buildApi({ store, host, inbox, definitions, grill });

const resumed = await host.resumeAll();
for (const { id, completion } of resumed) {
  completion.catch((err) => console.error(`[flow-fabric] resumed instance ${id} failed:`, err));
}
await app.listen({ port, host: '127.0.0.1' });
console.log(`[flow-fabric] daemon on http://127.0.0.1:${port} — data dir ${dataDir}, resumed ${resumed.length} instance(s)`);
```

In `packages/server/package.json` scripts:

```json
    "dev": "node --env-file-if-exists=../../.env --env-file-if-exists=.env --import tsx src/daemon.ts"
```

- [ ] **Step 5: Run tests + boot check**

Run: `pnpm --filter @flowfabric/server test grill-api && pnpm --filter @flowfabric/server test api`
Expected: PASS (old api tests unaffected).

Run: `FF_DATA_DIR=$(mktemp -d) pnpm --filter @flowfabric/server dev` in one terminal, then `curl -s http://127.0.0.1:4400/api/healthz`
Expected: `{"ok":true}`. Ctrl-C the daemon.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/api/server.ts packages/server/src/daemon.ts packages/server/package.json packages/server/test/grill-api.test.ts
git commit -m "feat(server): grill REST+SSE routes, start-by-version with deploy gate, daemon entrypoint"
```

---

### Task 9: Terminate-end status + automated dry-run E2E (impl M3.6 mechanics, M2 deferral)

M2 deferred terminate-end handling ("M3's refined rfp-daily does — add it there"). The refined shape ends its init branch in a terminate end event, so `EngineHost` must distinguish `terminated` from `completed` (design §5 instance statuses). Then the automated E2E: the refined fixture runs a full daily cycle as a dry run started from a stored version over HTTP — stub agents/code, real user tasks, timer loop reaching the second iteration.

**Files:**
- Modify: `packages/server/src/engine-host/store.ts` (`InstanceStatus` + `'terminated'`)
- Modify: `packages/server/src/engine-host/engine-host.ts` (terminate detection)
- Test: `packages/server/test/dry-run-e2e.test.ts`

**Interfaces:**
- Consumes: `ProcessProfile.terminateEnds` (Task 1), fixture node ids from Task 4 (`checkInit, gwInit, provideDeadline, updateTracker, endInit, auditTracker, reviewCycle, gwLoop, wait24h, endDone`), instances-by-version route (Task 8).
- Produces: `InstanceStatus` includes `'terminated'` (terminal — NOT added to `listNonTerminal()`); an instance whose token dies in a terminate end event finishes with status `'terminated'`, others stay `'completed'`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/dry-run-e2e.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { DefinitionStore } from '../src/definitions/store.js';
import { buildApi } from '../src/api/server.js';

const refined = readFileSync(new URL('./fixtures/daily-loop-refined.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

async function until<T>(fn: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('condition not reached');
}

function build() {
  const dir = tmp();
  const store = new InstanceStore(path.join(dir, 'ff.db'));
  const definitions = new DefinitionStore(path.join(dir, 'ff.db'));
  let inbox!: Inbox;
  const host = new EngineHost(store, { dataDir: dir, onUserTaskWait: (i) => inbox.handleWait(i) });
  inbox = new Inbox(store, host, { notify: async () => {} });
  const app = buildApi({ store, host, inbox, definitions });
  return { store, definitions, inbox, app };
}

async function startFromVersion(app: any, payload: Record<string, unknown>): Promise<string> {
  const uploaded = (await app.inject({
    method: 'POST', url: '/api/definitions', payload: { name: 'daily', xml: refined },
  })).json();
  await app.inject({ method: 'POST', url: `/api/definitions/${uploaded.id}/versions/1/lint` });
  const started = await app.inject({
    method: 'POST', url: '/api/instances',
    payload: { definitionId: uploaded.id, ...payload },
  });
  expect(started.statusCode).toBe(201);
  return started.json().id;
}

describe('dry-run E2E of the refined daily loop (impl M3.6 mechanics)', () => {
  const stores: Array<{ close(): void }> = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('init branch: stub sends token to user task, then terminate end -> status terminated', async () => {
    const { store, inbox, app } = build();
    stores.push(store);
    // stub default for containsInitializer is false -> init branch
    const id = await startFromVersion(app, {
      workspacePath: tmp(), dryRun: true, inputs: { submissionDeadline: '2026-08-01' },
    });

    const task = await until(() => inbox.listPending().find((t) => t.nodeId === 'provideDeadline'));
    await inbox.submit(task.id, { submissionDeadline: '2026-08-15' });

    await until(() => store.getInstance(id)?.status === 'terminated');
    const timeline = store.listTaskExecutions(id);
    expect(timeline.map((t) => t.nodeId)).toEqual(
      expect.arrayContaining(['checkInit', 'provideDeadline', 'updateTracker']),
    );
  });

  it('audit loop: override steers past init, user task steers the loop, 2nd iteration reached (dry-run cycle)', async () => {
    const { store, inbox, app } = build();
    stores.push(store);
    const id = await startFromVersion(app, {
      workspacePath: tmp(), dryRun: true,
      inputs: { submissionDeadline: '2026-08-01' },
      stubOverrides: { checkInit: { containsInitializer: true } },
    });

    // iteration 1: audit runs, review continues the loop
    const review1 = await until(() => inbox.listPending().find((t) => t.nodeId === 'reviewCycle'));
    await inbox.submit(review1.id, { continueLoop: true });

    // timer (PT2S) fires, iteration 2: audit runs again, review exits the loop
    const review2 = await until(() =>
      inbox.listPending().find((t) => t.nodeId === 'reviewCycle' && t.id !== review1.id),
    );
    await inbox.submit(review2.id, { continueLoop: false });

    await until(() => store.getInstance(id)?.status === 'completed');
    const audits = store.listTaskExecutions(id).filter((t) => t.nodeId === 'auditTracker');
    expect(audits).toHaveLength(2); // timer loop reached the second iteration
    const timerEvents = store.listEvents(id).filter(
      (e) => e.type === 'activity.timer' && e.elementId === 'wait24h',
    );
    expect(timerEvents.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/server test dry-run-e2e`
Expected: the init-branch test FAILS — status ends up `'completed'`, never `'terminated'`.

- [ ] **Step 3: Implement terminate detection**

In `packages/server/src/engine-host/store.ts`, extend the union:

```ts
export type InstanceStatus =
  | 'running'
  | 'completed'
  | 'terminated'
  | 'stopped'
  | 'error'
  | 'incident'
  | 'aborted';
```

(`listNonTerminal()` stays `('running','stopped','incident')` — terminated is terminal, and the `one_active_per_workspace` index already excludes it.)

In `packages/server/src/engine-host/engine-host.ts`:

- add a field: `private terminated = new Set<string>();`
- in `run()`'s snapshot listener, after `this.store.appendEvent(id, event, api.id);` add:

```ts
        if (this.profiles.get(id)?.terminateEnds.has(api.id)) this.terminated.add(id);
```

- in the `result === 'end'` branch:

```ts
      if (result === 'end') {
        this.store.setStatus(id, this.terminated.delete(id) ? 'terminated' : 'completed');
      }
```

Note: the M1 spike showed end events emit `activity.start`/`activity.end` like any node. If the terminate end kills the process before `activity.end` fires, the `activity.start` listener entry (already in `SNAPSHOT_EVENTS`) still catches it — the check above runs for every snapshot event, so either signal is enough. If the test still sees `'completed'`, add `'activity.enter'` to the listener set for terminate ids only (do not snapshot on it).

- [ ] **Step 4: Run the full suite**

Run: `pnpm build && pnpm test`
Expected: PASS — both E2E tests and all M1/M2 suites (nothing else observes `'terminated'`).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine-host packages/server/test/dry-run-e2e.test.ts
git commit -m "feat(server): terminate-end status and dry-run e2e of refined daily loop (M3.6)"
```

---

### Task 10: Real-file gate — grill CLI, grill the real files, dry-run refined rfp-daily, doc amendments (impl M3.5 + M3.6 verify)

No web UI until M4, so grilling the real files needs a terminal front-end: a small readline CLI wrapping `DefinitionStore` + `GrillHost` directly (same pattern as the M1/M2 probe scripts — tsx script, not a unit test). Then the milestone gate itself: refine `rfp-daily-routine.bpmn` to deployable, import + grill `interview-process.bpmn` (G2), dry-run the refined flagship through the daemon, and amend the design docs.

This task is interactive — live SDK sessions, judgment calls, manual verification. Steps list exact commands and acceptance criteria instead of test code.

**Files:**
- Create: `packages/server/scripts/grill-cli.ts`
- Modify: `docs/specs/design_flow-fabric.md` (§4.2 condition format amendment)
- Modify: `CLAUDE.md` ("Current state" section: M3 built)

**Interfaces:**
- Consumes: everything. Requires `.env` with `ANTHROPIC_API_KEY` (plus optional `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`).
- Produces: refined, deployable rfp-daily + interview versions in the local `~/.flow-fabric` definition store; amended docs.

- [ ] **Step 1: Write the grill CLI**

`packages/server/scripts/grill-cli.ts`:

```ts
/** Interactive grill session in the terminal (M3.5 gate; the M4 web UI replaces this).
 * Usage: node --env-file-if-exists=../../.env --import tsx scripts/grill-cli.ts <file.bpmn> [--db <path>]
 * Commands inside the session: /lint  /save  /quit — anything else is a chat message. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DefinitionStore } from '../src/definitions/store.js';
import { GrillHost } from '../src/grill/session.js';

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: grill-cli.ts <file.bpmn> [--db <path>]');
  process.exit(1);
}
const dbFlag = rest.indexOf('--db');
const dbPath = dbFlag !== -1 ? rest[dbFlag + 1] : path.join(os.homedir(), '.flow-fabric', 'flow-fabric.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const definitions = new DefinitionStore(dbPath);
const { id } = definitions.upload(path.basename(file, '.bpmn'), fs.readFileSync(file, 'utf8'));
const host = new GrillHost({ definitions });
const session = await host.start(id);
console.log(`definition ${id}, lint: ${session.lintReport.errorCount} error(s), ` +
  `${session.lintReport.findings.length - session.lintReport.errorCount} warning(s)`);

session.onEvent((event) => {
  if (event.type === 'chat' && event.message.type === 'assistant') {
    const blocks = (event.message.message as any)?.content ?? [];
    for (const b of blocks) if (b.type === 'text') console.log(`\n[grill] ${b.text}`);
  } else if (event.type === 'op-applied') {
    for (const d of event.diff) console.log(`  [op] ${d.summary}`);
  } else if (event.type === 'lint-updated') {
    console.log(`  [lint] ${event.report.errorCount} error(s), deployable=${event.report.deployable}`);
  } else if (event.type === 'op-rejected') {
    console.log(`  [rejected] ${event.error}`);
  } else if (event.type === 'error') {
    console.error(`  [error] ${event.error}`);
  }
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question('\nyou> ')).trim();
  if (line === '/quit') break;
  if (line === '/lint') {
    console.log(JSON.stringify(session.lintReport, null, 2));
    continue;
  }
  if (line === '/save') {
    const { versionNo, deployable } = session.saveVersion();
    console.log(`saved version ${versionNo} (deployable=${deployable})`);
    continue;
  }
  if (line) await session.send(line);
}
rl.close();
definitions.close();
```

Sanity check without spending tokens: `cd packages/server && node --import tsx scripts/grill-cli.ts test/fixtures/messy.bpmn --db $(mktemp -d)/ff.db`, then `/lint` and `/quit`.
Expected: lint report with FF001/FF002/FF003/FF006 findings prints; exits cleanly.

- [ ] **Step 2: Grill the real rfp-daily to deployable (impl M3.5)**

```bash
cd packages/server
node --env-file-if-exists=../../.env --import tsx scripts/grill-cli.ts ../../Input/bpmn/rfp-daily-routine.bpmn
```

Work through the session node by node (the 19 generic tasks get actors + contracts, 6 gateways get conditions/defaults, "Do No Re-Run" ends become terminate ends, the deadline becomes an instance input or user-task output). `/lint` between rounds; finish with `/save`.

Acceptance:
- saved version reports `deployable=true`;
- `sqlite3 ~/.flow-fabric/flow-fabric.db "select version_no, deployable from definition_versions"` shows the new version with `deployable=1`;
- no manual XML edits happened (everything through ops — the CLI offers no other path).

- [ ] **Step 3: Verify layout survived (risk #3 manual check)**

Export the refined XML and open it in a stock editor:

```bash
sqlite3 ~/.flow-fabric/flow-fabric.db \
  "select xml from definition_versions order by rowid desc limit 1" > /tmp/rfp-refined.bpmn
```

Open `/tmp/rfp-refined.bpmn` on <https://demo.bpmn.io> (or Camunda Modeler / Signavio).
Acceptance: diagram renders with the original layout — nodes in their Signavio positions, no stacked/unplaced elements (new error-boundary shapes may sit at approximate positions; everything else must be untouched).

- [ ] **Step 4: Import + grill interview-process (G2)**

```bash
node --env-file-if-exists=../../.env --import tsx scripts/grill-cli.ts ../../Input/bpmn/interview-process.bpmn
```

`/lint` first — confirm the report matches the automated expectations (FF002 on the 13 user tasks, FF003 on the 6 gateways, zero FF001). Then grill it: formSchemas for the user tasks, conditions for the gateways. `/save`.
Acceptance: version saved with `deployable=true` — "imports, survives the grilling session, and passes the linter, without the platform needing to execute it" (PRD success criterion 2).

- [ ] **Step 5: Dry-run the refined rfp-daily through the daemon (impl M3.6)**

The saved rfp-daily version keeps its real `PT24H` timer. For the dry run, create a short-timer variant *through the grill* (one more session: "set the wait timer to PT30S for a dry run", `/save`) — dogfoods `setTimerDefinition` and keeps the 24h version pristine for M5.

```bash
FF_PORT=4400 pnpm --filter @flowfabric/server dev   # terminal 1
curl -N http://127.0.0.1:4400/api/events            # terminal 2 (watch SSE)

# terminal 3: find ids, start the dry run against a scratch copy of the RFP workspace
curl -s http://127.0.0.1:4400/api/definitions | jq
curl -s -X POST http://127.0.0.1:4400/api/instances -H 'content-type: application/json' \
  -d '{"definitionId":"<rfp-def-id>","version":<short-timer-version>,"workspacePath":"/tmp/rfp-dry-ws","dryRun":true,"inputs":{...instance inputs...}}'

# when the inbox notification fires:
curl -s http://127.0.0.1:4400/api/inbox | jq
curl -s -X POST http://127.0.0.1:4400/api/user-tasks/<id>/submit -H 'content-type: application/json' \
  -d '{"vars":{...form vars...}}'

# after the run:
curl -s http://127.0.0.1:4400/api/instances/<instance-id> | jq '.timeline'
```

Acceptance (impl M3.6 verify):
- full daily cycle completes with stub agents + real user tasks;
- the timer loop reaches its second iteration (two executions of the audit-step node in the timeline; `activity.timer` events for the wait node in `.events`);
- every executed step shows in the timeline with inputs/outputs/status;
- macOS notification fired for the user task.

- [ ] **Step 6: Amend the docs**

- `docs/specs/design_flow-fabric.md` §4.2: replace the `${...}` gateway-condition sentence with the javascript format (`language="javascript"`, `next(null, <bool>)` via the `setGatewayCondition` wrapper), noting the M3 finding: the dispatch `scripts` hook compiles every condition body as JavaScript, so `${...}` expressions are rejected by linter rule 3. Reference this plan the way §4.1 references the M1 spike.
- `CLAUDE.md` "Current state" section: M3 built — `definitions/`, `linter/`, `patch-ops/`, `grill/`, `daemon.ts` exist; daemon entrypoint now real (`pnpm --filter @flowfabric/server dev`); statuses gained `terminated`; remaining spec-only work is M4 (web) + M5 (OTel/soak).

- [ ] **Step 7: Final full suite + commit**

Run: `pnpm build && pnpm test`
Expected: PASS.

```bash
git add packages/server/scripts/grill-cli.ts docs/specs/design_flow-fabric.md CLAUDE.md
git commit -m "feat(server): grill CLI; docs: condition-format amendment, M3 state (M3.5)"
```

---

## M3 exit checklist (impl spec verification gates)

- [ ] M3.1 — both Input files upload; versions persisted and retrievable (Task 2 tests incl. skipIf real-file test).
- [ ] M3.2 — unit tests per lint rule on fixtures; raw rfp-daily fails with specific findings; hand-refined fixture passes (Tasks 3–4).
- [ ] M3.3 — patch-op round-trip tests; semantic change applied, DI byte-identical outside targeted elements (Tasks 5–6, incl. real Signavio file).
- [ ] M3.4 — scripted session converts messy.bpmn to deployable without manual XML edits (Task 7); chat + ops over SSE (Task 8).
- [ ] M3.5 — real rfp-daily refined to deployable via grill CLI; refined file opens cleanly in a stock BPMN editor; interview-process imports, lints as expected, and grills to deployable (Task 10, steps 2–4).
- [ ] M3.6 — dry run of the refined rfp-daily completes a full daily cycle with stub agents + real user tasks; timer loop reaches the second iteration (Task 9 automated on the fixture; Task 10 step 5 on the real file).
- [ ] `pnpm build && pnpm test` green across the workspace; M1/M2 suites untouched and passing.

## Deferred (deliberately not in M3)

- `instances.status = 'waiting'` — still M4's call (UI derives it until then).
- `removeNode` patch op — orphans are fixed in the source editor and re-uploaded; revisit only if real grilling sessions hit it painfully.
- `GET /api/metrics/*`, `GET /api/scheduler` — M4 dashboards / system page (design §8 lists them; nothing consumes them before the UI).
- Grill session persistence across daemon restarts — sessions are in-memory; a killed daemon means re-opening the grill from the last saved version. Acceptable for a single-user local tool in M3.

## Changelog

- 2026-07-18 — Initial plan.
