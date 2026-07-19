import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deterministic bpmn-js double: real NavigatedViewer needs layout jsdom lacks.
const zoom = vi.hoisted(() => vi.fn((..._args: unknown[]) => 1));
const canvas = vi.hoisted(() => ({ zoom, addMarker: vi.fn(), removeMarker: vi.fn() }));

vi.mock('bpmn-js/lib/NavigatedViewer', () => ({
  default: vi.fn().mockImplementation(() => ({
    importXML: vi.fn().mockResolvedValue({}),
    getDefinitions: () => ({}),
    get: (name: string) =>
      name === 'canvas' ? canvas : { getAll: () => [], get: () => null },
    destroy: vi.fn(),
  })),
}));

import { BpmnCanvas } from '../src/components/BpmnCanvas';

describe('BpmnCanvas zoom controls', () => {
  beforeEach(() => zoom.mockClear());

  it('renders zoom in / out / reset controls', () => {
    render(<BpmnCanvas xml="" />);
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeTruthy();
  });

  it('zoom in scales the current zoom up, zoom out scales it down', () => {
    render(<BpmnCanvas xml="" />);
    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(zoom).toHaveBeenLastCalledWith(1.2, 'auto');
    fireEvent.click(screen.getByRole('button', { name: /zoom out/i }));
    expect(zoom).toHaveBeenLastCalledWith(1 / 1.2, 'auto');
  });

  it('reset fits the diagram to the viewport', () => {
    render(<BpmnCanvas xml="" />);
    fireEvent.click(screen.getByRole('button', { name: /reset zoom/i }));
    expect(zoom).toHaveBeenLastCalledWith('fit-viewport');
  });
});
