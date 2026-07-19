import type { LintReport } from '@flowfabric/shared';

interface LintPanelProps {
  report: LintReport | null;
  /** When set, a grill-fixable finding shows an "Ask grill to fix" button that sends this text. */
  onSuggest?: (text: string) => void;
  /** Disables the fix buttons while a grill turn is in flight. */
  busy?: boolean;
}

export function LintPanel({ report, onSuggest, busy }: LintPanelProps) {
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
              <code>{f.rule}</code> {f.nodeName || f.nodeId ? <em title={f.nodeId}>{f.nodeName ?? f.nodeId}</em> : null} — {f.message}
              {f.suggestion && onSuggest ? (
                <button className="fix-btn" disabled={busy} onClick={() => onSuggest(f.suggestion!)}>
                  Ask grill to fix
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
