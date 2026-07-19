import type { LintReport } from '@flowfabric/shared';

export function LintPanel({ report }: { report: LintReport | null }) {
  if (!report) return <p className="muted">Not linted yet.</p>;
  return (
    <div className="lint-panel">
      <p className={report.deployable ? 'lint-ok' : 'lint-bad'}>
        {report.deployable ? 'Deployable' : `Not deployable — ${report.errorCount} error${report.errorCount === 1 ? '' : 's'}`}
      </p>
      {report.findings.length > 0 && (
        <ul>
          {report.findings.map((f, i) => (
            <li key={i} className={`finding sev-${f.severity}`}>
              <code>{f.rule}</code> {f.nodeId ? <em>{f.nodeId}</em> : null} — {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
