import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { InstanceDetailDto, TimelineEntryDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { useEventStream } from '../api/sse';
import { BpmnCanvas } from '../components/BpmnCanvas';
import { nodeMarkers } from '../lib/node-status';
import { deriveStatusView, fmtCost, fmtDuration } from '../lib/instance-view';

export function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<InstanceDetailDto>();
  const [xml, setXml] = useState('');
  const [tab, setTab] = useState<'diagram' | 'timeline'>('diagram');
  const [pending, setPending] = useState(0);
  const [timers, setTimers] = useState(0);
  const [transcriptId, setTranscriptId] = useState<number | null>(null);

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
  const status = deriveStatusView(instance, pending, timers);
  const abortable = ['running', 'incident'].includes(instance.status);

  return (
    <section>
      <h1>{instance.name}</h1>
      <div className="instance-meta">
        <span className={`status-${status.badgeClass}`}>{status.label}</span>
        <span className="workspace" title={instance.workspace}>{instance.workspace}</span>
        {abortable && (
          <button className="btn-danger" onClick={() => api.abortInstance(instance.id).then(refresh)}>Abort</button>
        )}
      </div>
      <div className="tabs">
        <button className={tab === 'diagram' ? 'active' : ''} onClick={() => setTab('diagram')}>Diagram</button>
        <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Timeline</button>
      </div>
      {tab === 'diagram'
        ? (xml ? <BpmnCanvas xml={xml} markers={markers} /> : <p className="muted">No diagram — this instance was started from raw source.</p>)
        : <Timeline rows={timeline} onViewTranscript={setTranscriptId} />}
      {transcriptId !== null && (
        <TranscriptDialog execId={transcriptId} onClose={() => setTranscriptId(null)} />
      )}
    </section>
  );
}

interface TimelineProps {
  rows: TimelineEntryDto[];
  onViewTranscript: (execId: number) => void;
}

function Timeline({ rows, onViewTranscript }: TimelineProps) {
  if (rows.length === 0) return <p className="muted">No steps recorded yet.</p>;
  return (
    <div className="table-scroll">
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
                ? <button onClick={() => onViewTranscript(r.id)}>View</button>
                : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutputCell({ json }: { json: string | null }) {
  if (!json) return <span className="muted">—</span>;
  return <code className="cell-json" title={json}>{json.length > 60 ? `${json.slice(0, 60)}…` : json}</code>;
}

function TranscriptDialog({ execId, onClose }: { execId: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    ref.current?.showModal();
    api.transcript(execId).then(setText).catch((e) => setError(String(e)));
  }, [execId]);

  return (
    <dialog className="transcript" ref={ref} onClose={onClose}>
      <div className="dlg-head">
        <span className="dlg-title">Transcript · execution #{execId}</span>
        <button onClick={() => ref.current?.close()}>Close</button>
      </div>
      <pre>{error ? error : text === null ? 'Loading transcript…' : text || '(empty transcript)'}</pre>
    </dialog>
  );
}
