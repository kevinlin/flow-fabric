import { useEffect, useState } from 'react';
import type { DefinitionDto, DefinitionMetricsDto } from '@flowfabric/shared';
import { api } from '../api/client';
import { fmtCost, fmtDuration } from '../lib/instance-view';

export function DashboardsPage() {
  const [defs, setDefs] = useState<DefinitionDto[]>();
  const [selected, setSelected] = useState<string>();
  const [m, setM] = useState<DefinitionMetricsDto>();

  useEffect(() => {
    api.listDefinitions().then((d) => {
      setDefs(d);
      if (d[0]) setSelected(d[0].id);
    });
  }, []);
  useEffect(() => {
    if (!selected) return;
    setM(undefined);
    api.metrics(selected).then(setM);
  }, [selected]);

  const maxDur = m ? Math.max(1, ...m.durationsMs) : 1;

  return (
    <section>
      <h1>Dashboards</h1>

      {defs === undefined ? (
        <div className="tiles" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton skeleton-tile" />)}
        </div>
      ) : defs.length === 0 ? (
        <p className="muted">No definitions yet. Upload a BPMN file on Definitions to start collecting metrics.</p>
      ) : (
        <>
          <div className="field-row">
            <label className="field-label" htmlFor="metrics-def">Definition</label>
            <select id="metrics-def" value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
              {defs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          {!m ? (
            <div className="tiles" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton skeleton-tile" />)}
            </div>
          ) : (
            <>
              <div className="tiles">
                <Tile label="Success rate" value={m.successRate === null ? '—' : `${Math.round(m.successRate * 100)}%`} />
                <Tile label="Total runs" value={String(m.runs.total)} />
                <Tile label="Active" value={String(m.runs.active)} />
                <Tile label="Open incidents" value={`${m.incidents.open}/${m.incidents.total}`} />
              </div>

              <h2>Run duration</h2>
              {m.durationsMs.length === 0 ? <p className="muted">No finished runs yet.</p> : (
                <div className="bars">
                  {m.durationsMs.map((d, i) => (
                    <div key={i} className="bar" style={{ width: `${Math.max(6, (d / maxDur) * 100)}%` }} title={fmtDuration(d)}>
                      {fmtDuration(d)}
                    </div>
                  ))}
                </div>
              )}

              <h2>Cost per task</h2>
              {m.costPerTask.length === 0 ? <p className="muted">No task executions recorded yet.</p> : (
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Node</th><th>Runs</th><th>Total cost</th><th>Avg duration</th></tr></thead>
                    <tbody>
                      {m.costPerTask.map((t) => (
                        <tr key={t.nodeId}>
                          <td>{t.nodeId}</td><td>{t.runs}</td><td>{fmtCost(t.totalCostUsd)}</td>
                          <td>{fmtDuration(t.avgDurationMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return <div className="tile"><div className="tile-value">{value}</div><div className="tile-label">{label}</div></div>;
}
