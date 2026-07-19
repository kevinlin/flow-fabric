import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SchemaForm } from '../src/components/SchemaForm';

const schema = {
  type: 'object',
  required: ['approved'],
  properties: {
    approved: { type: 'boolean' },
    notes: { type: 'string' },
    priority: { type: 'number' },
  },
};

describe('SchemaForm', () => {
  it('coerces field values to their declared types on submit', () => {
    const onSubmit = vi.fn();
    render(<SchemaForm schema={schema} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText('approved'));
    fireEvent.change(screen.getByLabelText('notes'), { target: { value: 'looks good' } });
    fireEvent.change(screen.getByLabelText('priority'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith({ approved: true, notes: 'looks good', priority: 3 });
  });

  it('submits raw JSON from the escape hatch', () => {
    const onSubmit = vi.fn();
    render(<SchemaForm schema={schema} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /raw json/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"approved":false}' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith({ approved: false });
  });
});
