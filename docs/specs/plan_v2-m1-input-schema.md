# V2-M1 — Input Contract (`inputSchema`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `instanceInputs` name/type list with a process-level `inputSchema` (JSON Schema) across shared profile, reader, linter, patch ops, start-time validation, and the web start form ([impl_v2_factory-intake.md](impl_v2_factory-intake.md) V2-M1, [design_v2_factory-intake.md](design_v2_factory-intake.md) §8).

**Architecture:** The moddle descriptor swaps `flowfabric:InstanceInputs` for a body-text `flowfabric:InputSchema` element (the `formSchema` pattern). Everything that consumed the flat list — `readProfile`, linter FF004, patch op, grill catalog — reads the schema instead. `POST /api/instances` Ajv-validates `inputs` against it; the versions endpoint exposes it so the web start form can render `SchemaForm`.

**Tech Stack:** TypeScript strict / Node 22 / pnpm workspaces, `bpmn-moddle`, Ajv, Fastify (inject tests), React 19 + `@testing-library/react`, vitest.

## Global Constraints

- ESM throughout. Server package uses NodeNext resolution: **local imports need the `.js` extension** (`./read.js`). Web package uses Bundler resolution: extensionless imports.
- TDD: write the failing test, watch it fail, implement, watch it pass, commit. Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Test databases in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))` — never in the repo.
- Do not install `@types/bpmn-engine` (doesn't exist; the package ships its own types).
- Patch ops must never touch the DI section (design v1 §7.3); the byte-identical round-trip test enforces this.
- Full-suite check is `pnpm build && pnpm test`. Real-timer tests (loop/resume/scheduler) can flake under parallel `pnpm -r test` — before concluding a failure, re-run isolated: `pnpm --filter @flowfabric/server test`.
- Task-level `inputs` on agent/code contracts stay the flat `InputDecl[]` — only the **process-level** declaration changes.

Task ↔ milestone map: Task 1 = impl V2-M1.1–3, Task 2 = V2-M1.4, Task 3 = V2-M1.5, Tasks 4–5 = V2-M1.6.

---

### Task 1: The profile swap — descriptor, reader, linter FF004, fixture

One atomic commit: once the descriptor drops `InstanceInputs`, the reader, linter, fixture, and inline test XMLs must move together or the suite goes red between commits.

**Files:**
- Modify: `packages/shared/src/profile/descriptor.ts`
- Modify: `packages/shared/test/profile.test.ts:52-76`
- Modify: `packages/server/src/profile/read.ts`
- Modify: `packages/server/test/profile-read.test.ts:42-60`
- Modify: `packages/server/src/linter/lint.ts:281-282, 325-331`
- Modify: `packages/server/test/linter.test.ts:169`
- Modify: `packages/server/test/fixtures/daily-loop-refined.bpmn:8-10`

**Interfaces:**
- Consumes: nothing new.
- Produces: moddle type `flowfabric:InputSchema` (body-text element, process-level); `ProcessProfile.inputSchema?: Record<string, unknown>` replacing `instanceInputs: InputDecl[]`. Later tasks (3, 4) read `profile.inputSchema`.

- [ ] **Step 1: Rewrite the shared round-trip test to `inputSchema`**

In `packages/shared/test/profile.test.ts`, replace the whole `describe('instanceInputs process extension', ...)` block (lines 52–76) with:

```ts
describe('inputSchema process extension', () => {
  const procXml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="isDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="p" isExecutable="true">
    <extensionElements>
      <flowfabric:inputSchema>{"type":"object","required":["submissionDeadline"],"properties":{"submissionDeadline":{"type":"string"}}}</flowfabric:inputSchema>
    </extensionElements>
    <startEvent id="start" />
  </process>
</definitions>`;

  it('parses and round-trips inputSchema', async () => {
    const m = moddle();
    const parsed = await m.fromXML(procXml);
    const proc = parsed.rootElement.rootElements.find((e: any) => e.$type === 'bpmn:Process');
    const is = extensionOf(proc, 'flowfabric:InputSchema');
    expect(JSON.parse(is.text).required).toEqual(['submissionDeadline']);
    const { xml: reXml } = await m.toXML(parsed.rootElement, { format: true });
    expect(reXml).toContain('flowfabric:inputSchema');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @flowfabric/shared test`
Expected: FAIL — `extensionOf(proc, 'flowfabric:InputSchema')` finds nothing (type not in descriptor).

- [ ] **Step 3: Swap the descriptor type**

In `packages/shared/src/profile/descriptor.ts`, delete the `InstanceInputs` entry (lines 52–56) and add `body('InputSchema')` to the body-element list, so the tail of `types` reads:

```ts
    body('Prompt'),
    body('Tools'),
    body('Boundaries'),
    body('OutputSchema'),
    body('FormSchema'),
    body('InputSchema'),
```

Keep the `Input` type — task contracts still use it.

- [ ] **Step 4: Shared tests green**

Run: `pnpm --filter @flowfabric/shared test`
Expected: PASS.

- [ ] **Step 5: Rewrite the profile-read test**

In `packages/server/test/profile-read.test.ts`, the test at lines 42–60 (`reads instanceInputs and terminateEnds`) becomes `reads inputSchema and terminateEnds`. Replace the fixture's extension block

```xml
<flowfabric:instanceInputs>
  <flowfabric:input name="deadline" type="string" />
</flowfabric:instanceInputs>
```

with

```xml
<flowfabric:inputSchema>{"type":"object","properties":{"deadline":{"type":"string"}}}</flowfabric:inputSchema>
```

and the assertion `expect(profile.instanceInputs).toEqual([{ name: 'deadline', type: 'string' }]);` with:

```ts
expect(profile.inputSchema).toEqual({ type: 'object', properties: { deadline: { type: 'string' } } });
```

Also add one absence case inside the same describe (any existing minimal fixture without the extension works):

```ts
it('leaves inputSchema undefined when the process declares none', async () => {
  const profile = await readProfile(minimalXml); // reuse the file's smallest fixture
  expect(profile.inputSchema).toBeUndefined();
});
```

- [ ] **Step 6: Implement the reader**

In `packages/server/src/profile/read.ts`:

```ts
export interface ProcessProfile {
  contracts: Map<string, TaskContract>;
  errorBoundaryHosts: Set<string>;
  inputSchema?: Record<string, unknown>;
  terminateEnds: Set<string>;
}
```

In `readProfile`, replace the `instanceInputs` accumulator and its `flowfabric:InstanceInputs` lookup with:

```ts
let inputSchema: Record<string, unknown> | undefined;
// inside the rootElements loop, replacing the `ii` block:
const is = ext(root, 'flowfabric:InputSchema');
if (is?.text) inputSchema = JSON.parse(is.text) as Record<string, unknown>;
```

Return `{ contracts, errorBoundaryHosts, ...(inputSchema ? { inputSchema } : {}), terminateEnds }`. `InputDecl` stays imported (task contracts use `inputs()`).

- [ ] **Step 7: Update linter FF004 test + fixture**

`packages/server/test/linter.test.ts:169` — replace the inline `<flowfabric:instanceInputs>…</flowfabric:instanceInputs>` block with:

```xml
<flowfabric:inputSchema>{"type":"object","properties":{"deadline":{"type":"string"}}}</flowfabric:inputSchema>
```

`packages/server/test/fixtures/daily-loop-refined.bpmn` lines 8–10 — replace

```xml
<flowfabric:instanceInputs>
  <flowfabric:input name="submissionDeadline" type="string" />
</flowfabric:instanceInputs>
```

with

```xml
<flowfabric:inputSchema>{"type":"object","required":["submissionDeadline"],"properties":{"submissionDeadline":{"type":"string"}}}</flowfabric:inputSchema>
```

- [ ] **Step 8: Run server tests to see FF004 fail**

Run: `pnpm --filter @flowfabric/server test linter`
Expected: FAIL — FF004 still looks up `flowfabric:InstanceInputs`, so `deadline` is flagged undeclared.

- [ ] **Step 9: Implement FF004 against the schema**

In `packages/server/src/linter/lint.ts` (`ruleUndeclaredVariables`), replace

```ts
const instanceInputs = new Set<string>(
  (ext(proc, 'flowfabric:InstanceInputs')?.inputs ?? []).map((i: any) => i.name),
);
```

with

```ts
const declaredInputs = new Set<string>(schemaProps(ext(proc, 'flowfabric:InputSchema')?.text));
```

(`schemaProps` is already defined in this function and tolerates missing/malformed text.) Rename the consumer check `instanceInputs.has(variable)` → `declaredInputs.has(variable)`, and update message + suggestion:

```ts
`variable "${variable}" used at ${q(name, nodeId)} is not produced upstream and not declared ` +
  'in the process inputSchema',
// suggestion:
`Add "${variable}" to the process inputSchema, or add an upstream task that produces it ` +
  `before ${q(name, nodeId)}.`,
```

- [ ] **Step 10: Full suite green**

Run: `pnpm build && pnpm test`
Expected: PASS (grill-api and dry-run-e2e consume the converted fixture; they already send `inputs: { submissionDeadline: … }`). If real-timer tests flake, re-run `pnpm --filter @flowfabric/server test` isolated.

- [ ] **Step 11: Commit**

```bash
git add packages/shared packages/server
git commit -m "feat: process-level inputSchema replaces instanceInputs (profile, reader, FF004)"
```

---

### Task 2: Patch op `setInputSchema` + grill catalog

**Files:**
- Modify: `packages/server/src/patch-ops/apply.ts:12, 236-251`
- Modify: `packages/server/src/grill/session.ts:37`
- Modify: `packages/server/test/patch-ops.test.ts:64-69, 153`
- Modify: `packages/server/test/grill.test.ts:56`

**Interfaces:**
- Consumes: `flowfabric:InputSchema` descriptor type (Task 1).
- Produces: `PatchOp` union member `{ op: 'setInputSchema'; schema: Record<string, unknown> }` — replaces `{ op: 'declareInstanceInput'; name; type }`. Task 5's migration script calls `applyPatchOps(xml, [{ op: 'setInputSchema', schema }])`.

- [ ] **Step 1: Rewrite the patch-op tests**

`packages/server/test/patch-ops.test.ts` — replace the `declareInstanceInput` test (lines 64–69) with:

```ts
it('setInputSchema sets the process-level input schema readable by readProfile', async () => {
  const schema = {
    type: 'object', required: ['submissionDeadline'],
    properties: { submissionDeadline: { type: 'string' } },
  };
  const { xml } = await applyPatchOps(base, [{ op: 'setInputSchema', schema }]);
  const profile = await readProfile(xml);
  expect(profile.inputSchema).toEqual(schema);
});

it('setInputSchema replaces a previous schema instead of stacking', async () => {
  const first = { type: 'object', properties: { a: { type: 'string' } } };
  const second = { type: 'object', properties: { b: { type: 'number' } } };
  const step1 = await applyPatchOps(base, [{ op: 'setInputSchema', schema: first }]);
  const { xml } = await applyPatchOps(step1.xml, [{ op: 'setInputSchema', schema: second }]);
  expect((await readProfile(xml)).inputSchema).toEqual(second);
});
```

(`base` = whatever source XML the deleted test used.) In the DI byte-identical test at line 153, replace the op `{ op: 'declareInstanceInput', name: 'deadline', type: 'string' }` with `{ op: 'setInputSchema', schema: { type: 'object', properties: { deadline: { type: 'string' } } } }`.

`packages/server/test/grill.test.ts:56` — replace `[{ op: 'declareInstanceInput', name: 'deadline', type: 'string' }]` with `[{ op: 'setInputSchema', schema: { type: 'object', properties: { deadline: { type: 'string' } } } }]`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @flowfabric/server test patch-ops`
Expected: FAIL — TS rejects the unknown op variant (compile error) or `unknown op` at runtime.

- [ ] **Step 3: Implement the op**

`packages/server/src/patch-ops/apply.ts` — in the `PatchOp` union, replace `| { op: 'declareInstanceInput'; name: string; type: string }` with:

```ts
| { op: 'setInputSchema'; schema: Record<string, unknown> }
```

Replace the whole `case 'declareInstanceInput'` block with:

```ts
case 'setInputSchema': {
  const [proc] = processes(definitions);
  if (!proc) throw new PatchOpError('no process in definitions');
  const ext = ensureExtensionElements(moddle, proc);
  ext.values = ext.values.filter((v: any) => v.$type !== 'flowfabric:InputSchema');
  const schemaEl = bodyEl(moddle, 'flowfabric:InputSchema', JSON.stringify(op.schema));
  schemaEl.$parent = ext;
  ext.values.push(schemaEl);
  const props = Object.keys((op.schema as any).properties ?? {});
  return { op: op.op, target: proc.id, summary: `process inputSchema set (${props.join(', ') || 'no properties'})` };
}
```

- [ ] **Step 4: Update the grill op catalog**

`packages/server/src/grill/session.ts:37` — replace the `declareInstanceInput` line in `OP_CATALOG` with:

```
- {"op":"setInputSchema","schema":{JSON Schema}} declares the process-level instance inputs
  (whole-schema replace; use required/properties to express which inputs a run must supply).
```

- [ ] **Step 5: Tests green**

Run: `pnpm --filter @flowfabric/server test patch-ops && pnpm --filter @flowfabric/server test grill`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat: setInputSchema patch op replaces declareInstanceInput; grill catalog updated"
```

---

### Task 3: Start-time input validation

**Files:**
- Modify: `packages/server/src/runners/validate.ts`
- Modify: `packages/server/src/api/server.ts:73-77` (after the `source` resolution, before `host.start`)
- Test: `packages/server/test/api.test.ts`

**Interfaces:**
- Consumes: `ProcessProfile.inputSchema` (Task 1).
- Produces: `validateInputs(schema: Record<string, unknown>, value: unknown): void` throwing `InputValidationError` (exported from `runners/validate.ts`); `POST /api/instances` → 400 `{ error }` on schema violation. V2-M2's enqueue gate will reuse `validateInputs`.

- [ ] **Step 1: Write the failing API tests**

Append to the `describe('REST API', ...)` block in `packages/server/test/api.test.ts` (the file already defines `build`, `post`, `tmp`; add the fixture read next to the existing ones at the top):

```ts
const refined = readFileSync(new URL('./fixtures/daily-loop-refined.bpmn', import.meta.url), 'utf8');
```

```ts
it('rejects instance start when inputs fail the inputSchema (400)', async () => {
  const { app } = build();
  const res = await post(app, '/api/instances', {
    name: 'loop', source: refined, workspacePath: tmp(), dryRun: true, inputs: {},
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/submissionDeadline/);
});

it('starts when inputs satisfy the inputSchema', async () => {
  const { app } = build();
  const res = await post(app, '/api/instances', {
    name: 'loop', source: refined, workspacePath: tmp(), dryRun: true,
    inputs: { submissionDeadline: '2026-08-01' },
  });
  expect(res.statusCode).toBe(201);
});
```

- [ ] **Step 2: Run to see the first one fail**

Run: `pnpm --filter @flowfabric/server test api.test`
Expected: FAIL — empty `inputs` currently starts fine (201, expected 400).

- [ ] **Step 3: Implement `validateInputs`**

Append to `packages/server/src/runners/validate.ts`:

```ts
export class InputValidationError extends Error {}

export function validateInputs(schema: Record<string, unknown>, value: unknown): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new InputValidationError(ajv.errorsText(validate.errors));
  }
}
```

- [ ] **Step 4: Gate the start route**

In `packages/server/src/api/server.ts`, after the `if (!source)` guard and workspace-exists check, before `host.start`:

```ts
const profile = await readProfile(source);
if (profile.inputSchema) {
  try {
    validateInputs(profile.inputSchema, body.inputs ?? {});
  } catch (err) {
    if (err instanceof InputValidationError) {
      return reply.code(400).send({ error: `inputs do not match the workflow inputSchema: ${err.message}` });
    }
    throw err;
  }
}
```

Imports (NodeNext, `.js` extensions): `import { readProfile } from '../profile/read.js';` and `import { validateInputs, InputValidationError } from '../runners/validate.js';`.

- [ ] **Step 5: Tests green, full suite**

Run: `pnpm --filter @flowfabric/server test api.test`, then `pnpm build && pnpm test`
Expected: PASS. (dry-run-e2e and grill-api already send valid `submissionDeadline` inputs.)

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat: instance start validates inputs against the process inputSchema (400 on violation)"
```

---

### Task 4: Expose `inputSchema` on the versions endpoint; web start form renders SchemaForm

**Files:**
- Modify: `packages/server/src/api/server.ts:209-215` (`GET /api/definitions/:id/versions/:v`)
- Modify: `packages/web/src/api/client.ts:54-57` (`getVersion` return type)
- Modify: `packages/web/src/components/SchemaForm.tsx` (optional `submitLabel` prop)
- Modify: `packages/web/src/pages/DefinitionsPage.tsx:119-171` (`StartForm`; add named export)
- Test: `packages/web/test/start-form.test.tsx` (new)

**Interfaces:**
- Consumes: `ProcessProfile.inputSchema` (Task 1).
- Produces: `GET /api/definitions/:id/versions/:v` response gains optional `inputSchema?: Record<string, unknown>`; `SchemaForm` accepts `submitLabel?: string` (default `'Submit'`); `StartForm` becomes a named export of `DefinitionsPage.tsx`. V2-M5's Queue page enqueue form reuses both.

- [ ] **Step 1: Write the failing web test**

Create `packages/web/test/start-form.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StartForm } from '../src/pages/DefinitionsPage';

afterEach(() => vi.restoreAllMocks());

const version = {
  definitionId: 'def-1', versionNo: 3, xml: '<x/>', lintReport: null, deployable: true,
  inputSchema: {
    type: 'object', required: ['submissionDeadline'],
    properties: { submissionDeadline: { type: 'string' } },
  },
};

describe('StartForm', () => {
  it('renders SchemaForm fields from the version inputSchema and sends them as inputs', async () => {
    const starts: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/definitions/def-1/versions/3') {
        return new Response(JSON.stringify(version), { headers: { 'content-type': 'application/json' } });
      }
      starts.push([url, init]);
      return new Response(JSON.stringify({ id: 'inst-1' }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    }));
    render(<StartForm defId="def-1" version={3} onCancel={() => {}} onError={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('submissionDeadline')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/tmp/ws' } });
    fireEvent.change(screen.getByLabelText('submissionDeadline'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByText('Start v3'));
    await waitFor(() => expect(starts.length).toBe(1));
    const body = JSON.parse(String(starts[0][1]?.body));
    expect(body.inputs).toEqual({ submissionDeadline: '2026-08-01' });
    expect(starts[0][0]).toBe('/api/instances');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @flowfabric/web test start-form`
Expected: FAIL — `StartForm` is not exported (and renders no schema fields).

- [ ] **Step 3: Server: include `inputSchema` in the version response**

In `packages/server/src/api/server.ts`, `GET /api/definitions/:id/versions/:v` — replace `return version;` with:

```ts
let inputSchema: Record<string, unknown> | undefined;
try {
  inputSchema = (await readProfile(version.xml)).inputSchema;
} catch {
  // raw uploads may not parse as a profile yet — the version is still viewable
}
return { ...version, ...(inputSchema ? { inputSchema } : {}) };
```

Add a server-side assertion to `packages/server/test/api-reads.test.ts` (or `definitions.test.ts` if the versions endpoint is covered there — put it beside the existing `GET versions/:v` test): upload the `daily-loop-refined.bpmn` fixture, `GET /api/definitions/:id/versions/1`, expect `json().inputSchema.required` to equal `['submissionDeadline']`.

- [ ] **Step 4: Web client + SchemaForm prop**

`packages/web/src/api/client.ts` — extend the `getVersion` inline return type with `inputSchema?: Record<string, unknown>`.

`packages/web/src/components/SchemaForm.tsx` — add the optional label:

```tsx
export function SchemaForm({ schema, onSubmit, submitLabel = 'Submit' }: {
  schema: Schema;
  onSubmit: (vars: Record<string, unknown>) => void;
  submitLabel?: string;
}) {
```

and render `<button onClick={submit}>{submitLabel}</button>` at the bottom (was hardcoded `Submit`).

- [ ] **Step 5: Rewire StartForm**

In `packages/web/src/pages/DefinitionsPage.tsx`: add `useEffect` to the react import and `import { SchemaForm } from '../components/SchemaForm';`. Change `function StartForm` to `export function StartForm` and replace its body:

```tsx
export function StartForm({ defId, version, onCancel, onError }: StartFormProps) {
  const [workspacePath, setWorkspacePath] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [inputSchema, setInputSchema] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    api.getVersion(defId, version)
      .then((v) => setInputSchema(v.inputSchema ?? null))
      .catch(() => setInputSchema(null)); // schema-less start still works
  }, [defId, version]);

  async function start(inputs?: Record<string, unknown>) {
    if (!workspacePath.trim() || busy) return;
    setBusy(true);
    try {
      const { id } = await api.startInstance({
        definitionId: defId, version, workspacePath: workspacePath.trim(), dryRun,
        ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
      });
      window.location.hash = `#/instances/${id}`;
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  }

  const hasSchema =
    !!inputSchema && Object.keys((inputSchema as { properties?: object }).properties ?? {}).length > 0;

  return (
    <div className="inline-form" role="group" aria-label={`Start v${version}`}>
      <div className="row">
        <label className="field-label" htmlFor={`ws-${defId}-${version}`}>Workspace</label>
        <input
          id={`ws-${defId}-${version}`}
          type="text"
          autoFocus
          placeholder="/absolute/path/to/workspace"
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !hasSchema) start(); }}
        />
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run <span className="hint">(stub agents — no SDK calls, no cost)</span>
        </label>
      </div>
      {hasSchema ? (
        <>
          <SchemaForm
            schema={inputSchema as never}
            submitLabel={busy ? 'Starting…' : `Start v${version}`}
            onSubmit={(vars) => start(vars)}
          />
          <div className="actions">
            <button onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button className="btn-start" disabled={!workspacePath.trim() || busy} onClick={() => start()}>
            {busy ? 'Starting…' : `Start v${version}`}
          </button>
          <button onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      )}
    </div>
  );
}
```

The `id` label ('Workspace' via `field-label` + `htmlFor`) stays intact for the test's `getByLabelText('Workspace')`.

- [ ] **Step 6: Web + server tests green**

Run: `pnpm --filter @flowfabric/web test && pnpm --filter @flowfabric/server test api-reads`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server packages/web
git commit -m "feat: start form renders SchemaForm from the version inputSchema"
```

---

### Task 5: Local BPMN migration script + docs closeout

**Files:**
- Create: `packages/server/scripts/migrate-input-schema.ts`
- Modify: `CLAUDE.md` (the `profile/read.ts` bullet under "Current state")
- Modify: `docs/specs/index.md` (plans table)

**Interfaces:**
- Consumes: `applyPatchOps` + `setInputSchema` (Task 2), `flowfabricModdle` (Task 1).
- Produces: an operator-run one-off; no runtime interface.

- [ ] **Step 1: Write the migration script**

Create `packages/server/scripts/migrate-input-schema.ts` (same tsx-script family as `probe-timecycle.ts`):

```ts
// One-off: convert a BPMN file's legacy flowfabric:instanceInputs into a
// process-level flowfabric:inputSchema (all legacy inputs become required).
// usage: cd packages/server && node --import tsx scripts/migrate-input-schema.ts <file.bpmn> [...]
import { readFileSync, writeFileSync } from 'node:fs';
import { BpmnModdle } from 'bpmn-moddle';
import { flowfabricModdle } from '@flowfabric/shared';
import { applyPatchOps } from '../src/patch-ops/apply.js';

// v1 legacy type, kept only here so this migration can still parse old files
const legacyModdle = {
  ...flowfabricModdle,
  types: [
    ...flowfabricModdle.types,
    {
      name: 'InstanceInputs',
      superClass: ['Element'],
      properties: [{ name: 'inputs', isMany: true, type: 'Input' }],
    },
  ],
};

for (const file of process.argv.slice(2)) {
  const xml = readFileSync(file, 'utf8');
  const moddle = new BpmnModdle({ flowfabric: legacyModdle });
  const parsed = await moddle.fromXML(xml);
  const proc = (parsed.rootElement as any).rootElements.find((r: any) => r.$type === 'bpmn:Process');
  const ext = proc?.extensionElements;
  const legacy = ext?.values?.find((v: any) => v.$type === 'flowfabric:InstanceInputs');
  if (!legacy) {
    console.log(`${file}: no instanceInputs - skipped`);
    continue;
  }
  const inputs: Array<{ name: string; type?: string }> = legacy.inputs ?? [];
  const schema = {
    type: 'object',
    required: inputs.map((i) => i.name),
    properties: Object.fromEntries(inputs.map((i) => [i.name, { type: i.type ?? 'string' }])),
  };
  ext.values = ext.values.filter((v: any) => v !== legacy);
  const { xml: stripped } = await moddle.toXML(parsed.rootElement, { format: true });
  const { xml: out } = await applyPatchOps(stripped, [{ op: 'setInputSchema', schema }]);
  writeFileSync(file, out);
  console.log(`${file}: migrated ${inputs.map((i) => i.name).join(', ') || '(empty)'}`);
}
```

- [ ] **Step 2: Run it on the two local files (operator step)**

Run:
```bash
cd packages/server && node --import tsx scripts/migrate-input-schema.ts \
  ../../Input/bpmn/rfp-daily-routine.bpmn ../../Input/bpmn/interview-process.bpmn
```
Expected: `migrated …` (or `no instanceInputs - skipped` for a file that never declared any — that is fine, not an error). These files are git-ignored; nothing to commit from `Input/`.

- [ ] **Step 3: Re-lint both through the daemon (operator step)**

Start the daemon (`pnpm --filter @flowfabric/server dev`), re-upload both files as new versions from the Definitions page (or `POST /api/definitions/:id/versions`), and lint.
Expected: both versions deployable (the V2-M1 verification gate); if the raw interview file was never deployable, expected = same findings as before minus any FF004 input regressions.

- [ ] **Step 4: Docs**

- `CLAUDE.md`: in the "Current state" bullet for `profile/read.ts`, replace `` `instanceInputs` `` with `` a process-level `inputSchema` ``.
- `docs/specs/index.md`: in the plans table, set the V2-M1 row status to Done.

- [ ] **Step 5: Final full suite + commit**

Run: `pnpm build && pnpm test`
Expected: PASS.

```bash
git add packages/server/scripts CLAUDE.md docs/specs/index.md
git commit -m "chore: instanceInputs->inputSchema migration script; V2-M1 closeout"
```
