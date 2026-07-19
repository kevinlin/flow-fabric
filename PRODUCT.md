# Product

## Register

product

## Platform

web

## Users

Primary: the author — an engineer running their own AI Developer Workflows locally, 24/7. Their context is operational: kick off an instance against a workspace folder, then monitor it running unattended for days, glancing in to answer "what's running, where is it, what did it cost, what failed." They are always in a task — refining a diagram, resolving an incident, reading a timeline — not browsing.

Secondary: Zühlke client viewers who see Flow Fabric as a live demo of agentic-SDLC practice. Same surface serves both; when the two pull apart, the operator wins. The rule is that no screen should be one you'd hide from a client.

## Product Purpose

Flow Fabric is a local, web-based control plane for AI Developer Workflows. Users model a workflow as a BPMN 2.0 diagram; the platform executes it end-to-end against a target workspace, coordinating three actors — agents (Claude), humans, and deterministic code. The BPMN file is the source of truth for flow control, task contracts, I/O, and error handling.

Success is concrete: run `rfp-daily-routine.bpmn` unattended for at least seven consecutive daily cycles with zero silent stalls — every halt is either a modeled end event or a surfaced incident; turn a messy real-world BPMN export (Signavio) into a deployable workflow through a guided refinement session plus deterministic linting; and answer "what is running, where, what did it cost, what failed" at a glance.

## Positioning

The engine owns orchestration; the agent never decides what runs next. Flow Fabric is the Kubernetes control plane for AI workflows — it holds the tokens, gateway decisions, and timers; the workspace is the workload. That single claim separates it from an agent improvising control flow inside a chat session, and every screen has to reinforce it: the platform reports engine state, it never lets the interface (or the agent) invent it.

## Brand Personality

A sober enterprise command center with editorial restraint. Voice is precise, plain, and technical — no marketing gloss, no exclamation, no anthropomorphized agent chatter.

The emotional target is operational vigilance: status, cost, and incidents stay legible at every moment, so an operator glancing in for five seconds knows the state of every instance. The interface stays quiet until something needs attention, then makes the incident the loudest thing on the page. Three words: controlled, vigilant, considered.

The tool should look as considered as the practice it demonstrates — a control plane for disciplined agentic work has to itself read as disciplined.

## Anti-references

Not flashy consumer AI product marketing: no gradient hero text, no big-number hero-metric templates, no chatbot-cute styling, no sparkle. Not a terminal or hacker aesthetic: no neon-on-black IDE cosplay. Familiar admin and dashboard patterns are fine where they serve the task — the ban is on decoration and costume, not on standard affordances an operator already knows.

## Design Principles

Show engine truth, never improvise. The UI reads and renders orchestration state — token position, gateway outcome, task contract — straight from the engine and event log. It never guesses, interpolates, or lets an agent narrate what happened.

Never silently stall. Every instance is always in a legible state: running, waiting, a modeled end, or a surfaced incident. "Where did last night's run stop and why" has an answer on screen without digging. This is the product's core promise made visible.

Vigilant, not noisy. Keep live status, token cost, and open incidents readable at a glance across every view, but hold the visual voice down until something is actually wrong. Restraint is the default; the incident is the interruption.

Density earns its place. The operator wants information — timelines with inputs, outputs, durations, and per-step cost; dense instance and event tables. Give them density where the task needs it, whitespace where it doesn't, and never pad a screen to look designed.

Demo-grade by default. Because every screen doubles as a client demo, there is no "internal-only, ship it rough" tier. Polish is the floor, not a later pass.

## Accessibility & Inclusion

WCAG 2.1 AA, committed and documented. Body text at 4.5:1 and large text at 3:1 against their backgrounds, visible keyboard focus rings, a reduced-motion alternative for every transition, keyboard-complete flows, and skip links. The current build already meets this bar in `app.css`; the standard is to hold it, not to regress from it.
