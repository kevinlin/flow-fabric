import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { InstanceDetailDto, TimelineEntryDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { useEventStream } from '../api/sse';
import { BpmnCanvas } from '../components/BpmnCanvas';
import { nodeMarkers } from '../lib/node-status';
import { deriveDisplayStatus, fmtCost, fmtDuration } from '../lib/instance-view';

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
