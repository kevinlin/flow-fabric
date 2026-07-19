import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders grill-agent chat text as Markdown (GFM: tables, strikethrough, task lists).
 * react-markdown never injects raw HTML and strips dangerous URLs by default,
 * so untrusted agent output is safe without a sanitizer. Links open in a new tab.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
