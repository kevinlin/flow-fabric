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
