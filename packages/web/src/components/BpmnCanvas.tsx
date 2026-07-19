import { useEffect, useRef } from 'react';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

export function BpmnCanvas({ xml, markers = {} }: { xml: string; markers?: Record<string, string> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);

  useEffect(() => {
    const viewer = new BpmnViewer({ container: hostRef.current! });
    viewerRef.current = viewer;
    return () => viewer.destroy();
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !xml) return;
    let cancelled = false;
    viewer.importXML(xml).then(() => {
      if (cancelled) return;
      viewer.get('canvas').zoom('fit-viewport');
      applyMarkers(viewer, markers);
    }).catch(() => { /* invalid XML renders nothing; lint panel explains why */ });
    return () => { cancelled = true; };
  }, [xml]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer?.getDefinitions?.()) applyMarkers(viewer, markers);
  }, [markers]);

  return <div className="bpmn-canvas" ref={hostRef} />;
}

const ALL_MARKERS = ['node-running', 'node-done', 'node-failed', 'node-waiting'];

function applyMarkers(viewer: any, markers: Record<string, string>) {
  const canvas = viewer.get('canvas');
  const registry = viewer.get('elementRegistry');
  for (const el of registry.getAll()) {
    for (const m of ALL_MARKERS) canvas.removeMarker(el.id, m);
  }
  for (const [id, cls] of Object.entries(markers)) {
    if (registry.get(id)) canvas.addMarker(id, cls);
  }
}
