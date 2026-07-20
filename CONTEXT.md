# Flow Fabric

Local control plane for AI Developer Workflows: BPMN definitions executed against a target workspace by three actors (agents, humans, deterministic code). This glossary is the project's canonical language; `docs/specs/design_flow-fabric.md` §3 names the modules.

## Language

**Daemon**:
The single Flow Fabric process hosting every module — engine host, stores, inbox, grill, API. Exactly one Daemon per data dir.
_Avoid_: server, backend, monolith

**Workspace**:
The target folder a workflow instance operates on. Pure workload — the platform never writes its own state there; one live instance per workspace.
_Avoid_: project folder, working directory
