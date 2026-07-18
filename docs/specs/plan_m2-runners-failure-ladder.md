# M2 Runners + Failure Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three actors (agent, code, user) plus a stub runner execute real task contracts inside `bpmn-engine`, failures escalate per FR-18 (retry → error boundary → incident), and a minimal REST + SSE API exposes instances, the inbox, and the timeline.

**Architecture:** `packages/shared` gains the `flowfabric` profile (contract types + moddle descriptor). `packages/server` gains a contract reader, a `TaskRunner` interface with stub/code/agent implementations, and an extended `EngineHost` that intercepts serviceTask/scriptTask execution via bpmn-engine `extensions`/`scripts` hooks and userTask waits via `activity.wait` + `execution.signal`. The M1 durability mechanism (snapshot on every transition, `resumeAll()` on boot) is preserved and extended. Spec: [impl_flow-fabric.md](impl_flow-fabric.md) M2, [design_flow-fabric.md](design_flow-fabric.md) §3, §4, §6.

**Tech Stack:** Node 22, TypeScript (strict, ESM, NodeNext), pnpm workspaces, `bpmn-engine` ^25, `bpmn-moddle` ^10, `better-sqlite3` ^12, `ajv` ^8, `fastify` ^5, `@anthropic-ai/claude-agent-sdk` (latest, 0.3.x at plan time), vitest ^3.

## Global Constraints

- Node ≥ 22, pnpm ≥ 9. All packages `"type": "module"`, TS `strict: true`, module/moduleResolution `NodeNext`. Import local modules with the `.js` extension in TS source.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Test databases and workspaces go in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))` — never in the repo.
- `flowfabric` namespace is exactly `http://flowfabric.dev/schema/1.0` (design §4.2).
- Timers are `timeDuration` only (M1 finding). Timer arm signal is `activity.timer`, **not** `activity.wait` — `activity.wait` fires only for user tasks. Gateway conditions use `language="javascript"` with `next(null, <bool>)`.
- `engine.getState()` is async — every new snapshot call goes through the existing promise queue in `EngineHost.run()`; never call it concurrently.
- `bpmn-engine` ships its own types; do not install `@types/bpmn-engine`. Where its types are too loose for the `extensions`/`scripts` hooks, use narrow local interfaces and `as unknown as` at the engine boundary — do not `any`-cannon whole files.
- The Claude Agent SDK is configured by env only (`ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` from `.env`). No per-task model/endpoint fields.
- Vitest `testTimeout: 20000` (already configured). Timer fixtures use 2–6 s durations.
- M1 files (`store.ts`, `engine-host.ts`, existing tests) keep working — `pnpm test` stays green after every task. Extend, don't rewrite: existing public signatures may gain optional parameters but must not break existing callers.

## Task overview and dependencies

1. Shared profile: contract types + moddle descriptor (impl M2.1)
2. Server contract reader + profile fixture
3. Dispatch spike: probe bpmn-engine interception hooks (de-risks 5, 8, 9)
4. `TaskRunner` interface + stub runner (impl M2.2)
5. EngineHost dispatch integration + dry-run e2e (impl M2.2 verify)
6. Code runner (impl M2.3)
7. Agent runner (impl M2.4)
8. User task service + notifier (impl M2.5)
9. Failure ladder: retries → boundary → incident (impl M2.6)
10. `task_executions` recording + timeline (impl M2.8)
11. REST API + SSE (impl M2.7)

Tasks 6 and 7 are independent of each other and of 8; both depend on 4–5. Task 9 depends on 5–6. Tasks 10–11 depend on everything before them.

---

### Task 1: Shared profile — contract types + moddle descriptor

**Files:**
- Create: `packages/shared/src/profile/types.ts`
- Create: `packages/shared/src/profile/descriptor.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json` (exports, vitest, bpmn-moddle devDep)
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/test/fixtures/contracts.bpmn`
- Test: `packages/shared/test/profile.test.ts`

**Interfaces:**
- Consumes: nothing (first M2 task).
- Produces (used by every later task):
  - `interface InputDecl { name: string; type: string }`
  - `interface AgentTaskContract { kind: 'agent'; retries: number; timeoutSeconds: number; prompt: string; tools: string[]; boundaries?: string; inputs: InputDecl[]; outputSchema: Record<string, unknown> }`
  - `interface CodeTaskContract { kind: 'code'; retries: number; timeoutSeconds: number; command: string; inputs: InputDecl[]; outputSchema: Record<string, unknown> }`
  - `interface UserTaskContract { kind: 'user'; formSchema: Record<string, unknown> }`
  - `type TaskContract = AgentTaskContract | CodeTaskContract | UserTaskContract`
  - `const flowfabricModdle` — the moddle descriptor object, passed to bpmn-moddle and bpmn-engine as `moddleOptions: { flowfabric: flowfabricModdle }`
  - `const FLOWFABRIC_NS = 'http://flowfabric.dev/schema/1.0'`

- [ ] **Step 1: Write the failing test**

`packages/shared/test/profile.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import BpmnModdle from 'bpmn-moddle';
import { describe, it, expect } from 'vitest';
import { flowfabricModdle } from '../src/profile/descriptor.js';

const xml = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

function moddle() {
  return new BpmnModdle({ flowfabric: flowfabricModdle });
}

// Extension elements land in extensionElements.values (moddle Element instances).
function extensionOf(el: any, typeName: string): any {
  return el.extensionElements?.values?.find((v: any) => v.$type === typeName);
}

describe('flowfabric moddle descriptor', () => {
  it('parses agent, code, and user contracts from the fixture', async () => {
    const { rootElement } = await moddle().fromXML(xml);
    const process = rootElement.rootElements.find((e: any) => e.$type === 'bpmn:Process');
    const byId = new Map(process.flowElements.map((e: any) => [e.id, e]));

    const agent = extensionOf(byId.get('agentTask'), 'flowfabric:AgentTask');
    expect(agent.retries).toBe(2);
    expect(agent.timeoutSeconds).toBe(600);
    expect(agent.prompt.text).toContain('Audit');
    expect(agent.tools.text).toBe('Read,Grep,Glob');
    expect(agent.inputs.map((i: any) => i.name)).toEqual(['deadline']);
    expect(JSON.parse(agent.outputSchema.text).required).toEqual(['atRiskTasks']);

    const code = extensionOf(byId.get('codeTask'), 'flowfabric:CodeTask');
    expect(code.command).toBe('node check.js');
    expect(JSON.parse(code.outputSchema.text).type).toBe('object');

    const user = extensionOf(byId.get('userTask'), 'flowfabric:UserTask');
    expect(JSON.parse(user.formSchema.text).properties.approved.type).toBe('boolean');
  });

  it('round-trips: serialize and re-parse with contracts intact', async () => {
    const m = moddle();
    const parsed = await m.fromXML(xml);
    const { xml: reXml } = await m.toXML(parsed.rootElement, { format: true });
    const again = await moddle().fromXML(reXml);
    const process = again.rootElement.rootElements.find((e: any) => e.$type === 'bpmn:Process');
    const agentTask = process.flowElements.find((e: any) => e.id === 'agentTask');
    const agent = extensionOf(agentTask, 'flowfabric:AgentTask');
    expect(agent.prompt.text).toContain('Audit');
    expect(reXml).toContain('http://flowfabric.dev/schema/1.0');
  });
});
```

- [ ] **Step 2: Write the fixture**

`packages/shared/test/fixtures/contracts.bpmn` — hand-written, profile-conformant, one task of each actor in sequence. This fixture is reused by Tasks 2 and 5:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="contractsDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="contractsProcess" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="agentTask" />
    <serviceTask id="agentTask" name="Audit tracker">
      <extensionElements>
        <flowfabric:agentTask retries="2" timeoutSeconds="600">
          <flowfabric:prompt>Audit the project tracker; flag tasks at risk.</flowfabric:prompt>
          <flowfabric:tools>Read,Grep,Glob</flowfabric:tools>
          <flowfabric:boundaries>Never modify files outside 30_tracker/</flowfabric:boundaries>
          <flowfabric:input name="deadline" type="string" />
          <flowfabric:outputSchema>{"type":"object","required":["atRiskTasks"],"properties":{"atRiskTasks":{"type":"array","items":{"type":"string"}}},"additionalProperties":true}</flowfabric:outputSchema>
        </flowfabric:agentTask>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="agentTask" targetRef="codeTask" />
    <scriptTask id="codeTask" name="Check counts">
      <extensionElements>
        <flowfabric:codeTask command="node check.js" retries="1" timeoutSeconds="30">
          <flowfabric:input name="atRiskTasks" type="array" />
          <flowfabric:outputSchema>{"type":"object","required":["count"],"properties":{"count":{"type":"number"}},"additionalProperties":true}</flowfabric:outputSchema>
        </flowfabric:codeTask>
      </extensionElements>
    </scriptTask>
    <sequenceFlow id="f3" sourceRef="codeTask" targetRef="userTask" />
    <userTask id="userTask" name="Approve result">
      <extensionElements>
        <flowfabric:userTask>
          <flowfabric:formSchema>{"type":"object","required":["approved"],"properties":{"approved":{"type":"boolean"}},"additionalProperties":false}</flowfabric:formSchema>
        </flowfabric:userTask>
      </extensionElements>
    </userTask>
    <sequenceFlow id="f4" sourceRef="userTask" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/shared test`
Expected: FAIL — cannot resolve `../src/profile/descriptor.js`. (If run before Step 4's package.json changes land, vitest itself is missing; install first.)

- [ ] **Step 4: Implement types, descriptor, and package plumbing**

`packages/shared/src/profile/types.ts`:

```ts
export interface InputDecl {
  name: string;
  type: string;
}

export interface AgentTaskContract {
  kind: 'agent';
  retries: number;
  timeoutSeconds: number;
  prompt: string;
  tools: string[];
  boundaries?: string;
  inputs: InputDecl[];
  outputSchema: Record<string, unknown>;
}

export interface CodeTaskContract {
  kind: 'code';
  retries: number;
  timeoutSeconds: number;
  command: string;
  inputs: InputDecl[];
  outputSchema: Record<string, unknown>;
}

export interface UserTaskContract {
  kind: 'user';
  formSchema: Record<string, unknown>;
}

export type TaskContract = AgentTaskContract | CodeTaskContract | UserTaskContract;
```

`packages/shared/src/profile/descriptor.ts` — moddle descriptor. `tagAlias: 'lowerCase'` maps type `AgentTask` to tag `flowfabric:agentTask`. Body-text children (`prompt`, `outputSchema`, …) are element types with an `isBody` string property:

```ts
export const FLOWFABRIC_NS = 'http://flowfabric.dev/schema/1.0';

const body = (name: string) => ({
  name,
  superClass: ['Element'],
  properties: [{ name: 'text', isBody: true, type: 'String' }],
});

export const flowfabricModdle = {
  name: 'FlowFabric',
  uri: FLOWFABRIC_NS,
  prefix: 'flowfabric',
  xml: { tagAlias: 'lowerCase' },
  types: [
    {
      name: 'AgentTask',
      superClass: ['Element'],
      properties: [
        { name: 'retries', isAttr: true, type: 'Integer' },
        { name: 'timeoutSeconds', isAttr: true, type: 'Integer' },
        { name: 'prompt', type: 'Prompt' },
        { name: 'tools', type: 'Tools' },
        { name: 'boundaries', type: 'Boundaries' },
        { name: 'inputs', isMany: true, type: 'Input' },
        { name: 'outputSchema', type: 'OutputSchema' },
      ],
    },
    {
      name: 'CodeTask',
      superClass: ['Element'],
      properties: [
        { name: 'command', isAttr: true, type: 'String' },
        { name: 'retries', isAttr: true, type: 'Integer' },
        { name: 'timeoutSeconds', isAttr: true, type: 'Integer' },
        { name: 'inputs', isMany: true, type: 'Input' },
        { name: 'outputSchema', type: 'OutputSchema' },
      ],
    },
    {
      name: 'UserTask',
      superClass: ['Element'],
      properties: [{ name: 'formSchema', type: 'FormSchema' }],
    },
    {
      name: 'Input',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'type', isAttr: true, type: 'String' },
      ],
    },
    body('Prompt'),
    body('Tools'),
    body('Boundaries'),
    body('OutputSchema'),
    body('FormSchema'),
  ],
};
```

`packages/shared/src/index.ts`:

```ts
export type {
  InputDecl,
  AgentTaskContract,
  CodeTaskContract,
  UserTaskContract,
  TaskContract,
} from './profile/types.js';
export { flowfabricModdle, FLOWFABRIC_NS } from './profile/descriptor.js';
```

`packages/shared/package.json` — replace the whole file:

```json
{
  "name": "@flowfabric/shared",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": { "build": "tsc -p .", "test": "vitest run" },
  "devDependencies": {
    "@types/node": "^22",
    "bpmn-moddle": "^10",
    "typescript": "^5",
    "vitest": "^3"
  }
}
```

`packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { testTimeout: 20000, hookTimeout: 20000 },
});
```

If `bpmn-moddle` lacks usable types under NodeNext, add `packages/shared/src/types/bpmn-moddle.d.ts` with `declare module 'bpmn-moddle';` and keep the test's `any` access pattern.

- [ ] **Step 5: Install and run test to verify it passes**

Run: `pnpm install && pnpm --filter @flowfabric/shared build && pnpm --filter @flowfabric/shared test`
Expected: PASS, both tests. If parsing puts contract children in the wrong property (moddle matches children by tag name → type via `tagAlias`), inspect `parsed.rootElement` with `console.dir(..., {depth: 8})` and fix the descriptor property names — the fixture XML is the spec (design §4.2); adjust the descriptor, not the fixture.

- [ ] **Step 6: Full sweep + commit**

Run: `pnpm build && pnpm test`
Expected: green (server M1 tests untouched).

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): flowfabric profile types and moddle descriptor"
```

---

### Task 2: Server contract reader

**Files:**
- Create: `packages/server/src/profile/read.ts`
- Modify: `packages/server/package.json` (add `@flowfabric/shared`, `bpmn-moddle`, `ajv`)
- Modify: `packages/server/src/index.ts`
- Create: `packages/server/test/fixtures/contracts.bpmn` (copy of the shared fixture)
- Test: `packages/server/test/profile-read.test.ts`

**Interfaces:**
- Consumes: `flowfabricModdle`, contract types (Task 1).
- Produces (used by Tasks 4, 5, 8, 9):
  - `interface ProcessProfile { contracts: Map<string, TaskContract>; errorBoundaryHosts: Set<string> }` — `contracts` keyed by node id; `errorBoundaryHosts` = ids of activities that have an attached error boundary event (the failure ladder branches on this in Task 9).
  - `async function readProfile(xml: string): Promise<ProcessProfile>`

- [ ] **Step 1: Write the failing test**

`packages/server/test/profile-read.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { readProfile } from '../src/profile/read.js';

const xml = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

describe('readProfile', () => {
  it('extracts one typed contract per task node', async () => {
    const { contracts } = await readProfile(xml);
    expect([...contracts.keys()].sort()).toEqual(['agentTask', 'codeTask', 'userTask']);

    const agent = contracts.get('agentTask');
    if (agent?.kind !== 'agent') throw new Error('expected agent contract');
    expect(agent.retries).toBe(2);
    expect(agent.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(agent.inputs).toEqual([{ name: 'deadline', type: 'string' }]);
    expect(agent.outputSchema.required).toEqual(['atRiskTasks']);
    expect(agent.boundaries).toContain('30_tracker');

    const code = contracts.get('codeTask');
    if (code?.kind !== 'code') throw new Error('expected code contract');
    expect(code.command).toBe('node check.js');

    const user = contracts.get('userTask');
    if (user?.kind !== 'user') throw new Error('expected user contract');
    expect((user.formSchema.properties as any).approved.type).toBe('boolean');
  });

  it('reports which activities have an attached error boundary', async () => {
    const withBoundary = xml.replace(
      '<endEvent id="end" />',
      `<boundaryEvent id="err" attachedToRef="codeTask"><errorEventDefinition /></boundaryEvent>
       <sequenceFlow id="fErr" sourceRef="err" targetRef="end2" />
       <endEvent id="end2" />
       <endEvent id="end" />`,
    );
    const { errorBoundaryHosts } = await readProfile(withBoundary);
    expect(errorBoundaryHosts.has('codeTask')).toBe(true);
    expect(errorBoundaryHosts.has('agentTask')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test profile-read`
Expected: FAIL — cannot resolve `../src/profile/read.js`.

- [ ] **Step 3: Implement the reader**

Add to `packages/server/package.json` dependencies:

```json
"@flowfabric/shared": "workspace:*",
"bpmn-moddle": "^10",
"ajv": "^8"
```

`packages/server/src/profile/read.ts`:

```ts
import BpmnModdle from 'bpmn-moddle';
import {
  flowfabricModdle,
  type TaskContract,
  type InputDecl,
} from '@flowfabric/shared';

export interface ProcessProfile {
  contracts: Map<string, TaskContract>;
  errorBoundaryHosts: Set<string>;
}

const DEFAULT_RETRIES = 0;
const DEFAULT_TIMEOUT_S = 600;

function ext(el: any, typeName: string): any {
  return el.extensionElements?.values?.find((v: any) => v.$type === typeName);
}

function inputs(raw: any[]): InputDecl[] {
  return (raw ?? []).map((i) => ({ name: i.name, type: i.type ?? 'string' }));
}

export async function readProfile(xml: string): Promise<ProcessProfile> {
  const moddle = new BpmnModdle({ flowfabric: flowfabricModdle });
  const { rootElement } = await moddle.fromXML(xml);
  const contracts = new Map<string, TaskContract>();
  const errorBoundaryHosts = new Set<string>();

  for (const root of rootElement.rootElements ?? []) {
    if (root.$type !== 'bpmn:Process') continue;
    for (const el of root.flowElements ?? []) {
      if (el.$type === 'bpmn:ServiceTask') {
        const a = ext(el, 'flowfabric:AgentTask');
        if (!a) continue;
        contracts.set(el.id, {
          kind: 'agent',
          retries: a.retries ?? DEFAULT_RETRIES,
          timeoutSeconds: a.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
          prompt: a.prompt?.text ?? '',
          tools: (a.tools?.text ?? '').split(',').map((t: string) => t.trim()).filter(Boolean),
          boundaries: a.boundaries?.text,
          inputs: inputs(a.inputs),
          outputSchema: JSON.parse(a.outputSchema?.text ?? '{}'),
        });
      } else if (el.$type === 'bpmn:ScriptTask') {
        const c = ext(el, 'flowfabric:CodeTask');
        if (!c) continue;
        contracts.set(el.id, {
          kind: 'code',
          retries: c.retries ?? DEFAULT_RETRIES,
          timeoutSeconds: c.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
          command: c.command ?? '',
          inputs: inputs(c.inputs),
          outputSchema: JSON.parse(c.outputSchema?.text ?? '{}'),
        });
      } else if (el.$type === 'bpmn:UserTask') {
        const u = ext(el, 'flowfabric:UserTask');
        if (!u) continue;
        contracts.set(el.id, {
          kind: 'user',
          formSchema: JSON.parse(u.formSchema?.text ?? '{}'),
        });
      } else if (el.$type === 'bpmn:BoundaryEvent') {
        const isError = (el.eventDefinitions ?? []).some(
          (d: any) => d.$type === 'bpmn:ErrorEventDefinition',
        );
        if (isError && el.attachedToRef?.id) errorBoundaryHosts.add(el.attachedToRef.id);
      }
    }
  }
  return { contracts, errorBoundaryHosts };
}
```

Copy the fixture: `cp packages/shared/test/fixtures/contracts.bpmn packages/server/test/fixtures/contracts.bpmn` (a copy, not a symlink — the packages must stay independently testable).

Append to `packages/server/src/index.ts`:

```ts
export { readProfile } from './profile/read.js';
export type { ProcessProfile } from './profile/read.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm --filter @flowfabric/shared build && pnpm --filter @flowfabric/server test profile-read`
Expected: PASS. Note: server tests import `@flowfabric/shared` from its built `dist/` — rebuild shared after any change to it.

- [ ] **Step 5: Full sweep + commit**

Run: `pnpm build && pnpm test`
Expected: green.

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): contract reader for flowfabric profile"
```

---

### Task 3: Dispatch spike — probe bpmn-engine interception hooks

Before building the runner integration, prove the four mechanisms it depends on. This is a probe script (M1 style), not a unit test — its output decides details of Tasks 5, 8, 9.

**Files:**
- Create: `packages/server/scripts/probe-dispatch.ts`
- Create: `docs/specs/findings_m2-dispatch.md`

**Interfaces:**
- Consumes: `contracts.bpmn` fixture, `readProfile` (Task 2).
- Produces: recorded answers to the four questions below; the hook shapes Tasks 5/8/9 assume.

**The four questions:**

1. **ServiceTask interception** — does an `extensions` function that sets `activity.behaviour.Service = factory` get its `execute(executionMessage, callback)` called, support async completion, and route `callback(err)` to an attached error boundary?
2. **ScriptTask interception** — does a custom engine `scripts` implementation (`register(activity)` / `getScript(format, activity)`) let us run code tasks ourselves while still executing inline-script tasks and JavaScript `conditionExpression`s (which also flow through `scripts`)?
3. **UserTask signal** — does `userTask` emit `activity.wait`, and does `engine.execution.signal({ id, ...vars })` resume it? Where do the signal payload vars land (activity output vs environment)?
4. **Recover re-execution** — after `engine.getState()` mid-service-task, does `new Engine().recover(state, { extensions, scripts, moddleOptions })` + `resume()` re-invoke the service `execute` for the in-flight task? (The incident model in Task 9 depends on re-invocation.)

- [ ] **Step 1: Write the probe**

`packages/server/scripts/probe-dispatch.ts`:

```ts
// Usage: cd packages/server && node --import tsx scripts/probe-dispatch.ts
// Prints RESULT lines for the four dispatch questions. Record them in
// docs/specs/findings_m2-dispatch.md.
import { EventEmitter } from 'node:events';
import { Engine } from 'bpmn-engine';
import { flowfabricModdle } from '@flowfabric/shared';

const NS = 'xmlns:flowfabric="http://flowfabric.dev/schema/1.0"';

// Q1 + Q4 fixture: serviceTask with error boundary.
const serviceSource = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ${NS}
  id="probeDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
    <serviceTask id="svc" />
    <boundaryEvent id="onErr" attachedToRef="svc"><errorEventDefinition /></boundaryEvent>
    <sequenceFlow id="fErr" sourceRef="onErr" targetRef="endErr" />
    <endEvent id="endErr" />
    <sequenceFlow id="f2" sourceRef="svc" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

// Q2 fixture: inline scriptTask + contract-less code path + JS condition loop.
const scriptSource = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ${NS}
  id="probeDef2" targetNamespace="http://flowfabric.dev/spike">
  <process id="p2" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="inline" />
    <scriptTask id="inline" scriptFormat="javascript">
      <script><![CDATA[ this.environment.variables.count = (this.environment.variables.count || 0) + 1; next(); ]]></script>
    </scriptTask>
    <sequenceFlow id="f2" sourceRef="inline" targetRef="gw" />
    <exclusiveGateway id="gw" default="toEnd" />
    <sequenceFlow id="loop" sourceRef="gw" targetRef="inline">
      <conditionExpression xsi:type="tFormalExpression" language="javascript"><![CDATA[
        next(null, this.environment.variables.count < 2);
      ]]></conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="toEnd" sourceRef="gw" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

// Q3 fixture: bare userTask.
const userSource = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ${NS}
  id="probeDef3" targetNamespace="http://flowfabric.dev/spike">
  <process id="p3" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="ask" />
    <userTask id="ask" />
    <sequenceFlow id="f2" sourceRef="ask" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

function serviceExtension(behavior: 'succeed' | 'fail', calls: string[]) {
  return {
    flowfabric(activity: any) {
      if (activity.type !== 'bpmn:ServiceTask') return;
      activity.behaviour.Service = function Service() {
        return {
          execute(_msg: any, callback: (err?: Error | null, out?: unknown) => void) {
            calls.push(`execute:${activity.id}`);
            setTimeout(() => {
              if (behavior === 'fail') callback(new Error('boom'));
              else {
                activity.environment.variables.svcOut = 42;
                callback(null, { svcOut: 42 });
              }
            }, 200);
          },
        };
      };
    },
  };
}

async function q1() {
  for (const behavior of ['succeed', 'fail'] as const) {
    const calls: string[] = [];
    const engine = new Engine({
      name: `q1-${behavior}`,
      source: serviceSource,
      moddleOptions: { flowfabric: flowfabricModdle },
      extensions: serviceExtension(behavior, calls),
    });
    const listener = new EventEmitter();
    const ends: string[] = [];
    listener.on('activity.end', (api: { id: string }) => ends.push(api.id));
    const done = new Promise<string>((resolve) => {
      engine.once('end', () => resolve('end'));
      engine.once('error', (err: Error) => resolve(`engine-error:${err.message}`));
    });
    await engine.execute({ listener });
    const outcome = await done;
    console.log(`RESULT q1/${behavior}: calls=${calls} ends=${ends} outcome=${outcome}`);
    // Expect succeed → ends contains 'end'; fail → ends contains 'endErr' (boundary), not engine-error.
  }
}

function probeScripts(calls: string[]) {
  const registry = new Map<string, { execute: Function }>();
  return {
    register({ id, type, behaviour, environment }: any) {
      calls.push(`register:${type}:${id}`);
      let body: string | undefined;
      if (type === 'bpmn:SequenceFlow') body = behaviour.conditionExpression?.body;
      else if (type === 'bpmn:ScriptTask') body = behaviour.script;
      if (!body) return;
      const fn = new Function('next', body);
      registry.set(id, {
        execute(scope: any, callback: Function) {
          fn.call(scope, callback);
        },
      });
    },
    getScript(_format: string, { id }: any) {
      return registry.get(id);
    },
  };
}

async function q2() {
  const calls: string[] = [];
  const engine = new Engine({
    name: 'q2',
    source: scriptSource,
    moddleOptions: { flowfabric: flowfabricModdle },
    scripts: probeScripts(calls) as any,
  });
  const listener = new EventEmitter();
  const done = new Promise<string>((resolve) => {
    engine.once('end', () => resolve('end'));
    engine.once('error', (err: Error) => resolve(`engine-error:${err.message}`));
  });
  await engine.execute({ listener });
  const outcome = await done;
  const state = await engine.getState();
  const vars = (state as any).definitions?.[0]?.environment?.variables;
  console.log(`RESULT q2: outcome=${outcome} registered=${calls.join('|')} vars=${JSON.stringify(vars)}`);
  // Expect: registers for scriptTask AND conditioned sequenceFlow; count === 2 (loop ran once).
}

async function q3() {
  const engine = new Engine({ name: 'q3', source: userSource });
  const listener = new EventEmitter();
  const waits: string[] = [];
  listener.on('activity.wait', (api: { id: string }) => waits.push(api.id));
  const done = new Promise<void>((resolve) => engine.once('end', () => resolve()));
  const execution = await engine.execute({ listener });
  await new Promise((r) => setTimeout(r, 200));
  console.log(`RESULT q3/wait: waits=${waits} postponed=${execution.getPostponed().map((a: any) => a.id)}`);
  execution.signal({ id: 'ask', approved: true });
  await done;
  const state = await engine.getState();
  console.log(`RESULT q3/signal: completed, state.environment=${JSON.stringify((state as any).definitions?.[0]?.environment)}`);
  // Note where {approved:true} landed: environment.variables? environment.output? activity output only?
}

async function q4() {
  const calls: string[] = [];
  const engine = new Engine({
    name: 'q4',
    source: serviceSource,
    moddleOptions: { flowfabric: flowfabricModdle },
    extensions: {
      flowfabric(activity: any) {
        if (activity.type !== 'bpmn:ServiceTask') return;
        activity.behaviour.Service = function Service() {
          return {
            execute() {
              calls.push('execute-first-run'); // never calls back — stuck in-flight
            },
          };
        };
      },
    },
  });
  const listener = new EventEmitter();
  await engine.execute({ listener });
  await new Promise((r) => setTimeout(r, 300));
  const state = await engine.getState();
  await engine.stop();

  const resumed = new Engine().recover(JSON.parse(JSON.stringify(state)), {
    moddleOptions: { flowfabric: flowfabricModdle },
    extensions: serviceExtension('succeed', calls),
  } as any);
  const done = new Promise<string>((resolve) => {
    resumed.once('end', () => resolve('end'));
    resumed.once('error', (err: Error) => resolve(`engine-error:${err.message}`));
  });
  await resumed.resume({ listener: new EventEmitter() });
  const outcome = await done;
  console.log(`RESULT q4: calls=${calls} outcome=${outcome}`);
  // Expect: 'execute-first-run' then 'execute:svc' after recover — re-invocation confirmed.
}

await q1();
await q2();
await q3();
await q4();
```

- [ ] **Step 2: Run the probe and record findings**

Run: `pnpm --filter @flowfabric/shared build && cd packages/server && node --import tsx scripts/probe-dispatch.ts`

Write `docs/specs/findings_m2-dispatch.md` with one row per question — answer + the exact RESULT line as evidence:

```markdown
# M2 Dispatch Spike — Findings

| | |
|---|---|
| Date | <fill> |
| bpmn-engine version | <from pnpm ls bpmn-engine> |

| Question | Answer | Evidence (RESULT line) |
|---|---|---|
| Service override via extensions works, async, boundary-routes errors? | <fill> | q1 |
| Custom `scripts` runs script tasks and JS conditions? Exact register/getScript/execute signatures? | <fill> | q2 |
| userTask emits activity.wait; execution.signal resumes; signal vars land in <where>? | <fill> | q3 |
| Recover with {extensions} re-invokes in-flight service execute? | <fill> | q4 |

## Adjustments required to Tasks 5/8/9

<fill: e.g. exact scripts execute(scope, callback) signature, where signal vars land, or "none">
```

**If a probe fails:** q1 failing kills the whole approach — stop and re-plan dispatch around a custom `scripts`-only design (code tasks) plus patched `implementation="${environment.services.ff}"` attributes (agent tasks; patch-ops adds them in M3). q2 failing → run inline scripts and conditions through bpmn-engine's default behavior by *not* overriding `scripts` globally, and route code tasks through a Service-style override probed on ScriptTask. q3/q4 answers just parameterize Tasks 8/9 — record and continue.

- [ ] **Step 3: Commit**

```bash
git add packages/server/scripts docs/specs/findings_m2-dispatch.md
git commit -m "docs(specs): probe bpmn-engine dispatch hooks for M2 runners"
```

---

### Task 4: TaskRunner interface + stub runner

**Files:**
- Create: `packages/server/src/runners/types.ts`
- Create: `packages/server/src/runners/validate.ts`
- Create: `packages/server/src/runners/stub.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/stub-runner.test.ts`

**Interfaces:**
- Consumes: contract types (Task 1).
- Produces (used by Tasks 5–9):
  - `interface RunContext { instanceId: string; nodeId: string; workspace: string; attempt: number; signal: AbortSignal; dataDir: string }`
  - `interface RunResult { output: Record<string, unknown>; tokenUsage?: unknown; costUsd?: number; transcriptPath?: string }`
  - `interface TaskRunner { run(contract: AgentTaskContract | CodeTaskContract, inputs: Record<string, unknown>, ctx: RunContext): Promise<RunResult> }`
  - `class StubRunner implements TaskRunner { constructor(overrides?: Record<string, Record<string, unknown>>) }` — overrides keyed by node id.
  - `function validateOutput(schema: Record<string, unknown>, value: unknown): void` — throws `OutputValidationError` (with `errorsText`) on mismatch.
  - `class OutputValidationError extends Error`

- [ ] **Step 1: Write the failing test**

`packages/server/test/stub-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StubRunner } from '../src/runners/stub.js';
import { validateOutput, OutputValidationError } from '../src/runners/validate.js';
import type { AgentTaskContract } from '@flowfabric/shared';

function agentContract(schema: Record<string, unknown>): AgentTaskContract {
  return {
    kind: 'agent', retries: 0, timeoutSeconds: 60,
    prompt: 'p', tools: [], inputs: [], outputSchema: schema,
  };
}

const ctx = {
  instanceId: 'i1', nodeId: 'n1', workspace: '/tmp',
  attempt: 1, signal: new AbortController().signal, dataDir: '/tmp',
};

describe('StubRunner', () => {
  it('derives schema-conforming fake output', async () => {
    const schema = {
      type: 'object',
      required: ['atRiskTasks', 'count', 'ok', 'mode'],
      properties: {
        atRiskTasks: { type: 'array', items: { type: 'string' } },
        count: { type: 'number' },
        ok: { type: 'boolean' },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
    };
    const { output } = await new StubRunner().run(agentContract(schema), {}, ctx);
    expect(() => validateOutput(schema, output)).not.toThrow();
    expect(output).toEqual({ atRiskTasks: [], count: 0, ok: false, mode: 'fast' });
  });

  it('per-node overrides win over derivation', async () => {
    const schema = {
      type: 'object', required: ['count'],
      properties: { count: { type: 'number' } },
    };
    const stub = new StubRunner({ n1: { count: 7 } });
    const { output } = await stub.run(agentContract(schema), {}, ctx);
    expect(output).toEqual({ count: 7 });
  });
});

describe('validateOutput', () => {
  it('throws OutputValidationError with details on schema mismatch', () => {
    const schema = { type: 'object', required: ['x'], properties: { x: { type: 'number' } } };
    expect(() => validateOutput(schema, { x: 'nope' })).toThrow(OutputValidationError);
    try {
      validateOutput(schema, {});
    } catch (err) {
      expect(String(err)).toContain('x');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test stub-runner`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/server/src/runners/types.ts`:

```ts
import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';

export interface RunContext {
  instanceId: string;
  nodeId: string;
  workspace: string;
  attempt: number;
  signal: AbortSignal;
  dataDir: string;
}

export interface RunResult {
  output: Record<string, unknown>;
  tokenUsage?: unknown;
  costUsd?: number;
  transcriptPath?: string;
}

export interface TaskRunner {
  run(
    contract: AgentTaskContract | CodeTaskContract,
    inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult>;
}
```

`packages/server/src/runners/validate.ts` (ajv is CJS; NodeNext default-import interop applies — if the default import misbehaves at runtime, use `const AjvCtor = (Ajv as any).default ?? Ajv`):

```ts
import Ajv from 'ajv';

export class OutputValidationError extends Error {}

const ajv = new Ajv({ allErrors: true });

export function validateOutput(schema: Record<string, unknown>, value: unknown): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new OutputValidationError(ajv.errorsText(validate.errors));
  }
}
```

`packages/server/src/runners/stub.ts`:

```ts
import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { RunContext, RunResult, TaskRunner } from './types.js';

/** json-schema-faker-style minimal derivation (design §6.1 Stub). */
export function deriveFromSchema(schema: any): unknown {
  if (schema === undefined || schema === null) return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      const keys: string[] = schema.required ?? Object.keys(props);
      for (const key of keys) out[key] = deriveFromSchema(props[key] ?? {});
      return out;
    }
    case 'array':
      return [];
    case 'string':
      return 'stub';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

export class StubRunner implements TaskRunner {
  constructor(private overrides: Record<string, Record<string, unknown>> = {}) {}

  async run(
    contract: AgentTaskContract | CodeTaskContract,
    _inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    const override = this.overrides[ctx.nodeId];
    if (override) return { output: override };
    return { output: deriveFromSchema(contract.outputSchema) as Record<string, unknown> };
  }
}
```

Append to `packages/server/src/index.ts`:

```ts
export type { RunContext, RunResult, TaskRunner } from './runners/types.js';
export { StubRunner, deriveFromSchema } from './runners/stub.js';
export { validateOutput, OutputValidationError } from './runners/validate.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowfabric/server test stub-runner`
Expected: PASS.

- [ ] **Step 5: Full sweep + commit**

Run: `pnpm build && pnpm test`
Expected: green.

```bash
git add packages/server
git commit -m "feat(server): TaskRunner interface, Ajv output validation, stub runner"
```

---

### Task 5: EngineHost dispatch integration + dry-run e2e

Wire runners into the engine using the hooks proved in Task 3. After this task a dry-run instance of `contracts.bpmn` completes end-to-end with stub agent/code output and a real user-task signal. M1 fixtures (inline scripts, conditions, timers) must keep passing under the new engine configuration.

**Files:**
- Create: `packages/server/src/engine-host/dispatch.ts`
- Modify: `packages/server/src/engine-host/store.ts`
- Modify: `packages/server/src/engine-host/engine-host.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/dispatch.test.ts`

**Interfaces:**
- Consumes: `readProfile` (Task 2), `TaskRunner`/`StubRunner`/`validateOutput` (Task 4), probe findings (Task 3).
- Produces (used by Tasks 6–11):
  - `interface RunnerSet { agent: TaskRunner; code: TaskRunner }`
  - `interface EngineHostOptions { runners?: RunnerSet; dataDir?: string }`
  - `class EngineHost { constructor(store: InstanceStore, opts?: EngineHostOptions) }` — M1 call sites (`new EngineHost(store)`) stay valid.
  - `EngineHost.start(opts: { id; name; source; workspace?: string; variables?; dryRun?: boolean; stubOverrides?: Record<string, Record<string, unknown>> }): Promise<void>`
  - `EngineHost.signal(instanceId: string, nodeId: string, vars: Record<string, unknown>): void` — resumes a waiting user task, merging `vars` into process variables.
  - `createDispatch(deps: DispatchDeps): { extensions; scripts }` where `DispatchDeps = { instanceId; workspace; dataDir; profile: ProcessProfile; runners: RunnerSet; runTask?: RunTaskFn }` — `runTask` is the seam Task 9 replaces with the failure ladder.
  - `type RunTaskFn = (nodeId: string, contract: AgentTaskContract | CodeTaskContract, environment: EngineEnvironment) => Promise<Record<string, unknown>>`
  - `InstanceRow` gains `workspace: string`, `dryRun: boolean`, `stubOverrides: string | null`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/dispatch.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const source = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
}

async function waitForEvent(store: InstanceStore, id: string, type: string, elementId: string) {
  for (let i = 0; i < 100; i++) {
    if (store.listEvents(id).some((e) => e.type === type && e.elementId === elementId)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${type}:${elementId}`);
}

// Engine-state variables live under definitions[0].environment.variables
// (M1 state shape); adjust here if the probe found otherwise.
function varsOf(store: InstanceStore, id: string): Record<string, unknown> {
  const state = JSON.parse(store.getInstance(id)!.engineState!);
  return state.definitions[0].environment.variables;
}

describe('dry-run dispatch', () => {
  let store: InstanceStore;
  afterEach(() => store?.close());

  it('completes contracts.bpmn with stub output, override, and user signal', async () => {
    const dir = tmp();
    store = new InstanceStore(path.join(dir, 'ff.db'));
    const host = new EngineHost(store, { dataDir: dir });

    const running = host.start({
      id: 'd1',
      name: 'contracts',
      source,
      workspace: tmp(),
      dryRun: true,
      stubOverrides: { codeTask: { count: 5 } },
    });

    await waitForEvent(store, 'd1', 'activity.wait', 'userTask');
    host.signal('d1', 'userTask', { approved: true });
    await running;

    expect(store.getInstance('d1')?.status).toBe('completed');
    const vars = varsOf(store, 'd1');
    expect(vars.atRiskTasks).toEqual([]); // stub-derived from agentTask schema
    expect(vars.count).toBe(5); // per-node override
    expect(vars.approved).toBe(true); // user signal payload
  });

  it('persists workspace and dryRun on the instance row', async () => {
    const dir = tmp();
    store = new InstanceStore(path.join(dir, 'ff.db'));
    const host = new EngineHost(store, { dataDir: dir });
    const ws = tmp();
    const running = host.start({ id: 'd2', name: 'contracts', source, workspace: ws, dryRun: true });
    await waitForEvent(store, 'd2', 'activity.wait', 'userTask');
    const row = store.getInstance('d2')!;
    expect(row.workspace).toBe(ws);
    expect(row.dryRun).toBe(true);
    host.signal('d2', 'userTask', { approved: false });
    await running;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test dispatch`
Expected: FAIL — `start` rejects unknown options / `signal` missing / columns missing.

- [ ] **Step 3: Extend InstanceStore**

In `packages/server/src/engine-host/store.ts` — no released DB exists yet (M1 was a spike), so change the schema in place, no migration:

- Add columns to the `CREATE TABLE instances` statement: `workspace_path TEXT NOT NULL DEFAULT ''`, `dry_run INTEGER NOT NULL DEFAULT 0`, `stub_overrides TEXT`.
- Extend `InstanceRow` with `workspace: string; dryRun: boolean; stubOverrides: string | null`.
- `createInstance(id, name, source, opts: { workspace?: string; dryRun?: boolean; stubOverrides?: Record<string, Record<string, unknown>> } = {})` — insert `opts.workspace ?? ''`, `opts.dryRun ? 1 : 0`, `opts.stubOverrides ? JSON.stringify(opts.stubOverrides) : null`.
- `getInstance` / `listNonTerminal` select the new columns (`workspace_path AS workspace`, `dry_run AS dryRun`, `stub_overrides AS stubOverrides`) and coerce `dryRun: !!row.dryRun` before returning (SQLite returns 0/1).

- [ ] **Step 4: Implement `dispatch.ts`**

`packages/server/src/engine-host/dispatch.ts`. Two hooks from the Task 3 probe: an `extensions` function that swaps in a `Service` factory for contract-bearing serviceTasks, and a `scripts` implementation that (a) runs contract-bearing scriptTasks through the code runner, (b) still executes inline `<script>` bodies and JavaScript `conditionExpression`s (M1 fixtures) by compiling them with `new Function('next', body)` and calling with the engine-supplied scope as `this`. Adjust signatures to the exact shapes recorded in `findings_m2-dispatch.md`.

```ts
import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { ProcessProfile } from '../profile/read.js';
import type { TaskRunner } from '../runners/types.js';
import { validateOutput } from '../runners/validate.js';

export interface RunnerSet {
  agent: TaskRunner;
  code: TaskRunner;
}

export interface EngineEnvironment {
  variables: Record<string, unknown>;
}

export type RunTaskFn = (
  nodeId: string,
  contract: AgentTaskContract | CodeTaskContract,
  environment: EngineEnvironment,
) => Promise<Record<string, unknown>>;

export interface DispatchDeps {
  instanceId: string;
  workspace: string;
  dataDir: string;
  profile: ProcessProfile;
  runners: RunnerSet;
  /** Overridden by the failure ladder in Task 9. Default: one attempt, validate, throw on failure. */
  runTask?: RunTaskFn;
}

export function resolveInputs(
  contract: AgentTaskContract | CodeTaskContract,
  environment: EngineEnvironment,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const decl of contract.inputs) inputs[decl.name] = environment.variables[decl.name];
  return inputs;
}

export function makeSingleAttemptRunTask(deps: DispatchDeps): RunTaskFn {
  return async (nodeId, contract, environment) => {
    const inputs = resolveInputs(contract, environment);
    const controller = new AbortController();
    const timeoutMs = contract.timeoutSeconds * 1000;
    const timer = setTimeout(
      () => controller.abort(new Error(`task ${nodeId} timed out after ${contract.timeoutSeconds}s`)),
      timeoutMs,
    );
    const timedOut = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }),
    );
    try {
      const runner = contract.kind === 'agent' ? deps.runners.agent : deps.runners.code;
      const result = await Promise.race([
        runner.run(contract, inputs, {
          instanceId: deps.instanceId,
          nodeId,
          workspace: deps.workspace,
          attempt: 1,
          signal: controller.signal,
          dataDir: deps.dataDir,
        }),
        timedOut,
      ]);
      validateOutput(contract.outputSchema, result.output);
      return result.output;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createDispatch(deps: DispatchDeps): { extensions: object; scripts: object } {
  const runTask = deps.runTask ?? makeSingleAttemptRunTask(deps);

  const extensions = {
    flowfabric(activity: any) {
      const contract = deps.profile.contracts.get(activity.id);
      if (activity.type !== 'bpmn:ServiceTask' || contract?.kind !== 'agent') return;
      activity.behaviour.Service = function FlowFabricService() {
        return {
          execute(_msg: unknown, callback: (err?: Error | null, out?: unknown) => void) {
            runTask(activity.id, contract, activity.environment)
              .then((output) => {
                Object.assign(activity.environment.variables, output);
                callback(null, output);
              })
              .catch((err: Error) => callback(err));
          },
        };
      };
    },
  };

  // Scripts registry: contract scriptTasks → code runner; inline scripts and
  // JS conditions → compiled Function, same semantics as bpmn-engine's default
  // (script body sees `this` = engine scope, completes via next(err, result)).
  const registry = new Map<string, { execute(scope: any, next: (...a: unknown[]) => void): void }>();
  const scripts = {
    register({ id, type, behaviour }: any) {
      if (type === 'bpmn:SequenceFlow') {
        const body = behaviour.conditionExpression?.body;
        if (!body) return;
        const fn = new Function('next', body);
        registry.set(id, { execute: (scope, next) => fn.call(scope, next) });
        return;
      }
      if (type !== 'bpmn:ScriptTask') return;
      const contract = deps.profile.contracts.get(id);
      if (contract?.kind === 'code') {
        registry.set(id, {
          execute(scope: any, next) {
            runTask(id, contract, scope.environment)
              .then((output) => {
                Object.assign(scope.environment.variables, output);
                next(null, output);
              })
              .catch((err: Error) => next(err));
          },
        });
      } else if (behaviour.script) {
        const fn = new Function('next', behaviour.script);
        registry.set(id, { execute: (scope, next) => fn.call(scope, next) });
      }
    },
    getScript(_format: string, { id }: any) {
      return registry.get(id);
    },
  };

  return { extensions, scripts };
}
```

- [ ] **Step 5: Extend EngineHost**

In `packages/server/src/engine-host/engine-host.ts`:

- Constructor: `constructor(private store: InstanceStore, private opts: EngineHostOptions = {})` with `interface EngineHostOptions { runners?: RunnerSet; dataDir?: string }`.
- `running` map now stores `{ engine, execution }`; capture the return of `engine.execute(...)` / `engine.resume(...)` as `execution`.
- New private helper — build engine options for a given instance:

```ts
private async engineComponents(row: {
  id: string; source: string; workspace: string; dryRun: boolean; stubOverrides: string | null;
}) {
  const profile = await readProfile(row.source);
  const runners: RunnerSet = row.dryRun
    ? { agent: new StubRunner(JSON.parse(row.stubOverrides ?? '{}')), code: new StubRunner(JSON.parse(row.stubOverrides ?? '{}')) }
    : this.opts.runners ?? missingRunners(profile);
  const { extensions, scripts } = createDispatch({
    instanceId: row.id,
    workspace: row.workspace,
    dataDir: this.opts.dataDir ?? os.tmpdir(),
    profile,
    runners,
  });
  return { extensions, scripts, moddleOptions: { flowfabric: flowfabricModdle } };
}
```

  where `missingRunners(profile)` returns a `RunnerSet` whose runners throw `new Error('no runner configured for <kind> task')` — but only if `profile.contracts.size > 0`; for contract-less sources (M1 fixtures) any placeholder is fine because it is never invoked.
- `start()`: `this.store.createInstance(opts.id, opts.name, opts.source, { workspace: opts.workspace, dryRun: opts.dryRun, stubOverrides: opts.stubOverrides })`, then `new Engine({ name, source, ...components })`.
- `resumeAll()`: for each row, `await this.engineComponents(row)` and `new Engine().recover(JSON.parse(row.engineState!), components)` — pass the same extensions/scripts/moddleOptions as recover options (probe q4 shape). `resumeAll` therefore becomes `async resumeAll(): Promise<Array<{ id, completion }>>`; update M1 tests' call sites (`await host.resumeAll()`) — this is the one M1-visible signature change, and it is mechanical.
- New method:

```ts
/** Resume a waiting user task, merging vars into process variables. */
signal(instanceId: string, nodeId: string, vars: Record<string, unknown>): void {
  const entry = this.running.get(instanceId);
  if (!entry) throw new Error(`instance ${instanceId} is not running in this host`);
  Object.assign(entry.execution.environment.variables, vars);
  entry.execution.signal({ id: nodeId });
}
```

  (If probe q3 showed signal payload vars merge into variables automatically, drop the manual `Object.assign` and pass `{ id: nodeId, ...vars }` instead — keep exactly one merge path.)

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @flowfabric/shared build && pnpm --filter @flowfabric/server test`
Expected: `dispatch.test.ts` PASS, **and** all M1 tests (engine-basics, persistence, resume, loop) still PASS — the loop test is the proof that compiled inline scripts and conditions behave identically under the custom `scripts` hook. If loop fails, the condition/script compilation semantics differ from the default: fix the `scripts` wrapper (compare against probe q2 output), never the fixtures.

- [ ] **Step 7: Export, sweep, commit**

Append to `packages/server/src/index.ts`:

```ts
export { createDispatch, makeSingleAttemptRunTask, resolveInputs } from './engine-host/dispatch.js';
export type { DispatchDeps, RunnerSet, RunTaskFn, EngineEnvironment } from './engine-host/dispatch.js';
```

Run: `pnpm build && pnpm test`
Expected: green.

```bash
git add packages/server
git commit -m "feat(server): engine-host runner dispatch with dry-run stub execution"
```

---

### Task 6: Code runner

**Files:**
- Create: `packages/server/src/runners/code.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/code-runner.test.ts`

**Interfaces:**
- Consumes: `TaskRunner`, `RunContext`, `RunResult` (Task 4), `CodeTaskContract` (Task 1).
- Produces: `class CodeRunner implements TaskRunner` — spawns `contract.command` with `cwd = ctx.workspace`, inputs as `FF_VAR_<NAME>` env vars and JSON on stdin, parses stdout as the JSON output (FR-12). Kills the child when `ctx.signal` aborts. Schema validation stays in dispatch (Task 5) — the runner only parses.

- [ ] **Step 1: Write the failing test**

`packages/server/test/code-runner.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CodeRunner } from '../src/runners/code.js';
import type { CodeTaskContract } from '@flowfabric/shared';

function contract(command: string): CodeTaskContract {
  return {
    kind: 'code', retries: 0, timeoutSeconds: 30, command,
    inputs: [{ name: 'deadline', type: 'string' }],
    outputSchema: { type: 'object' },
  };
}

function ctx(signal = new AbortController().signal) {
  return {
    instanceId: 'i1', nodeId: 'codeTask',
    workspace: mkdtempSync(path.join(os.tmpdir(), 'ff-spike-')),
    attempt: 1, signal, dataDir: os.tmpdir(),
  };
}

const runner = new CodeRunner();

describe('CodeRunner', () => {
  it('passes inputs via FF_VAR_* env and stdin, parses stdout JSON', async () => {
    const cmd = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{` +
      `console.log(JSON.stringify({fromEnv:process.env.FF_VAR_DEADLINE,fromStdin:JSON.parse(s).deadline,cwdOk:true}))})"`;
    const { output } = await runner.run(contract(cmd), { deadline: '2026-08-01' }, ctx());
    expect(output).toEqual({ fromEnv: '2026-08-01', fromStdin: '2026-08-01', cwdOk: true });
  });

  it('runs in the workspace directory', async () => {
    const c = ctx();
    const cmd = `node -e "console.log(JSON.stringify({cwd:process.cwd()}))"`;
    const { output } = await runner.run(contract(cmd), {}, c);
    // realpath both sides: macOS tmpdir is symlinked (/var → /private/var)
    const { realpathSync } = await import('node:fs');
    expect(realpathSync(output.cwd as string)).toBe(realpathSync(c.workspace));
  });

  it('rejects on non-zero exit with stderr in the message', async () => {
    const cmd = `node -e "console.error('kaput');process.exit(3)"`;
    await expect(runner.run(contract(cmd), {}, ctx())).rejects.toThrow(/exited 3.*kaput/s);
  });

  it('rejects on non-JSON stdout', async () => {
    const cmd = `node -e "console.log('not json')"`;
    await expect(runner.run(contract(cmd), {}, ctx())).rejects.toThrow(/not valid JSON/);
  });

  it('kills the child when the abort signal fires (timeout path)', async () => {
    const controller = new AbortController();
    const cmd = `node -e "setTimeout(()=>{},10000)"`;
    const pending = runner.run(contract(cmd), {}, ctx(controller.signal));
    setTimeout(() => controller.abort(new Error('task timed out')), 300);
    const started = Date.now();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000); // did not wait for the 10s child
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test code-runner`
Expected: FAIL — `../src/runners/code.js` not found.

- [ ] **Step 3: Implement**

`packages/server/src/runners/code.ts`:

```ts
import { spawn } from 'node:child_process';
import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { RunContext, RunResult, TaskRunner } from './types.js';

export class CodeRunner implements TaskRunner {
  async run(
    contract: AgentTaskContract | CodeTaskContract,
    inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    if (contract.kind !== 'code') throw new Error('CodeRunner only handles code tasks');

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(inputs)) {
      env[`FF_VAR_${key.toUpperCase()}`] = typeof value === 'string' ? value : JSON.stringify(value);
    }

    const child = spawn(contract.command, {
      cwd: ctx.workspace,
      env,
      shell: true,
      signal: ctx.signal, // Node kills the child when the signal aborts
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(JSON.stringify(inputs));
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject); // spawn failure or abort
      child.once('close', (code) => resolve(code ?? -1));
    });

    if (exitCode !== 0) {
      throw new Error(`command exited ${exitCode}: ${stderr.trim().slice(0, 500)}`);
    }
    try {
      return { output: JSON.parse(stdout) as Record<string, unknown> };
    } catch {
      throw new Error(`stdout is not valid JSON: ${stdout.trim().slice(0, 200)}`);
    }
  }
}
```

Append to `packages/server/src/index.ts`:

```ts
export { CodeRunner } from './runners/code.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowfabric/server test code-runner`
Expected: PASS, all five.

- [ ] **Step 5: Sweep + commit**

Run: `pnpm build && pnpm test`

```bash
git add packages/server
git commit -m "feat(server): code runner with FF_VAR env, stdin JSON, abort kill"
```

---

### Task 7: Agent runner (Claude Agent SDK)

**Files:**
- Create: `packages/server/src/runners/agent.ts`
- Modify: `packages/server/package.json` (add `@anthropic-ai/claude-agent-sdk`)
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/agent-runner.test.ts`

**Interfaces:**
- Consumes: `TaskRunner` types (Task 4), `AgentTaskContract` (Task 1).
- Produces:
  - `type AgentQueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>` — the transport seam; production default is `query` from `@anthropic-ai/claude-agent-sdk`, tests inject fakes.
  - `class AgentRunner implements TaskRunner { constructor(queryFn?: AgentQueryFn) }` — fresh headless session per task (FR-11): `cwd` = workspace, `allowedTools` from contract, prompt = contract prompt + boundaries + serialized inputs + output-schema instruction. Extracts the JSON object from the final `result` message; retries the extraction **once within the same attempt** by resuming the session (design §6.1). Writes every SDK message as a JSONL transcript under `<dataDir>/transcripts/<instanceId>/<nodeId>.<attempt>.jsonl` and returns `tokenUsage`, `costUsd`, `transcriptPath`.
  - `function extractJson(text: string): Record<string, unknown>` — whole-string parse, then fenced ```json block, then first-`{`-to-last-`}` substring; throws if none parse.

Notes pinned by the SDK docs (v0.3.x): `query({ prompt, options })` returns an async iterable of messages; `options` supports `cwd`, `allowedTools`, `permissionMode`, `env`, `maxTurns`, `abortController`, `settingSources`, `resume`; the final message has `type: 'result'` with `subtype: 'success'`, `result` (string), `usage`, `total_cost_usd`, `session_id`. Unattended execution uses `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` — the tool allowlist and the workspace cwd are the actual containment (boundaries are prompt-level per design). `settingSources: []` (the default) keeps user/project CLAUDE.md files out of task sessions. The SDK inherits `ANTHROPIC_*` from the daemon environment — no keys in code.

- [ ] **Step 1: Write the failing test**

`packages/server/test/agent-runner.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AgentRunner, extractJson } from '../src/runners/agent.js';
import type { AgentTaskContract } from '@flowfabric/shared';

const contract: AgentTaskContract = {
  kind: 'agent', retries: 0, timeoutSeconds: 600,
  prompt: 'Audit the tracker.', tools: ['Read', 'Grep'],
  boundaries: 'Never modify files outside 30_tracker/',
  inputs: [{ name: 'deadline', type: 'string' }],
  outputSchema: { type: 'object', required: ['atRiskTasks'], properties: { atRiskTasks: { type: 'array' } } },
};

function ctx() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
  return {
    instanceId: 'i1', nodeId: 'agentTask',
    workspace: dir, attempt: 1,
    signal: new AbortController().signal, dataDir: dir,
  };
}

function resultMessage(text: string, sessionId = 's1') {
  return {
    type: 'result', subtype: 'success', session_id: sessionId,
    result: text, total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe('AgentRunner (mock transport)', () => {
  it('builds prompt/options, extracts JSON, records transcript and usage', async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const queryFn = (args: any) => {
      calls.push(args);
      return (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] } };
        yield resultMessage('Here you go:\n```json\n{"atRiskTasks":["t1"]}\n```');
      })();
    };
    const c = ctx();
    const result = await new AgentRunner(queryFn).run(contract, { deadline: '2026-08-01' }, c);

    expect(result.output).toEqual({ atRiskTasks: ['t1'] });
    expect(result.costUsd).toBe(0.01);
    expect(result.tokenUsage).toEqual({ input_tokens: 100, output_tokens: 50 });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('Audit the tracker.');
    expect(calls[0].prompt).toContain('30_tracker');
    expect(calls[0].prompt).toContain('"deadline": "2026-08-01"');
    expect(calls[0].prompt).toContain('"atRiskTasks"');
    expect(calls[0].options.cwd).toBe(c.workspace);
    expect(calls[0].options.allowedTools).toEqual(['Read', 'Grep']);

    const transcript = readFileSync(result.transcriptPath!, 'utf8').trim().split('\n');
    expect(transcript).toHaveLength(2);
    expect(JSON.parse(transcript[1]).type).toBe('result');
  });

  it('retries JSON extraction once by resuming the session', async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const queryFn = (args: any) => {
      calls.push(args);
      return (async function* () {
        yield resultMessage(
          calls.length === 1 ? 'I did the audit, all good!' : '{"atRiskTasks":[]}',
          'sess-42',
        );
      })();
    };
    const result = await new AgentRunner(queryFn).run(contract, {}, ctx());
    expect(result.output).toEqual({ atRiskTasks: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe('sess-42');
  });

  it('throws when the SDK reports an error subtype', async () => {
    const queryFn = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['boom'], session_id: 's', total_cost_usd: 0, usage: {} };
      })();
    await expect(new AgentRunner(queryFn as any).run(contract, {}, ctx())).rejects.toThrow(/error_during_execution/);
  });
});

describe('extractJson', () => {
  it('parses bare JSON, fenced JSON, and embedded JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('text\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 });
    expect(extractJson('prefix {"a":{"b":2}} ')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow();
  });
});

// Live smoke test (impl M2.4 verify). Needs ANTHROPIC_API_KEY (+ optional
// ANTHROPIC_BASE_URL/ANTHROPIC_MODEL) exported, e.g.: set -a; source .env; set +a
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('AgentRunner live smoke', () => {
  it('returns schema-conforming JSON from a real session', async () => {
    const live: AgentTaskContract = {
      kind: 'agent', retries: 0, timeoutSeconds: 120,
      prompt: 'Reply with the JSON object {"ok": true}. Do nothing else.',
      tools: [], inputs: [],
      outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    };
    const result = await new AgentRunner().run(live, {}, ctx());
    expect(result.output).toEqual({ ok: true });
    expect(result.costUsd).toBeGreaterThan(0);
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test agent-runner`
Expected: FAIL — `../src/runners/agent.js` not found.

- [ ] **Step 3: Implement**

Add to `packages/server/package.json` dependencies: `"@anthropic-ai/claude-agent-sdk": "^0.3"` (then `pnpm install`).

`packages/server/src/runners/agent.ts`:

```ts
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { RunContext, RunResult, TaskRunner } from './types.js';

export type AgentQueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

export function extractJson(text: string): Record<string, unknown> {
  const candidates = [text.trim()];
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error(`no JSON object found in agent output: ${text.slice(0, 200)}`);
}

function buildPrompt(contract: AgentTaskContract, inputs: Record<string, unknown>): string {
  return [
    contract.prompt,
    contract.boundaries ? `Boundaries:\n${contract.boundaries}` : '',
    `Inputs:\n${JSON.stringify(inputs, null, 2)}`,
    'End your final message with a single JSON object matching this JSON Schema — no prose after it:',
    JSON.stringify(contract.outputSchema),
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface ResultMessage {
  type: 'result';
  subtype: string;
  result?: string;
  session_id: string;
  usage?: unknown;
  total_cost_usd?: number;
  errors?: string[];
}

export class AgentRunner implements TaskRunner {
  constructor(private queryFn: AgentQueryFn = query as unknown as AgentQueryFn) {}

  async run(
    contract: AgentTaskContract | CodeTaskContract,
    inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    if (contract.kind !== 'agent') throw new Error('AgentRunner only handles agent tasks');

    const dir = path.join(ctx.dataDir, 'transcripts', ctx.instanceId);
    mkdirSync(dir, { recursive: true });
    const transcriptPath = path.join(dir, `${ctx.nodeId}.${ctx.attempt}.jsonl`);
    const transcript = createWriteStream(transcriptPath, { flags: 'a' });

    const abortController = new AbortController();
    ctx.signal.addEventListener('abort', () => abortController.abort(ctx.signal.reason), { once: true });
    const baseOptions: Record<string, unknown> = {
      cwd: ctx.workspace,
      allowedTools: contract.tools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      maxTurns: 50,
      abortController,
    };

    try {
      const first = await this.runSession(buildPrompt(contract, inputs), baseOptions, transcript);
      let costUsd = first.total_cost_usd ?? 0;
      let tokenUsage = first.usage;
      try {
        return { output: extractJson(first.result ?? ''), tokenUsage, costUsd, transcriptPath };
      } catch {
        // One in-attempt retry (design §6.1): resume the session and ask for JSON only.
        const second = await this.runSession(
          'Your previous reply did not end with the required JSON object. Reply with ONLY that JSON object now.',
          { ...baseOptions, resume: first.session_id },
          transcript,
        );
        costUsd += second.total_cost_usd ?? 0;
        tokenUsage = second.usage ?? tokenUsage;
        return { output: extractJson(second.result ?? ''), tokenUsage, costUsd, transcriptPath };
      }
    } finally {
      transcript.end();
    }
  }

  private async runSession(
    prompt: string,
    options: Record<string, unknown>,
    transcript: WriteStream,
  ): Promise<ResultMessage> {
    let result: ResultMessage | undefined;
    for await (const message of this.queryFn({ prompt, options })) {
      transcript.write(`${JSON.stringify(message)}\n`);
      if (message.type === 'result') result = message as unknown as ResultMessage;
    }
    if (!result) throw new Error('agent session ended without a result message');
    if (result.subtype !== 'success') {
      throw new Error(`agent session failed (${result.subtype}): ${(result.errors ?? []).join('; ')}`);
    }
    return result;
  }
}
```

Append to `packages/server/src/index.ts`:

```ts
export { AgentRunner, extractJson } from './runners/agent.js';
export type { AgentQueryFn } from './runners/agent.js';
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test agent-runner`
Expected: mock-transport tests PASS; live smoke SKIPPED (no key in the test env).

- [ ] **Step 5: Live smoke, once, manually**

Run: `set -a; source .env; set +a; pnpm --filter @flowfabric/server test agent-runner`
Expected: live smoke PASS against the configured endpoint (works with DeepSeek's Anthropic-compatible API per `.env.example`). Record cost printed by the test if reviewing the fresh-session cost risk (PRD §9). Unset the key afterwards so CI-style runs stay hermetic.

- [ ] **Step 6: Sweep + commit**

Run: `pnpm build && pnpm test`

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): agent runner on Claude Agent SDK with transcript and usage capture"
```

---

### Task 8: User task service + notifier

**Files:**
- Create: `packages/server/src/inbox/inbox.ts`
- Create: `packages/server/src/notify/notifier.ts`
- Modify: `packages/server/src/engine-host/store.ts` (user_tasks table)
- Modify: `packages/server/src/engine-host/engine-host.ts` (`onUserTaskWait` hook)
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/user-tasks.test.ts`

**Interfaces:**
- Consumes: `EngineHost.signal` (Task 5), `validateOutput` (Task 4), `UserTaskContract` (Task 1).
- Produces (used by Tasks 9, 11):
  - `interface Notifier { notify(title: string, body: string, link?: string): Promise<void> }`
  - `class MacNotifier implements Notifier` — `terminal-notifier` if on PATH, `osascript` fallback (design §2). Never throws: notification failure must not break execution.
  - `interface UserTaskRow { id: number; instanceId: string; nodeId: string; formSchema: string; status: 'pending' | 'submitted'; submittedVars: string | null }`
  - Store methods: `createUserTask(instanceId, nodeId, formSchema): number`, `findPendingUserTask(instanceId, nodeId): UserTaskRow | undefined`, `listPendingUserTasks(): UserTaskRow[]`, `getUserTask(id)`, `submitUserTask(id, vars)`.
  - `class Inbox { constructor(store: InstanceStore, host: EngineHost, notifier: Notifier); handleWait(info: UserTaskWaitInfo): void; listPending(): UserTaskRow[]; async submit(taskId: number, vars: Record<string, unknown>): Promise<void> }`
  - `EngineHostOptions` gains `onUserTaskWait?: (info: UserTaskWaitInfo) => void` with `interface UserTaskWaitInfo { instanceId: string; nodeId: string; formSchema: Record<string, unknown> }`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/user-tasks.test.ts` (reuses `contracts.bpmn`, whose stub-covered agent/code tasks run through instantly in dry-run, landing on the user task):

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import type { Notifier } from '../src/notify/notifier.js';

const source = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
}

class MockNotifier implements Notifier {
  calls: Array<{ title: string; body: string }> = [];
  async notify(title: string, body: string) {
    this.calls.push({ title, body });
  }
}

function build(dbPath: string, notifier: MockNotifier) {
  const store = new InstanceStore(dbPath);
  // two-phase wiring: inbox needs host, host needs inbox's handleWait
  let inbox!: Inbox;
  const host = new EngineHost(store, {
    dataDir: path.dirname(dbPath),
    onUserTaskWait: (info) => inbox.handleWait(info),
  });
  inbox = new Inbox(store, host, notifier);
  return { store, host, inbox };
}

async function waitForPending(inbox: Inbox, count = 1) {
  for (let i = 0; i < 100; i++) {
    if (inbox.listPending().length >= count) return;
    await sleep(100);
  }
  throw new Error('timed out waiting for pending user task');
}

describe('user task service', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('creates a pending row and notifies when a user task waits', async () => {
    const notifier = new MockNotifier();
    const { store, host, inbox } = build(path.join(tmp(), 'ff.db'), notifier);
    stores.push(store);

    const running = host.start({ id: 'u1', name: 'contracts', source, workspace: tmp(), dryRun: true });
    await waitForPending(inbox);

    const [pending] = inbox.listPending();
    expect(pending.instanceId).toBe('u1');
    expect(pending.nodeId).toBe('userTask');
    expect(JSON.parse(pending.formSchema).properties.approved.type).toBe('boolean');
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0].body).toContain('userTask');

    await inbox.submit(pending.id, { approved: true });
    await running;
    expect(store.getInstance('u1')?.status).toBe('completed');
    expect(inbox.listPending()).toHaveLength(0);
  });

  it('rejects submissions that fail the form schema and keeps the task pending', async () => {
    const notifier = new MockNotifier();
    const { store, host, inbox } = build(path.join(tmp(), 'ff.db'), notifier);
    stores.push(store);

    const running = host.start({ id: 'u2', name: 'contracts', source, workspace: tmp(), dryRun: true });
    await waitForPending(inbox);
    const [pending] = inbox.listPending();

    await expect(inbox.submit(pending.id, { approved: 'yes' })).rejects.toThrow();
    expect(inbox.listPending()).toHaveLength(1);

    await inbox.submit(pending.id, { approved: false });
    await running;
    expect(store.getInstance('u2')?.status).toBe('completed');
  });

  it('does not duplicate the pending row or re-notify after a restart', async () => {
    const dbPath = path.join(tmp(), 'ff.db');
    const notifier1 = new MockNotifier();
    const first = build(dbPath, notifier1);
    stores.push(first.store);

    const running = first.host.start({ id: 'u3', name: 'contracts', source, workspace: tmp(), dryRun: true });
    await waitForPending(first.inbox);
    await first.host.stopAll();
    await running;
    first.store.close();

    const notifier2 = new MockNotifier();
    const second = build(dbPath, notifier2);
    stores.push(second.store);
    const resumed = await second.host.resumeAll();
    await sleep(500); // resume re-enters the wait state

    expect(second.inbox.listPending()).toHaveLength(1); // still exactly one
    expect(notifier2.calls).toHaveLength(0); // no re-notification

    const [pending] = second.inbox.listPending();
    await second.inbox.submit(pending.id, { approved: true });
    await Promise.all(resumed.map((r) => r.completion));
    expect(second.store.getInstance('u3')?.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test user-tasks`
Expected: FAIL — inbox/notifier modules missing.

- [ ] **Step 3: Implement store + host hook**

`store.ts` — add to the schema block:

```sql
CREATE TABLE IF NOT EXISTS user_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  node_id TEXT NOT NULL,
  form_schema TEXT NOT NULL,
  status TEXT NOT NULL,
  submitted_vars TEXT,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER
);
```

Methods (same prepared-statement style as the existing ones): `createUserTask` inserts with status `'pending'` and returns `lastInsertRowid as number`; `findPendingUserTask(instanceId, nodeId)` selects `WHERE instance_id = ? AND node_id = ? AND status = 'pending'`; `listPendingUserTasks()` selects all pending ordered by id; `getUserTask(id)`; `submitUserTask(id, vars)` sets `status = 'submitted'`, `submitted_vars = JSON.stringify(vars)`, `submitted_at = Date.now()`.

`engine-host.ts` — keep the per-instance `ProcessProfile` from `engineComponents()` in a `profiles: Map<string, ProcessProfile>`. In `run()`'s existing `activity.wait` listener branch, after `appendEvent`:

```ts
if (event === 'activity.wait') {
  const contract = this.profiles.get(id)?.contracts.get(api.id);
  if (contract?.kind === 'user') {
    this.opts.onUserTaskWait?.({ instanceId: id, nodeId: api.id, formSchema: contract.formSchema });
  }
}
```

- [ ] **Step 4: Implement notifier + inbox**

`packages/server/src/notify/notifier.ts`:

```ts
import { spawn } from 'node:child_process';

export interface Notifier {
  notify(title: string, body: string, link?: string): Promise<void>;
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.once('error', () => resolve(false)); // ENOENT etc.
    child.once('close', (code) => resolve(code === 0));
  });
}

/** macOS notifications: terminal-notifier, then osascript fallback. Never throws. */
export class MacNotifier implements Notifier {
  async notify(title: string, body: string, link?: string): Promise<void> {
    const args = ['-title', title, '-message', body, ...(link ? ['-open', link] : [])];
    if (await run('terminal-notifier', args)) return;
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    await run('osascript', ['-e', script]);
  }
}
```

`packages/server/src/inbox/inbox.ts`:

```ts
import type { InstanceStore, UserTaskRow } from '../engine-host/store.js';
import type { EngineHost, UserTaskWaitInfo } from '../engine-host/engine-host.js';
import type { Notifier } from '../notify/notifier.js';
import { validateOutput } from '../runners/validate.js';

export class Inbox {
  constructor(
    private store: InstanceStore,
    private host: EngineHost,
    private notifier: Notifier,
  ) {}

  /** Wire as EngineHostOptions.onUserTaskWait. Idempotent across resumes. */
  handleWait(info: UserTaskWaitInfo): void {
    if (this.store.findPendingUserTask(info.instanceId, info.nodeId)) return;
    this.store.createUserTask(info.instanceId, info.nodeId, JSON.stringify(info.formSchema));
    void this.notifier.notify(
      'Flow Fabric: task waiting',
      `${info.instanceId}: ${info.nodeId} needs your input`,
    );
  }

  listPending(): UserTaskRow[] {
    return this.store.listPendingUserTasks();
  }

  async submit(taskId: number, vars: Record<string, unknown>): Promise<void> {
    const task = this.store.getUserTask(taskId);
    if (!task || task.status !== 'pending') throw new Error(`no pending user task ${taskId}`);
    validateOutput(JSON.parse(task.formSchema), vars); // FR-13: validate before resuming
    this.host.signal(task.instanceId, task.nodeId, vars);
    this.store.submitUserTask(taskId, vars);
  }
}
```

Append to `packages/server/src/index.ts`:

```ts
export { Inbox } from './inbox/inbox.js';
export { MacNotifier } from './notify/notifier.js';
export type { Notifier } from './notify/notifier.js';
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @flowfabric/server test user-tasks`
Expected: PASS, all three.

- [ ] **Step 6: Manual notification check (impl M2.5 verify)**

Run: `cd packages/server && node --import tsx -e "import('./src/notify/notifier.js').then(async (m) => new m.MacNotifier().notify('Flow Fabric', 'notifier smoke test'))"`
Expected: a macOS notification appears. Record which path fired (terminal-notifier or osascript).

- [ ] **Step 7: Sweep + commit**

Run: `pnpm build && pnpm test`

```bash
git add packages/server
git commit -m "feat(server): user task inbox with schema-validated submit and macOS notifier"
```

---

### Task 9: Failure ladder — retries → error boundary → incident

**Files:**
- Create: `packages/server/src/engine-host/failure.ts`
- Create: `packages/server/test/fixtures/failure.bpmn`
- Modify: `packages/server/src/engine-host/store.ts` (incidents table, statuses)
- Modify: `packages/server/src/engine-host/engine-host.ts` (ladder wiring, `resolveIncident`, `abort`)
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/failure-ladder.test.ts`

**Interfaces:**
- Consumes: dispatch `runTask` seam (Task 5), `errorBoundaryHosts` (Task 2), `Notifier` (Task 8), probe q4 finding (in-flight service `execute` re-invoked after recover — this is what re-establishes a held incident after restart).
- Produces (used by Tasks 10–11):
  - `InstanceStatus` gains `'incident' | 'aborted'`; `listNonTerminal()` now covers `('running','stopped','incident')`.
  - `interface IncidentRow { id: number; instanceId: string; nodeId: string; reason: string; status: 'open' | 'resolved'; resolution: string | null }`
  - Store methods: `createIncident(instanceId, nodeId, reason): number`, `findOpenIncident(instanceId, nodeId)`, `listOpenIncidents()`, `getIncident(id)`, `resolveIncident(id, resolution)`.
  - `makeLadderRunTask(deps: LadderDeps): RunTaskFn` — the failure-ladder implementation of the Task 5 seam.
  - `EngineHost.resolveIncident(incidentId: number, action: 'retry' | 'skip' | 'abort', output?: Record<string, unknown>): Promise<void>`
  - `EngineHost.abort(instanceId: string): Promise<void>` — stops the engine, status `'aborted'`.

**Semantics (design §6.3):** failure = runner throw (schema violation, non-zero exit, SDK error, timeout). Rung 1: retry up to `contract.retries` (total attempts = retries + 1). Rung 2: if the node has a modeled error boundary, rethrow — the engine routes the token to the boundary. Rung 3: raise an incident — persist row, set instance status `'incident'`, notify, and **hold** (never call the engine back; the token pauses in place, state snapshot included). Resolutions: `retry` = one new attempt (success resolves the incident and releases the held token; failure keeps it open and holds again); `skip` = user-supplied output validated against the contract's outputSchema, then released as the task's output; `abort` = engine stopped, instance `'aborted'`, held promise abandoned. After a restart, `resumeAll()` re-invokes the in-flight task's `execute` (probe q4); the ladder sees the open incident row and holds immediately **without** re-running the runner or re-notifying.

- [ ] **Step 1: Write the fixture**

`packages/server/test/fixtures/failure.bpmn` — one code task; the boundary variant is derived in the test by string-replacing `BOUNDARY`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="failureDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="failureProcess" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="flaky" />
    <scriptTask id="flaky" name="Flaky step">
      <extensionElements>
        <flowfabric:codeTask command="unused" retries="1" timeoutSeconds="30">
          <flowfabric:outputSchema>{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}},"additionalProperties":false}</flowfabric:outputSchema>
        </flowfabric:codeTask>
      </extensionElements>
    </scriptTask>
    <!--BOUNDARY-->
    <sequenceFlow id="f2" sourceRef="flaky" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>
```

Boundary variant (inserted by the test in place of `<!--BOUNDARY-->`):

```xml
<boundaryEvent id="onErr" attachedToRef="flaky"><errorEventDefinition /></boundaryEvent>
<sequenceFlow id="fErr" sourceRef="onErr" targetRef="endErr" />
<endEvent id="endErr" />
```

- [ ] **Step 2: Write the failing tests**

`packages/server/test/failure-ladder.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import type { RunResult, TaskRunner } from '../src/runners/types.js';
import type { Notifier } from '../src/notify/notifier.js';

const plain = readFileSync(new URL('./fixtures/failure.bpmn', import.meta.url), 'utf8');
const withBoundary = plain.replace(
  '<!--BOUNDARY-->',
  `<boundaryEvent id="onErr" attachedToRef="flaky"><errorEventDefinition /></boundaryEvent>
   <sequenceFlow id="fErr" sourceRef="onErr" targetRef="endErr" />
   <endEvent id="endErr" />`,
);

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
}

/** Fails `failures` times, then succeeds with {ok:true}. Counts calls. */
class FlakyRunner implements TaskRunner {
  calls = 0;
  constructor(private failures: number) {}
  async run(): Promise<RunResult> {
    this.calls += 1;
    if (this.calls <= this.failures) throw new Error(`induced failure #${this.calls}`);
    return { output: { ok: true } };
  }
}

class MockNotifier implements Notifier {
  calls: string[] = [];
  async notify(title: string) {
    this.calls.push(title);
  }
}

function build(dbPath: string, runner: TaskRunner, notifier = new MockNotifier()) {
  const store = new InstanceStore(dbPath);
  const host = new EngineHost(store, {
    dataDir: path.dirname(dbPath),
    runners: { agent: runner, code: runner },
    notifier,
  });
  return { store, host, notifier };
}

async function waitForStatus(store: InstanceStore, id: string, status: string) {
  for (let i = 0; i < 100; i++) {
    if (store.getInstance(id)?.status === status) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for status ${status}, got ${store.getInstance(id)?.status}`);
}

describe('failure ladder', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('rung 1: retries within the attempt budget, then succeeds', async () => {
    const runner = new FlakyRunner(1); // fail once; retries=1 allows 2 attempts
    const { store, host } = build(path.join(tmp(), 'ff.db'), runner);
    stores.push(store);
    await host.start({ id: 'r1', name: 'failure', source: plain, workspace: tmp() });
    expect(store.getInstance('r1')?.status).toBe('completed');
    expect(runner.calls).toBe(2);
    expect(store.listOpenIncidents()).toHaveLength(0);
  });

  it('rung 2: exhausted retries route to the modeled error boundary', async () => {
    const runner = new FlakyRunner(Infinity);
    const { store, host } = build(path.join(tmp(), 'ff.db'), runner);
    stores.push(store);
    await host.start({ id: 'r2', name: 'failure', source: withBoundary, workspace: tmp() });
    expect(store.getInstance('r2')?.status).toBe('completed');
    expect(runner.calls).toBe(2); // retries=1 → 2 attempts, no more
    expect(store.listOpenIncidents()).toHaveLength(0);
    const ends = store.listEvents('r2').filter((e) => e.type === 'activity.end').map((e) => e.elementId);
    expect(ends).toContain('endErr');
    expect(ends).not.toContain('end');
  });

  it('rung 3: no boundary → incident raised, notified, token held', async () => {
    const runner = new FlakyRunner(Infinity);
    const { store, host, notifier } = build(path.join(tmp(), 'ff.db'), runner);
    stores.push(store);
    const running = host.start({ id: 'r3', name: 'failure', source: plain, workspace: tmp() });
    await waitForStatus(store, 'r3', 'incident');

    const [incident] = store.listOpenIncidents();
    expect(incident.nodeId).toBe('flaky');
    expect(incident.reason).toContain('induced failure');
    expect(notifier.calls.some((t) => t.includes('incident'))).toBe(true);

    // resolve: retry, with the runner now healthy
    runner.calls = 0;
    (runner as any).failures = 0;
    await host.resolveIncident(incident.id, 'retry');
    await running;
    expect(store.getInstance('r3')?.status).toBe('completed');
    expect(store.getIncident(incident.id)?.status).toBe('resolved');
  });

  it('skip validates the supplied output against the contract schema', async () => {
    const { store, host } = build(path.join(tmp(), 'ff.db'), new FlakyRunner(Infinity));
    stores.push(store);
    const running = host.start({ id: 'r4', name: 'failure', source: plain, workspace: tmp() });
    await waitForStatus(store, 'r4', 'incident');
    const [incident] = store.listOpenIncidents();

    await expect(host.resolveIncident(incident.id, 'skip', { wrong: 1 })).rejects.toThrow();
    expect(store.getIncident(incident.id)?.status).toBe('open');

    await host.resolveIncident(incident.id, 'skip', { ok: true });
    await running;
    expect(store.getInstance('r4')?.status).toBe('completed');
  });

  it('abort stops the engine and marks the instance aborted', async () => {
    const { store, host } = build(path.join(tmp(), 'ff.db'), new FlakyRunner(Infinity));
    stores.push(store);
    void host.start({ id: 'r5', name: 'failure', source: plain, workspace: tmp() });
    await waitForStatus(store, 'r5', 'incident');
    const [incident] = store.listOpenIncidents();
    await host.resolveIncident(incident.id, 'abort');
    await waitForStatus(store, 'r5', 'aborted');
    expect(store.getIncident(incident.id)?.resolution).toBe('abort');
  });

  it('open incident survives restart: held again without re-running or re-notifying', async () => {
    const dbPath = path.join(tmp(), 'ff.db');
    const runner1 = new FlakyRunner(Infinity);
    const first = build(dbPath, runner1);
    stores.push(first.store);
    const running = first.host.start({ id: 'r6', name: 'failure', source: plain, workspace: tmp() });
    await waitForStatus(first.store, 'r6', 'incident');
    await first.host.stopAll();
    await running;
    expect(first.store.getInstance('r6')?.status).toBe('incident'); // stop must not overwrite
    first.store.close();

    const runner2 = new FlakyRunner(0); // healthy now
    const second = build(dbPath, runner2);
    stores.push(second.store);
    const resumed = await second.host.resumeAll();
    await sleep(500);
    expect(runner2.calls).toBe(0); // held, not re-run
    expect(second.notifier.calls).toHaveLength(0); // not re-notified

    const [incident] = second.store.listOpenIncidents();
    await second.host.resolveIncident(incident.id, 'retry');
    await Promise.all(resumed.map((r) => r.completion));
    expect(second.store.getInstance('r6')?.status).toBe('completed');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @flowfabric/server test failure-ladder`
Expected: FAIL — store methods and `resolveIncident` missing.

- [ ] **Step 4: Implement store changes**

`store.ts`:

- `export type InstanceStatus = 'running' | 'completed' | 'stopped' | 'error' | 'incident' | 'aborted';`
- `listNonTerminal()` WHERE clause becomes `status IN ('running', 'stopped', 'incident')`.
- New table:

```sql
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  node_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
```

- Methods: `createIncident` (status `'open'`, returns rowid), `findOpenIncident(instanceId, nodeId)`, `listOpenIncidents()` (ordered by id), `getIncident(id)`, `resolveIncident(id, resolution)` (status `'resolved'`, `resolved_at = Date.now()`).

- [ ] **Step 5: Implement the ladder**

`packages/server/src/engine-host/failure.ts`:

```ts
import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { InstanceStore } from './store.js';
import type { DispatchDeps, EngineEnvironment, RunTaskFn } from './dispatch.js';
import { makeSingleAttemptRunTask } from './dispatch.js';
import { validateOutput } from '../runners/validate.js';
import type { Notifier } from '../notify/notifier.js';

type Contract = AgentTaskContract | CodeTaskContract;

export interface Hold {
  incidentId: number;
  contract: Contract;
  environment: EngineEnvironment;
  /** Releases the engine token with this output (skip / successful retry). */
  release: (output: Record<string, unknown>) => void;
  /** One fresh attempt against the runner. Throws on failure. */
  attempt: () => Promise<Record<string, unknown>>;
}

export interface LadderDeps extends DispatchDeps {
  store: InstanceStore;
  notifier?: Notifier;
  /** Registry shared with EngineHost, keyed `${instanceId}:${nodeId}`. */
  holds: Map<string, Hold>;
}

export function makeLadderRunTask(deps: LadderDeps): RunTaskFn {
  const single = makeSingleAttemptRunTask(deps);

  return (nodeId, contract, environment) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const key = `${deps.instanceId}:${nodeId}`;
      const attempt = () => single(nodeId, contract, environment);
      const hold = (incidentId: number) => {
        deps.holds.set(key, {
          incidentId,
          contract,
          environment,
          release: (output) => {
            deps.holds.delete(key);
            resolve(output);
          },
          attempt,
        });
      };

      void (async () => {
        // Restart with an open incident: re-hold, no runner call, no re-notify.
        const existing = deps.store.findOpenIncident(deps.instanceId, nodeId);
        if (existing) return hold(existing.id);

        let lastError: unknown;
        for (let n = 1; n <= contract.retries + 1; n++) {
          try {
            return resolve(await attempt());
          } catch (err) {
            lastError = err;
            deps.store.appendEvent(deps.instanceId, 'task.attempt-failed', nodeId, String(err));
          }
        }
        // Rung 2: modeled error boundary → let the engine route the token.
        if (deps.profile.errorBoundaryHosts.has(nodeId)) return reject(lastError as Error);
        // Rung 3: incident. Token pauses (promise stays pending).
        const incidentId = deps.store.createIncident(deps.instanceId, nodeId, String(lastError));
        deps.store.setStatus(deps.instanceId, 'incident');
        deps.store.appendEvent(deps.instanceId, 'incident.raised', nodeId, String(lastError));
        void deps.notifier?.notify(
          'Flow Fabric incident',
          `${deps.instanceId}: ${nodeId} failed after ${contract.retries + 1} attempts`,
        );
        hold(incidentId);
      })();
    });
}
```

- [ ] **Step 6: Wire into EngineHost**

`engine-host.ts`:

- `EngineHostOptions` gains `notifier?: Notifier`. Add fields `private holds = new Map<string, Hold>()` and `private aborting = new Set<string>()`.
- `engineComponents()` passes `runTask: makeLadderRunTask({ ...dispatchDeps, store: this.store, notifier: this.opts.notifier, holds: this.holds })` into `createDispatch` — the stub path (dry-run) goes through the same ladder, so incidents work in dry runs too.
- In `run()`: the `'stop'` outcome must not clobber a paused state — set `'stopped'` only when the current status is `'running'`; likewise set `'aborted'` when `this.aborting.has(id)` (then clear the flag). Completed/error branches unchanged.
- New methods:

```ts
async abort(instanceId: string): Promise<void> {
  const entry = this.running.get(instanceId);
  this.aborting.add(instanceId);
  this.store.appendEvent(instanceId, 'instance.aborted');
  if (entry) await entry.engine.stop();
  this.store.setStatus(instanceId, 'aborted');
}

async resolveIncident(
  incidentId: number,
  action: 'retry' | 'skip' | 'abort',
  output?: Record<string, unknown>,
): Promise<void> {
  const incident = this.store.getIncident(incidentId);
  if (!incident || incident.status !== 'open') throw new Error(`no open incident ${incidentId}`);
  const key = `${incident.instanceId}:${incident.nodeId}`;
  const hold = this.holds.get(key);
  if (!hold) throw new Error(`incident ${incidentId} has no held task in this host`);

  if (action === 'abort') {
    this.store.resolveIncident(incidentId, 'abort');
    this.holds.delete(key);
    await this.abort(incident.instanceId);
    return;
  }
  if (action === 'skip') {
    validateOutput(hold.contract.outputSchema, output ?? {}); // throws → incident stays open
    this.store.resolveIncident(incidentId, 'skip');
    this.store.setStatus(incident.instanceId, 'running');
    Object.assign(hold.environment.variables, output);
    hold.release(output ?? {});
    return;
  }
  // retry: one fresh attempt; failure keeps the incident open and held.
  try {
    const result = await hold.attempt();
    this.store.resolveIncident(incidentId, 'retry');
    this.store.setStatus(incident.instanceId, 'running');
    hold.release(result);
  } catch (err) {
    this.store.appendEvent(incident.instanceId, 'task.attempt-failed', incident.nodeId, String(err));
    throw err;
  }
}
```

Note the ordering trap in `run()`: dispatch's Service/script `execute` merges output into `environment.variables` after `release` — for the skip path the merge into `hold.environment.variables` above is what actually lands in state; keep both merges idempotent (same object, `Object.assign`).

Append to `packages/server/src/index.ts`:

```ts
export { makeLadderRunTask } from './engine-host/failure.js';
export type { LadderDeps, Hold } from './engine-host/failure.js';
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @flowfabric/server test failure-ladder`
Expected: all six PASS. Then `pnpm --filter @flowfabric/server test` — dispatch/user-task/M1 suites must stay green (the ladder replaced the single-attempt seam for every instance).

- [ ] **Step 8: Sweep + commit**

Run: `pnpm build && pnpm test`

```bash
git add packages/server
git commit -m "feat(server): failure ladder with retries, boundary routing, and incidents"
```

---

### Task 10: task_executions recording + timeline query

**Files:**
- Modify: `packages/server/src/engine-host/store.ts` (task_executions table)
- Modify: `packages/server/src/engine-host/dispatch.ts` (record in the single-attempt path; real attempt numbers)
- Modify: `packages/server/src/inbox/inbox.ts` (record user tasks)
- Test: `packages/server/test/timeline.test.ts`

**Interfaces:**
- Consumes: dispatch + ladder (Tasks 5, 9), inbox (Task 8), `RunResult` meta fields (Task 4).
- Produces (used by Task 11):
  - `interface TaskExecutionRow { id: number; instanceId: string; nodeId: string; actor: 'agent' | 'code' | 'user'; attempt: number; resolvedInputs: string; output: string | null; error: string | null; status: 'running' | 'completed' | 'failed'; startedAt: number; endedAt: number | null; tokenUsage: string | null; costUsd: number | null; transcriptPath: string | null }`
  - Store methods: `startTaskExecution(instanceId, nodeId, actor, attempt, inputs): number`, `finishTaskExecution(id, result: { status: 'completed' | 'failed'; output?: unknown; error?: string; tokenUsage?: unknown; costUsd?: number; transcriptPath?: string })`, `listTaskExecutions(instanceId): TaskExecutionRow[]` (ordered by id).
  - `DispatchDeps` gains optional `store?: InstanceStore` — recording is on whenever it is set (EngineHost always sets it).

**Also fixed here:** Task 5's `makeSingleAttemptRunTask` hard-codes `attempt: 1`. Replace with a per-`instanceId:nodeId` attempt counter inside the dispatch closure so ladder retries and incident-retries get real attempt numbers in both `RunContext` and the recorded rows.

- [ ] **Step 1: Write the failing test**

`packages/server/test/timeline.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import type { RunResult, TaskRunner } from '../src/runners/types.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const failure = readFileSync(new URL('./fixtures/failure.bpmn', import.meta.url), 'utf8');

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('task_executions timeline (FR-14)', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('records every step of a dry run with inputs, outputs, timing, actor', async () => {
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    let inbox!: Inbox;
    const host = new EngineHost(store, {
      dataDir: tmp(),
      onUserTaskWait: (info) => inbox.handleWait(info),
    });
    inbox = new Inbox(store, host, { notify: async () => {} });

    const running = host.start({
      id: 't1', name: 'contracts', source: contracts, workspace: tmp(),
      dryRun: true, variables: { deadline: '2026-08-01' },
      stubOverrides: { codeTask: { count: 5 } },
    });
    for (let i = 0; i < 100 && inbox.listPending().length === 0; i++) await sleep(100);
    await inbox.submit(inbox.listPending()[0].id, { approved: true });
    await running;

    const rows = store.listTaskExecutions('t1');
    expect(rows.map((r) => [r.nodeId, r.actor, r.status])).toEqual([
      ['agentTask', 'agent', 'completed'],
      ['codeTask', 'code', 'completed'],
      ['userTask', 'user', 'completed'],
    ]);
    expect(JSON.parse(rows[0].resolvedInputs)).toEqual({ deadline: '2026-08-01' });
    expect(JSON.parse(rows[1].output!)).toEqual({ count: 5 });
    expect(JSON.parse(rows[2].output!)).toEqual({ approved: true });
    for (const row of rows) {
      expect(row.attempt).toBe(1);
      expect(row.endedAt).toBeGreaterThanOrEqual(row.startedAt);
    }
  });

  it('records one row per attempt, failed attempts with the error', async () => {
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    let calls = 0;
    const flaky: TaskRunner = {
      async run(): Promise<RunResult> {
        calls += 1;
        if (calls === 1) throw new Error('induced');
        return { output: { ok: true }, costUsd: 0.02, tokenUsage: { output_tokens: 9 } };
      },
    };
    const host = new EngineHost(store, { dataDir: tmp(), runners: { agent: flaky, code: flaky } });
    await host.start({ id: 't2', name: 'failure', source: failure, workspace: tmp() });

    const rows = store.listTaskExecutions('t2');
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'failed'],
      [2, 'completed'],
    ]);
    expect(rows[0].error).toContain('induced');
    expect(rows[1].costUsd).toBe(0.02);
    expect(JSON.parse(rows[1].tokenUsage!)).toEqual({ output_tokens: 9 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test timeline`
Expected: FAIL — `listTaskExecutions` missing.

- [ ] **Step 3: Implement**

`store.ts` schema addition:

```sql
CREATE TABLE IF NOT EXISTS task_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  node_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  resolved_inputs TEXT NOT NULL,
  output TEXT,
  error TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  token_usage TEXT,
  cost_usd REAL,
  transcript_path TEXT
);
```

Store methods follow the existing prepared-statement style; `finishTaskExecution` JSON-stringifies `output`/`tokenUsage` and sets `ended_at = Date.now()`.

`dispatch.ts` — inside `makeSingleAttemptRunTask`:

```ts
const attempts = new Map<string, number>();
return async (nodeId, contract, environment) => {
  const attempt = (attempts.get(nodeId) ?? 0) + 1;
  attempts.set(nodeId, attempt);
  const inputs = resolveInputs(contract, environment);
  const recId = deps.store?.startTaskExecution(deps.instanceId, nodeId, contract.kind, attempt, inputs);
  try {
    // ...existing timeout + runner.run (pass the real `attempt` in RunContext)...
    validateOutput(contract.outputSchema, result.output);
    deps.store?.finishTaskExecution(recId!, {
      status: 'completed',
      output: result.output,
      tokenUsage: result.tokenUsage,
      costUsd: result.costUsd,
      transcriptPath: result.transcriptPath,
    });
    return result.output;
  } catch (err) {
    deps.store?.finishTaskExecution(recId!, { status: 'failed', error: String(err) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
```

`engine-host.ts`: include `store: this.store` in the dispatch/ladder deps.

`inbox.ts`: `handleWait` also calls `startTaskExecution(instanceId, nodeId, 'user', 1, {})` (guarded by the same pending-row dedupe); stash the returned id on the user_tasks row — add a `task_execution_id INTEGER` column to `user_tasks` — and `submit` calls `finishTaskExecution(task.taskExecutionId, { status: 'completed', output: vars })` after signaling.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowfabric/server test`
Expected: timeline PASS and every earlier suite green (failure-ladder assertions on `runner.calls` are unaffected; dispatch merge behavior unchanged).

- [ ] **Step 5: Sweep + commit**

```bash
pnpm build && pnpm test
git add packages/server
git commit -m "feat(server): record task executions per attempt for the timeline (FR-14)"
```

---

### Task 11: Minimal REST API + SSE

**Files:**
- Create: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/engine-host/store.ts` (event fan-out, `listInstances`, workspace lock index)
- Modify: `packages/server/package.json` (add `fastify`)
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/api.test.ts`

**Interfaces:**
- Consumes: everything (Tasks 5–10).
- Produces (consumed by M4's SPA and M3's dry-run tooling):
  - `function buildApi(deps: { store: InstanceStore; host: EngineHost; inbox: Inbox }): FastifyInstance`
  - Store: `listInstances(): InstanceRow[]`; `onEvent(listener: (e: EventRow & { instanceId: string }) => void): () => void` — `appendEvent` fans out to subscribers (the seed of the design's `events` module; SSE hangs off it).
  - Routes (design §8, M2 subset): `GET /api/healthz`, `POST /api/instances`, `GET /api/instances`, `GET /api/instances/:id` (row + timeline + events), `POST /api/instances/:id/abort`, `GET /api/inbox`, `POST /api/user-tasks/:id/submit`, `POST /api/incidents/:id/resolve`, `GET /api/events?instanceId=` (SSE).
  - FR-10 workspace lock: partial unique index — `CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_workspace ON instances(workspace_path) WHERE status IN ('running','incident') AND workspace_path != ''` — surfaces as HTTP 409 on create.

- [ ] **Step 1: Write the failing test**

`packages/server/test/api.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { buildApi } from '../src/api/server.js';
import type { RunResult, TaskRunner } from '../src/runners/types.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const failure = readFileSync(new URL('./fixtures/failure.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

const alwaysFail: TaskRunner = {
  async run(): Promise<RunResult> {
    throw new Error('induced');
  },
};

function build(runner?: TaskRunner) {
  const store = new InstanceStore(path.join(tmp(), 'ff.db'));
  let inbox!: Inbox;
  const host = new EngineHost(store, {
    dataDir: tmp(),
    onUserTaskWait: (info) => inbox.handleWait(info),
    ...(runner ? { runners: { agent: runner, code: runner } } : {}),
  });
  inbox = new Inbox(store, host, { notify: async () => {} });
  const app = buildApi({ store, host, inbox });
  return { store, host, inbox, app };
}

async function post(app: any, url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, payload });
}

async function until<T>(fn: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('condition not reached');
}

describe('REST API', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('drives a dry run end-to-end over HTTP', async () => {
    const { store, app } = build();
    stores.push(store);

    const created = await post(app, '/api/instances', {
      name: 'contracts', source: contracts, workspacePath: tmp(),
      dryRun: true, inputs: { deadline: '2026-08-01' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    // poll the inbox over HTTP (not the store) — this test exercises the API path
    let userTask: any;
    for (let i = 0; i < 100 && !userTask; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/inbox' });
      userTask = res.json().userTasks[0];
      if (!userTask) await sleep(100);
    }
    expect(userTask.nodeId).toBe('userTask');

    const submit = await post(app, `/api/user-tasks/${userTask.id}/submit`, { vars: { approved: true } });
    expect(submit.statusCode).toBe(204);

    await until(() => store.getInstance(id)?.status === 'completed');
    const detail = await app.inject({ method: 'GET', url: `/api/instances/${id}` });
    const body = detail.json();
    expect(body.instance.status).toBe('completed');
    expect(body.timeline).toHaveLength(3);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('rejects invalid form submissions with 400', async () => {
    const { store, app } = build();
    stores.push(store);
    await post(app, '/api/instances', { name: 'c', source: contracts, workspacePath: tmp(), dryRun: true });
    let userTask: any;
    for (let i = 0; i < 100 && !userTask; i++) {
      userTask = (await app.inject({ method: 'GET', url: '/api/inbox' })).json().userTasks[0];
      if (!userTask) await sleep(100);
    }
    const bad = await post(app, `/api/user-tasks/${userTask.id}/submit`, { vars: { approved: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });

  it('enforces one active instance per workspace with 409 (FR-10)', async () => {
    const { store, app } = build();
    stores.push(store);
    const ws = tmp();
    const first = await post(app, '/api/instances', { name: 'a', source: contracts, workspacePath: ws, dryRun: true });
    expect(first.statusCode).toBe(201);
    const second = await post(app, '/api/instances', { name: 'b', source: contracts, workspacePath: ws, dryRun: true });
    expect(second.statusCode).toBe(409);
  });

  it('exposes incidents in the inbox and resolves them over HTTP', async () => {
    const { store, app } = build(alwaysFail);
    stores.push(store);
    await post(app, '/api/instances', { name: 'f', source: failure, workspacePath: tmp() });
    let incident: any;
    for (let i = 0; i < 100 && !incident; i++) {
      incident = (await app.inject({ method: 'GET', url: '/api/inbox' })).json().incidents[0];
      if (!incident) await sleep(100);
    }
    const res = await post(app, `/api/incidents/${incident.id}/resolve`, { action: 'skip', output: { ok: true } });
    expect(res.statusCode).toBe(204);
    await until(() => store.listOpenIncidents().length === 0);
  });

  it('streams events over SSE', async () => {
    const { store, app } = build();
    stores.push(store);
    await app.listen({ port: 0 });
    try {
      const port = (app.server.address() as { port: number }).port;
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      await post(app, '/api/instances', { name: 'sse', source: contracts, workspacePath: tmp(), dryRun: true });
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain('data:');
      controller.abort();
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test api`
Expected: FAIL — `buildApi` missing.

- [ ] **Step 3: Implement store fan-out + lock index**

`store.ts`:

- Add the partial unique index to the schema block (after the tables): `CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_workspace ON instances(workspace_path) WHERE status IN ('running','incident') AND workspace_path != '';` — M1 tests use `workspace_path = ''` and stay exempt.
- Add `listInstances(): InstanceRow[]` (same SELECT as `getInstance`, no WHERE, ordered by created_at).
- Add a private `EventEmitter`; `appendEvent` emits `'event'` with `{ instanceId, type, elementId, detail, ts, seq: Number(result.lastInsertRowid) }`; `onEvent(listener)` subscribes and returns an unsubscribe function.

- [ ] **Step 4: Implement `buildApi`**

Add `"fastify": "^5"` to server dependencies, `pnpm install`.

`packages/server/src/api/server.ts`:

```ts
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { InstanceStore } from '../engine-host/store.js';
import type { EngineHost } from '../engine-host/engine-host.js';
import type { Inbox } from '../inbox/inbox.js';
import { OutputValidationError } from '../runners/validate.js';

export interface ApiDeps {
  store: InstanceStore;
  host: EngineHost;
  inbox: Inbox;
}

export function buildApi({ store, host, inbox }: ApiDeps): FastifyInstance {
  const app = Fastify();

  app.get('/api/healthz', async () => ({ ok: true }));

  app.post('/api/instances', async (req, reply) => {
    const body = req.body as {
      name: string; source: string; workspacePath: string;
      dryRun?: boolean; inputs?: Record<string, unknown>;
      stubOverrides?: Record<string, Record<string, unknown>>;
    };
    const id = randomUUID();
    try {
      // start() inserts the row synchronously, then runs to completion in the
      // background; the API must not block on the whole instance.
      const completion = host.start({
        id, name: body.name, source: body.source,
        workspace: body.workspacePath, variables: body.inputs,
        dryRun: body.dryRun, stubOverrides: body.stubOverrides,
      });
      completion.catch((err) => app.log.error({ err, id }, 'instance failed'));
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed')) {
        return reply.code(409).send({ error: `workspace ${body.workspacePath} already has an active instance` });
      }
      throw err;
    }
    return reply.code(201).send({ id });
  });

  app.get('/api/instances', async () => ({ instances: store.listInstances() }));

  app.get('/api/instances/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const instance = store.getInstance(id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    return {
      instance,
      timeline: store.listTaskExecutions(id),
      events: store.listEvents(id),
    };
  });

  app.post('/api/instances/:id/abort', async (req, reply) => {
    await host.abort((req.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get('/api/inbox', async () => ({
    userTasks: inbox.listPending(),
    incidents: store.listOpenIncidents(),
  }));

  app.post('/api/user-tasks/:id/submit', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { vars } = req.body as { vars: Record<string, unknown> };
    try {
      await inbox.submit(id, vars);
      return reply.code(204).send();
    } catch (err) {
      const code = err instanceof OutputValidationError ? 400 : 404;
      return reply.code(code).send({ error: String(err) });
    }
  });

  app.post('/api/incidents/:id/resolve', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { action, output } = req.body as {
      action: 'retry' | 'skip' | 'abort';
      output?: Record<string, unknown>;
    };
    try {
      await host.resolveIncident(id, action, output);
      return reply.code(204).send();
    } catch (err) {
      const code = err instanceof OutputValidationError ? 400 : 409;
      return reply.code(code).send({ error: String(err) });
    }
  });

  app.get('/api/events', async (req, reply) => {
    const { instanceId } = req.query as { instanceId?: string };
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = store.onEvent((event) => {
      if (instanceId && event.instanceId !== instanceId) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.raw.on('close', () => {
      unsubscribe();
      reply.raw.end();
    });
    return reply; // keep the connection open
  });

  return app;
}
```

Append to `packages/server/src/index.ts`:

```ts
export { buildApi } from './api/server.js';
export type { ApiDeps } from './api/server.js';
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @flowfabric/server test api`
Expected: all five PASS. Where the 409 surfaces depends on better-sqlite3 raising synchronously inside `start()` — if it lands on the `completion` promise instead of the try/catch, move the `createInstance` call out of `start()`'s async body (make it a sync prelude in `start`) rather than sniffing error strings deeper.

- [ ] **Step 6: Manual SSE check (impl M2.7 verify)**

In one terminal run a small script that builds the api + listens on 4750 and starts a dry-run instance of `contracts.bpmn`; in another:

Run: `curl -N 'http://127.0.0.1:4750/api/events'`
Expected: `data: {...}` lines streaming as activities fire.

- [ ] **Step 7: Sweep + commit**

```bash
pnpm build && pnpm test
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): REST API and SSE event stream for instances, inbox, incidents"
```

---

## M2 exit checklist (impl spec verification gates)

- [ ] M2.1 — moddle parses/serializes a profile-conformant BPMN with contracts intact (Task 1 round-trip test).
- [ ] M2.2 — dry-run instance completes end-to-end with stub output + per-node overrides (Task 5 e2e).
- [ ] M2.3 — code runner contract tests: success, bad JSON, non-zero exit, timeout (Task 6).
- [ ] M2.4 — agent runner mock-transport tests + one recorded live smoke run (Task 7 Step 5).
- [ ] M2.5 — user task rows + submit resumes token; notifier fired (Task 8, incl. manual notification check).
- [ ] M2.6 — ladder tests for each rung; skip validates output; incident survives restart (Task 9).
- [ ] M2.7 — API integration tests green; SSE observed via curl during a dry run (Task 11).
- [ ] M2.8 — timeline query returns complete step data for a dry run (Task 10).
- [ ] `pnpm build && pnpm test` green across the workspace; M1 suites untouched and passing.

## Deferred (deliberately not in M2)

- `instances.status = 'waiting'` (design data model): the M4 UI can derive waiting from pending user tasks + armed timers; introduce the status when the UI needs it.
- Terminate-end-event → `'terminated'` status: no M2 fixture uses terminate; M3's refined rfp-daily does — add it there.
- The standalone daemon entrypoint (bin script wiring store + host + inbox + api + `resumeAll()` on boot): M2 tests compose these directly; the daemon belongs to M3's dry-run of the real workflow.





