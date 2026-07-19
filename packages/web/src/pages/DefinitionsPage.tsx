import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DefinitionDto, VersionSummaryDto } from '@flowfabric/shared';
import { api } from '../api/client';

export function DefinitionsPage() {
  const [defs, setDefs] = useState<DefinitionDto[]>([]);
  const [error, setError] = useState<string>();

  const refresh = () => api.listDefinitions().then(setDefs).catch((e) => setError(String(e)));
  useEffect(() => { refresh(); }, []);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await api.uploadDefinition(file.name.replace(/\.bpmn$/i, ''), await file.text());
      await refresh();
    } catch (err) {
      setError(String(err));
    }
    e.target.value = '';
  }

  return (
    <section>
      <h1>Definitions</h1>
      <label className="upload">
        Upload BPMN <input type="file" accept=".bpmn,.xml" onChange={onUpload} />
      </label>
      {error && <p className="lint-bad">{error}</p>}
      {defs.length === 0 && <p className="muted">No definitions yet. Upload a BPMN file to begin.</p>}
      {defs.map((d) => <DefinitionRow key={d.id} def={d} />)}
    </section>
  );
}

function DefinitionRow({ def }: { def: DefinitionDto }) {
  const [versions, setVersions] = useState<VersionSummaryDto[]>([]);
  const refresh = () => api.listVersions(def.id).then(setVersions);
  useEffect(() => { refresh(); }, [def.id]);

  async function lint(v: number) {
    await api.lintVersion(def.id, v);
    await refresh();
  }

  async function start(v: number) {
    const workspacePath = window.prompt('Workspace path to run against:');
    if (!workspacePath) return;
    const dryRun = window.confirm('Dry run (stub agents)? OK = dry run, Cancel = real run.');
    const { id } = await api.startInstance({ definitionId: def.id, version: v, workspacePath, dryRun });
    window.location.hash = `#/instances/${id}`;
  }

  return (
    <div className="def-card">
      <div className="def-head">
        <strong>{def.name}</strong>
        <Link to={`/definitions/${def.id}/refine`}>Refine</Link>
      </div>
      <table>
        <thead><tr><th>Version</th><th>Lint</th><th>Actions</th></tr></thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.versionNo}>
              <td>v{v.versionNo}</td>
              <td className={v.deployable ? 'lint-ok' : 'lint-bad'}>
                {v.deployable ? 'deployable' : 'not deployable'}
              </td>
              <td>
                <button onClick={() => lint(v.versionNo)}>Lint</button>{' '}
                <button disabled={!v.deployable} onClick={() => start(v.versionNo)}>Start</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
