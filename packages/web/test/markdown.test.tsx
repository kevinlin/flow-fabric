import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown';

describe('Markdown', () => {
  it('renders inline emphasis and code as elements, not raw syntax', () => {
    const { container } = render(<Markdown text="Run **audit** on `Task_1`" />);
    expect(container.querySelector('strong')?.textContent).toBe('audit');
    expect(container.querySelector('code')?.textContent).toBe('Task_1');
    expect(container.textContent).not.toContain('**');
  });

  it('renders lists and fenced code blocks', () => {
    const { container } = render(<Markdown text={'- one\n- two\n\n```\nconst x = 1;\n```'} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('pre code')?.textContent).toContain('const x = 1;');
  });

  it('renders GFM tables', () => {
    const { container } = render(<Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('opens links in a new tab and strips javascript: URLs', () => {
    const { container } = render(
      <Markdown text="[safe](https://x.test) and [bad](javascript:alert(1))" />,
    );
    const links = container.querySelectorAll('a');
    expect(links[0].getAttribute('href')).toBe('https://x.test');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noreferrer');
    // react-markdown's default url transform neutralizes dangerous protocols
    expect(links[1].getAttribute('href')).not.toContain('javascript:');
  });
});
