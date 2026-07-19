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
        Upload BPMN
        <input type="file" accept=".bpmn,.xml" onChange={onUpload} />
      </label>
      {error && <p className="lint-bad">{error}</p>}
      {defs.length === 0 && <p className="muted">No definitions yet. Upload a BPMN file to begin.</p>}
      {defs.map((d) => <DefinitionRow key={d.id} def={d} onDeleted={refresh} onError={setError} />)}
    </section>
  );
}

interface DefinitionRowProps {
  def: DefinitionDto;
  onDeleted: () => void;
  onError: (msg: string) => void;
}

function DefinitionRow({ def, onDeleted, onError }: DefinitionRowProps) {
  const [versions, setVersions] = useState<VersionSummaryDto[]>([]);
  const [startVersion, setStartVersion] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => api.listVersions(def.id).then(setVersions);
  useEffect(() => { refresh(); }, [def.id]);

  async function lint(v: number) {
    await api.lintVersion(def.id, v);
    await refresh();
  }

  async function remove() {
    try {
      await api.deleteDefinition(def.id);
      onDeleted();
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <div className="def-card">
      <div className="def-head">
        <strong>{def.name}</strong>
        <span className="def-actions">
          <Link to={`/definitions/${def.id}/refine`}>Refine</Link>
          {confirmDelete ? (
            <span className="confirm-inline">
              <span className="q">Delete all versions?</span>
              <button className="btn-danger" onClick={remove}>Delete</button>
              <button onClick={() => setConfirmDelete(false)}>Cancel</button>
            </span>
          ) : (
            <button className="btn-danger" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </span>
      </div>
      <div className="table-scroll">
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
                  <button
                    disabled={!v.deployable}
                    onClick={() => setStartVersion((cur) => (cur === v.versionNo ? null : v.versionNo))}
                  >
                    {startVersion === v.versionNo ? 'Cancel' : 'Start'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {startVersion !== null && (
        <StartForm
          defId={def.id}
          version={startVersion}
          onCancel={() => setStartVersion(null)}
          onError={onError}
        />
      )}
    </div>
  );
}

interface StartFormProps {
  defId: string;
  version: number;
  onCancel: () => void;
  onError: (msg: string) => void;
}

function StartForm({ defId, version, onCancel, onError }: StartFormProps) {
  const [workspacePath, setWorkspacePath] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!workspacePath.trim() || busy) return;
    setBusy(true);
    try {
      const { id } = await api.startInstance({ definitionId: defId, version, workspacePath: workspacePath.trim(), dryRun });
      window.location.hash = `#/instances/${id}`;
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  }

  return (
    <div className="inline-form" role="group" aria-label={`Start v${version}`}>
      <div className="row">
        <label className="field-label" htmlFor={`ws-${defId}-${version}`}>Workspace</label>
        <input
          id={`ws-${defId}-${version}`}
          type="text"
          autoFocus
          placeholder="/absolute/path/to/workspace"
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') start(); }}
        />
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run <span className="hint">(stub agents — no SDK calls, no cost)</span>
        </label>
      </div>
      <div className="actions">
        <button className="btn-start" disabled={!workspacePath.trim() || busy} onClick={start}>
          {busy ? 'Starting…' : `Start v${version}`}
        </button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
