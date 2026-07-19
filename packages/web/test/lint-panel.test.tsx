import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LintPanel } from '../src/components/LintPanel';

describe('LintPanel', () => {
  it('shows deployable when there are no errors', () => {
    render(<LintPanel report={{ findings: [], errorCount: 0, deployable: true }} />);
    expect(screen.getByText(/deployable/i)).toBeTruthy();
  });

  it('lists findings with their rule id and message', () => {
    render(<LintPanel report={{
      findings: [{ rule: 'FF002', severity: 'error', nodeId: 'Task_1', message: 'missing contract' }],
      errorCount: 1, deployable: false,
    }} />);
    expect(screen.getByText(/FF002/)).toBeTruthy();
    expect(screen.getByText(/missing contract/)).toBeTruthy();
    expect(screen.getByText(/1 error/i)).toBeTruthy();
  });
});
