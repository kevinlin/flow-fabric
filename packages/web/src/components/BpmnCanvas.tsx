import { useEffect, useRef } from 'react';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';

const ZOOM_STEP = 1.2;
const DEFAULT_ZOOM = 1.5;

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
      const canvas = viewer.get('canvas');
      canvas.zoom('fit-viewport');       // center the diagram
      canvas.zoom(DEFAULT_ZOOM, 'auto');  // then apply the 150% default
      applyMarkers(viewer, markers);
    }).catch(() => { /* invalid XML renders nothing; lint panel explains why */ });
    return () => { cancelled = true; };
  }, [xml]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer?.getDefinitions?.()) applyMarkers(viewer, markers);
  }, [markers]);

  function zoomBy(factor: number) {
    const canvas = viewerRef.current?.get('canvas');
    if (!canvas) return;
    canvas.zoom(canvas.zoom() * factor, 'auto');
  }

  function resetZoom() {
    viewerRef.current?.get('canvas')?.zoom('fit-viewport');
  }

  return (
    <div className="bpmn-canvas">
      <div className="bpmn-viewport" ref={hostRef} />
      <div className="bpmn-zoom" role="group" aria-label="Diagram zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>&minus;</button>
        <button type="button" aria-label="Reset zoom" onClick={resetZoom}>Reset</button>
      </div>
    </div>
  );
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
