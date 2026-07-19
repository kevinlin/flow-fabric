import { useEffect, useRef } from 'react';

/** Subscribe to a server SSE endpoint. `onEvent` receives each parsed data payload.
 * The callback is held in a ref so re-renders don't reopen the stream. */
export function useEventStream<T = unknown>(path: string, onEvent: (data: T) => void): void {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const es = new EventSource(path);
    es.onmessage = (e) => {
      if (!e.data || e.data.startsWith(':')) return;
      try {
        cb.current(JSON.parse(e.data) as T);
      } catch {
        /* ignore keep-alive / non-JSON frames */
      }
    };
    return () => es.close();
  }, [path]);
}
