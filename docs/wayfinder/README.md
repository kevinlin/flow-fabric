# Wayfinder tracker (local-markdown)

This directory is a Wayfinder map: a shared map that charts the way to a
destination, then works decision tickets one at a time until the route is clear.
No native issue tracker was configured, so the map lives here as markdown.

## Layout

- `map.md` — the map itself (labelled `wayfinder:map`). The low-resolution index:
  destination, notes, decisions so far, fog, out-of-scope. Loaded once per session.
- `tickets/NNN-slug.md` — one child ticket per file. Each is a single decision or
  investigation, sized to one agent session.
- `research/*.md` — findings written by research tickets; linked from their ticket.

## Ticket conventions

Each ticket file carries front-matter:

```yaml
id: 001                       # stable identity; also the name prefix
title: <the question, as a name>
type: grilling                # research | prototype | grilling | task
mode: HITL                    # HITL (worked with the human) | AFK (agent alone)
status: open                  # open | closed
assignee: null                # null = unclaimed. A name here IS the claim.
blocked-by: []                # ticket ids; unblocked when all of them are closed
```

Body is `## Question` (the decision to resolve). On resolution, append
`## Resolution` and set `status: closed`.

## Operations

- **Claim** a ticket: set `assignee` before doing any work, so parallel sessions skip it.
- **Frontier** (what's takeable now): tickets where `status: open`, `assignee: null`,
  and every id in `blocked-by` points to a `status: closed` ticket.
- **Blocked**: an open ticket with any open ticket in its `blocked-by`.
- **Resolve**: post `## Resolution`, set `status: closed`, add a one-line pointer to
  the map's "Decisions so far".
- **Fog → ticket**: when a resolution makes a fog item specifiable, create a new
  ticket and delete that item from the map's "Not yet specified".

Never resolve more than one ticket per session — except research tickets.
