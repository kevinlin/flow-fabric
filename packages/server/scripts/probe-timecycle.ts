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
