import { useState } from 'react';

type Schema = {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
};

export function SchemaForm({ schema, onSubmit }: { schema: Schema; onSubmit: (vars: Record<string, unknown>) => void }) {
  const props = schema.properties ?? {};
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState('{}');
  const [error, setError] = useState<string>();

  function set(name: string, v: string | boolean) {
    setValues((prev) => ({ ...prev, [name]: v }));
  }

  function submit() {
    setError(undefined);
    if (raw) {
      try {
        onSubmit(JSON.parse(rawText));
      } catch {
        setError('Invalid JSON');
      }
      return;
    }
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(props)) {
      const v = values[name];
      if (v === undefined) continue;
      if (spec.type === 'number' || spec.type === 'integer') out[name] = Number(v);
      else if (spec.type === 'boolean') out[name] = Boolean(v);
      else out[name] = v;
    }
    onSubmit(out);
  }

  return (
    <div className="schema-form">
      <button type="button" className="raw-toggle" onClick={() => setRaw((r) => !r)}>
        {raw ? 'Form fields' : 'Raw JSON'}
      </button>
      {raw ? (
        <textarea aria-label="raw json" value={rawText} onChange={(e) => setRawText(e.target.value)} rows={6} />
      ) : (
        Object.entries(props).map(([name, spec]) => (
          <div key={name} className="field">
            <label htmlFor={`f-${name}`}>{name}</label>
            {spec.type === 'boolean' ? (
              <input id={`f-${name}`} type="checkbox"
                checked={Boolean(values[name])} onChange={(e) => set(name, e.target.checked)} />
            ) : spec.enum ? (
              <select id={`f-${name}`} value={String(values[name] ?? '')} onChange={(e) => set(name, e.target.value)}>
                <option value="" disabled>choose…</option>
                {spec.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
              </select>
            ) : (
              <input id={`f-${name}`}
                type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'}
                value={String(values[name] ?? '')} onChange={(e) => set(name, e.target.value)} />
            )}
          </div>
        ))
      )}
      {error && <p className="lint-bad">{error}</p>}
      <button onClick={submit}>Submit</button>
    </div>
  );
}
