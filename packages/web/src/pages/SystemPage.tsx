import { useEffect, useState } from 'react';
import type { ArmedTimerDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { parseLogLine } from '../lib/logs';

export function SystemPage() {
  const [healthy, setHealthy] = useState<boolean>();
  const [timers, setTimers] = useState<ArmedTimerDto[]>([]);
  const [lines, setLines] = useState<string[]>([]);

  async function refresh() {
    setHealthy(await fetch('/api/healthz').then((r) => r.ok).catch(() => false));
    setTimers((await api.scheduler()).timers);
    setLines((await api.logs(200)).lines);
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <section>
      <h1>System</h1>
      <p>Health: <b className={healthy ? 'lint-ok' : 'lint-bad'}>{healthy ? 'ok' : 'unreachable'}</b></p>

      <h2>Scheduler — next timer firings</h2>
      {timers.length === 0 ? <p className="muted">No armed timers.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Instance</th><th>Node</th><th>Fires at</th><th>In</th></tr></thead>
            <tbody>
              {timers.map((t) => (
                <tr key={`${t.instanceId}:${t.nodeId}`}>
                  <td>{t.instanceId.slice(0, 8)}</td>
                  <td>{t.nodeId}</td>
                  <td>{new Date(t.expireAt).toLocaleString()}</td>
                  <td>{Math.max(0, Math.round((t.expireAt - Date.now()) / 1000))}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Platform logs</h2>
      <div className="logs">
        {lines.map((line, i) => {
          const p = parseLogLine(line);
          return <div key={i} className={`log log-${p.level}`}>
            <span className="log-level">{p.level}</span> {p.msg}
          </div>;
        })}
      </div>
    </section>
  );
}
