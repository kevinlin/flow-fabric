import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InboxDto, IncidentDto } from '@flowfabric/shared';
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

  async function resolve(id: number, action: 'retry' | 'skip' | 'abort', output?: Record<string, unknown>) {
    setError(undefined);
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
      {inbox.userTasks.length === 0 && <p className="muted">No user tasks waiting for input.</p>}
      {inbox.userTasks.map((t) => (
        <div key={t.id} className="inbox-card">
          <div><b>{t.nodeId}</b> · <Link to={`/instances/${t.instanceId}`}>instance</Link></div>
          <SchemaForm schema={JSON.parse(t.formSchema)} onSubmit={(vars) => submit(t.id, vars)} />
        </div>
      ))}

      <h2>Incidents</h2>
      {inbox.incidents.length === 0 && <p className="muted">No open incidents — every instance is running or already resolved.</p>}
      {inbox.incidents.map((inc) => (
        <IncidentCard key={inc.id} inc={inc} onResolve={resolve} onError={setError} />
      ))}
    </section>
  );
}

interface IncidentCardProps {
  inc: IncidentDto;
  onResolve: (id: number, action: 'retry' | 'skip' | 'abort', output?: Record<string, unknown>) => void;
  onError: (msg: string) => void;
}

function IncidentCard({ inc, onResolve, onError }: IncidentCardProps) {
  const [skipping, setSkipping] = useState(false);
  const [raw, setRaw] = useState('{}');

  function confirmSkip() {
    let output: Record<string, unknown>;
    try {
      output = JSON.parse(raw);
    } catch {
      onError('Skip output is not valid JSON.');
      return;
    }
    setSkipping(false);
    onResolve(inc.id, 'skip', output);
  }

  return (
    <div className="inbox-card incident">
      <div><b>{inc.nodeId}</b> · <Link to={`/instances/${inc.instanceId}`}>instance</Link></div>
      <p className="reason">{inc.reason}</p>
      {skipping ? (
        <div className="inline-form" role="group" aria-label="Skip with output">
          <label className="field-label" htmlFor={`skip-${inc.id}`}>Output JSON to merge as this task's result</label>
          <textarea
            id={`skip-${inc.id}`}
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            spellCheck={false}
          />
          <div className="actions">
            <button className="btn-start" onClick={confirmSkip}>Skip with this output</button>
            <button onClick={() => setSkipping(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button onClick={() => onResolve(inc.id, 'retry')}>Retry</button>
          <button onClick={() => setSkipping(true)}>Skip…</button>
          <button className="btn-danger" onClick={() => onResolve(inc.id, 'abort')}>Abort instance</button>
        </div>
      )}
    </div>
  );
}
