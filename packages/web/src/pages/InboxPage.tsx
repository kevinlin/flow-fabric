import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InboxDto } from '@flowfabric/shared';
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

  async function resolve(id: number, action: 'retry' | 'skip' | 'abort') {
    setError(undefined);
    let output: Record<string, unknown> | undefined;
    if (action === 'skip') {
      const raw = window.prompt('Output JSON to merge as this task\'s result:', '{}');
      if (raw === null) return;
      try { output = JSON.parse(raw); } catch { setError('Invalid JSON'); return; }
    }
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
      {inbox.userTasks.length === 0 && <p className="muted">Nothing waiting.</p>}
      {inbox.userTasks.map((t) => (
        <div key={t.id} className="inbox-card">
          <div><b>{t.nodeId}</b> · <Link to={`/instances/${t.instanceId}`}>instance</Link></div>
          <SchemaForm schema={JSON.parse(t.formSchema)} onSubmit={(vars) => submit(t.id, vars)} />
        </div>
      ))}

      <h2>Incidents</h2>
      {inbox.incidents.length === 0 && <p className="muted">No open incidents.</p>}
      {inbox.incidents.map((inc) => (
        <div key={inc.id} className="inbox-card incident">
          <div><b>{inc.nodeId}</b> · <Link to={`/instances/${inc.instanceId}`}>instance</Link></div>
          <p className="reason">{inc.reason}</p>
          <div className="actions">
            <button onClick={() => resolve(inc.id, 'retry')}>Retry</button>
            <button onClick={() => resolve(inc.id, 'skip')}>Skip (supply output)</button>
            <button onClick={() => resolve(inc.id, 'abort')}>Abort instance</button>
          </div>
        </div>
      ))}
    </section>
  );
}
