export const LINT_RULES = {
  UNSUPPORTED_ELEMENT: 'FF001',
  MISSING_CONTRACT: 'FF002',
  UNEVALUABLE_CONDITION: 'FF003',
  UNDECLARED_VARIABLE: 'FF004',
  ORPHAN_NODE: 'FF005',
  INSTRUCTION_LABEL: 'FF006',
} as const;

export type LintRuleId = (typeof LINT_RULES)[keyof typeof LINT_RULES];

export interface LintFinding {
  rule: LintRuleId;
  severity: 'error' | 'warning';
  /** Flow node or sequence flow id the finding points at; absent for file-level findings. */
  nodeId?: string;
  /** Human label of the node (moddle `name`), when it has one. The UI shows this instead of the id. */
  nodeName?: string;
  message: string;
  /** Ready-to-send grill instruction that fixes this finding. Present only for grill-actionable rules. */
  suggestion?: string;
}

export interface LintReport {
  findings: LintFinding[];
  errorCount: number;
  /** Zero errors ⇒ deployable (FR-3). Warnings do not block. */
  deployable: boolean;
}
