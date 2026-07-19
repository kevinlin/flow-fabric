import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InstanceDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { useEventStream } from '../api/sse';
import { fmtTime } from '../lib/instance-view';

export function InstancesPage() {
  const [rows, setRows] = useState<InstanceDto[]>([]);
  const refresh = () => api.listInstances().then(setRows);
  useEffect(() => { refresh(); }, []);
  // any instance lifecycle event refreshes the list
  useEventStream('/api/events', () => refresh());

  return (
    <section>
      <h1>Instances</h1>
      {rows.length === 0 && <p className="muted">No instances yet. Start one from a deployable definition.</p>}
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Dry run</th><th>Started</th></tr></thead>
        <tbody>
          {rows.slice().reverse().map((r) => (
            <tr key={r.id}>
              <td><Link to={`/instances/${r.id}`}>{r.name}</Link></td>
              <td><span className={`status-${r.status}`}>{r.status}</span></td>
              <td>{r.dryRun ? 'yes' : 'no'}</td>
              <td>{fmtTime(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
