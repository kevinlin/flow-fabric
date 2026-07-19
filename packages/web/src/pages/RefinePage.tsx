import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { LintReport } from '@flowfabric/shared';
import { api } from '../api/client';
import { useEventStream } from '../api/sse';
import { BpmnCanvas } from '../components/BpmnCanvas';
import { LintPanel } from '../components/LintPanel';
import { Markdown } from '../components/Markdown';
import { messageToText } from '../lib/chat';

export function RefinePage() {
  const { id } = useParams<{ id: string }>();
  const [sessionId, setSessionId] = useState<string>();
  const [xml, setXml] = useState('');
  const [lint, setLint] = useState<LintReport | null>(null);
  const [chat, setChat] = useState<Array<{ who: 'you' | 'agent'; text: string }>>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    setError(undefined);
    api.startGrill(id).then(async ({ sessionId, lint }) => {
      setSessionId(sessionId);
      setLint(lint);
      setXml((await api.getGrill(sessionId)).xml);
    }).catch((e) => setError(`Could not start a refine session: ${e}`));
  }, [id]);

  useEventStream(sessionId ? `/api/grill/sessions/${sessionId}/events` : '/api/events', (ev: any) => {
    if (!sessionId) return;
    if (ev.type === 'chat') {
      const text = messageToText(ev.message);
      if (text) setChat((c) => [...c, { who: 'agent', text }]);
    } else if (ev.type === 'lint-updated') {
      setLint(ev.report);
      api.getGrill(sessionId).then((s) => setXml(s.xml));
    } else if (ev.type === 'turn-done') {
      setBusy(false);
    }
  });

  // Keep the latest message in view. A concise-arrow effect would *return*
  // scrollIntoView's value (a Promise in some browsers), which React treats as
  // a cleanup fn and later tries to call — crashing the tree. Block body = no return.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat]);

  async function send(text: string = draft) {
    if (!sessionId || !text.trim()) return;
    setChat((c) => [...c, { who: 'you', text }]);
    setBusy(true);
    setDraft('');
    try {
      await api.sendGrill(sessionId, text);
    } catch (e) {
      setBusy(false);
      setError(`Message failed: ${e}`);
    }
  }

  async function save() {
    if (!sessionId) return;
    try {
      const { versionNo, deployable } = await api.saveGrillVersion(sessionId);
      setSaved(`Saved v${versionNo}${deployable ? ' (deployable)' : ' (not yet deployable)'}`);
    } catch (e) {
      setError(`Save failed: ${e}`);
    }
  }

  return (
    <section className="refine">
      <div className="refine-top">
        <BpmnCanvas xml={xml} />
      </div>
      <div className="refine-bottom">
        <div className="refine-lint">
          {error && <p className="lint-bad">{error}</p>}
          <LintPanel report={lint} busy={busy} onSuggest={send} />
          <div className="refine-footer">
            <button onClick={save} disabled={!sessionId}>Save version</button>
            {saved && <span className="muted">{saved}</span>}
          </div>
        </div>
        <div className="refine-chat">
        <div className="chat-log">
          {chat.map((m, i) => (
            <div key={i} className={`chat-msg ${m.who}`}>
              <b>{m.who}:</b> {m.who === 'agent' ? <Markdown text={m.text} /> : m.text}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <div className="chat-input">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Answer the grill agent…"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button onClick={() => send()} disabled={busy || !sessionId}>{busy ? 'Thinking…' : 'Send'}</button>
        </div>
        </div>
      </div>
    </section>
  );
}
