import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

  it('shows the node label instead of the raw id, keeping the id on hover', () => {
    render(<LintPanel report={{
      findings: [{ rule: 'FF002', severity: 'error', nodeId: 'sid-ABC', nodeName: 'Audit tracker', message: 'x' }],
      errorCount: 1, deployable: false,
    }} />);
    const em = screen.getByText('Audit tracker');
    expect(em.getAttribute('title')).toBe('sid-ABC');
    expect(screen.queryByText('sid-ABC')).toBeNull();
  });

  it('renders an "Ask grill to fix" button for a finding with a suggestion and sends it on click', () => {
    const onSuggest = vi.fn();
    render(<LintPanel onSuggest={onSuggest} report={{
      findings: [{ rule: 'FF002', severity: 'error', nodeId: 'sid-ABC', nodeName: 'Audit tracker',
        message: 'x', suggestion: 'Give it a contract.' }],
      errorCount: 1, deployable: false,
    }} />);
    const btn = screen.getByRole('button', { name: /ask grill to fix/i });
    fireEvent.click(btn);
    expect(onSuggest).toHaveBeenCalledWith('Give it a contract.');
  });

  it('shows no fix button when the finding has no suggestion', () => {
    render(<LintPanel onSuggest={() => {}} report={{
      findings: [{ rule: 'FF005', severity: 'error', nodeId: 'orphan', nodeName: 'Old step', message: 'unreachable' }],
      errorCount: 1, deployable: false,
    }} />);
    expect(screen.queryByRole('button', { name: /ask grill to fix/i })).toBeNull();
  });

  it('disables the fix button while a grill turn is busy', () => {
    render(<LintPanel onSuggest={() => {}} busy report={{
      findings: [{ rule: 'FF002', severity: 'error', nodeId: 'x', message: 'x', suggestion: 'fix it' }],
      errorCount: 1, deployable: false,
    }} />);
    expect(screen.getByRole('button', { name: /ask grill to fix/i }).hasAttribute('disabled')).toBe(true);
  });
});
