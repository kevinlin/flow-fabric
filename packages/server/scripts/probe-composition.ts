// Usage: node --import tsx scripts/probe-composition.ts
// Probes bpmn-engine composition: same-definition callActivity, embedded subProcess,
// multi-instance loop, and whether each round-trips through getState/recover with a
// timer honoring its originally-scheduled deadline. Wayfinder R01.
import { EventEmitter } from 'node:events';
import { Engine } from 'bpmn-engine';

function listen(engine: InstanceType<typeof Engine>, tag: string): EventEmitter {
  const l = new EventEmitter();
  for (const ev of ['activity.start', 'activity.end', 'activity.call', 'activity.timer', 'activity.timeout', 'process.start', 'process.end']) {
    l.on(ev, (api: { id: string }) => console.log(new Date().toISOString(), tag, ev, api?.id));
  }
  engine.once('error', (e: Error) => console.log(tag, 'ENGINE ERROR', e.message));
  return l;
}

/** Promise for a terminal engine event, subscribed BEFORE execute() so a
 * synchronous run can't emit 'end' before we listen. */
function until(engine: InstanceType<typeof Engine>, event: 'end' | 'stop'): Promise<void> {
  return new Promise((resolve) => engine.once(event, () => resolve()));
}

// ---- 1. callActivity calling a second <process> in the SAME <definitions> ----
async function probeCallActivity(): Promise<void> {
  console.log('\n=== 1. callActivity (same definition, calledElement=child) ===');
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d1">
  <process id="parent" isExecutable="true">
    <startEvent id="ps" />
    <sequenceFlow id="pf1" sourceRef="ps" targetRef="call" />
    <callActivity id="call" calledElement="child" />
    <sequenceFlow id="pf2" sourceRef="call" targetRef="pe" />
    <endEvent id="pe" />
  </process>
  <process id="child" isExecutable="false">
    <startEvent id="cs" />
    <sequenceFlow id="cf1" sourceRef="cs" targetRef="ct" />
    <scriptTask id="ct" scriptFormat="javascript"><script>environment.output.childRan = true; next();</script></scriptTask>
    <sequenceFlow id="cf2" sourceRef="ct" targetRef="ce" />
    <endEvent id="ce" />
  </process>
</definitions>`;
  const engine = new Engine({ name: 'call', source });
  const done = until(engine, 'end');
  await engine.execute({ listener: listen(engine, 'call') });
  await done;
  console.log('callActivity completed OK');
}

// ---- 2. embedded/expanded subProcess ----
async function probeSubProcess(): Promise<void> {
  console.log('\n=== 2. embedded subProcess ===');
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d2">
  <process id="p" isExecutable="true">
    <startEvent id="s" />
    <sequenceFlow id="f1" sourceRef="s" targetRef="sub" />
    <subProcess id="sub">
      <startEvent id="ss" />
      <sequenceFlow id="sf1" sourceRef="ss" targetRef="st" />
      <scriptTask id="st" scriptFormat="javascript"><script>environment.output.subRan = true; next();</script></scriptTask>
      <sequenceFlow id="sf2" sourceRef="st" targetRef="se" />
      <endEvent id="se" />
    </subProcess>
    <sequenceFlow id="f2" sourceRef="sub" targetRef="e" />
    <endEvent id="e" />
  </process>
</definitions>`;
  const engine = new Engine({ name: 'sub', source });
  const done = until(engine, 'end');
  await engine.execute({ listener: listen(engine, 'sub') });
  await done;
  console.log('subProcess completed OK');
}

// ---- 3. multi-instance sequential loop over a collection ----
async function probeMultiInstance(): Promise<void> {
  console.log('\n=== 3. multiInstance (sequential, collection) ===');
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="d3">
  <process id="p" isExecutable="true">
    <startEvent id="s" />
    <sequenceFlow id="f1" sourceRef="s" targetRef="loop" />
    <scriptTask id="loop" scriptFormat="javascript">
      <multiInstanceLoopCharacteristics isSequential="true">
        <loopCardinality xsi:type="tFormalExpression">3</loopCardinality>
      </multiInstanceLoopCharacteristics>
      <script>environment.output.seen = (environment.output.seen||0)+1; next();</script>
    </scriptTask>
    <sequenceFlow id="f2" sourceRef="loop" targetRef="e" />
    <endEvent id="e" />
  </process>
</definitions>`;
  const engine = new Engine({ name: 'mi', source, variables: { items: [1, 2, 3] } });
  const done = until(engine, 'end');
  await engine.execute({ listener: listen(engine, 'mi') });
  await done;
  console.log('multiInstance completed OK');
}

// ---- 4. DURABILITY: timer INSIDE a subProcess, stop mid-timer, recover, resume ----
async function probeDurableTimerInSubProcess(): Promise<void> {
  console.log('\n=== 4. durable resume: timer inside subProcess ===');
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="d4">
  <process id="p" isExecutable="true">
    <startEvent id="s" />
    <sequenceFlow id="f1" sourceRef="s" targetRef="sub" />
    <subProcess id="sub">
      <startEvent id="ss" />
      <sequenceFlow id="sf1" sourceRef="ss" targetRef="wait" />
      <intermediateCatchEvent id="wait">
        <timerEventDefinition><timeDuration xsi:type="tFormalExpression">PT6S</timeDuration></timerEventDefinition>
      </intermediateCatchEvent>
      <sequenceFlow id="sf2" sourceRef="wait" targetRef="se" />
      <endEvent id="se" />
    </subProcess>
    <sequenceFlow id="f2" sourceRef="sub" targetRef="e" />
    <endEvent id="e" />
  </process>
</definitions>`;
  const t0 = Date.now();
  const engine1 = new Engine({ name: 'durable', source });
  const l1 = listen(engine1, 'run1');
  const stopped = until(engine1, 'stop');
  l1.once('activity.timer', () => {
    // Let ~3s of the 6s timer elapse, then stop.
    setTimeout(() => void engine1.stop(), 3000);
  });
  await engine1.execute({ listener: l1 });
  await stopped;
  const state = await engine1.getState();
  console.log('stopped + snapshot at +', Date.now() - t0, 'ms');

  const stateJson = JSON.stringify(state);
  console.log('state bytes:', stateJson.length);

  const engine2 = new Engine();
  engine2.recover(JSON.parse(stateJson));
  const l2 = listen(engine2, 'run2');
  const done = until(engine2, 'end');
  await engine2.resume({ listener: l2 });
  await done;
  const total = Date.now() - t0;
  console.log(`durable subProcess timer completed; total wall-clock ${total}ms (expect ~6000, NOT ~9000)`);
}

await probeCallActivity();
await probeSubProcess();
await probeMultiInstance();
await probeDurableTimerInSubProcess();
console.log('\nALL PROBES DONE');
