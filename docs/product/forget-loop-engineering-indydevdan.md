# FORGET Loop Engineering. Agentic Engineering is about THIS

**Dan Eisler (IndyDevDan), YouTube, 2026-07-13**

A direct critique of "Loop Engineering" as a misleading brand, and a case for reframing agentic engineering around **AI Developer Workflows (ADWs)** running inside a **Software Factory**.

---

## Core Argument

Loop Engineering is an inaccurate rebrand of the software development lifecycle. Focusing only on the "loop" misses the full picture: deterministic code, specialist agents, human prompting, human review, parallel sandboxes, Kanban queues, and routing logic are all part of the system. If we name the loop, we also need "condition engineering," "function engineering," and "exception engineering" -- which is absurd.

The better frame: engineers build **AI Developer Workflows** that orchestrate the [[Three Actors of Value Creation]] (engineers, agents, code) end-to-end.

---

## Key Concepts

- [[AI Developer Workflow]] -- the primary unit of agentic engineering; replaces "loop" as the organizing frame
- [[Three Actors of Value Creation]] -- engineers, agents, code; each has a cost, speed, and reliability profile
- [[Software Factory (ADW)]] -- the full structure produced when multiple specialized ADWs run inside a routing system
- [[Building the System that Builds the System]] -- meta-engineering principle: engineers operate on the agentic layer, not the app layer

---

## ADW Progression (from simple to full factory)

1. **Minimal** -- human prompts LLM, human reviews
2. **Code + Agent** -- linter/formatter feeds back into build agent on fail
3. **Multi-validator** -- type check + tests feed back into build agent
4. **Test Agent** -- bundle all validation into a specialist agent
5. **Planner + Scout** -- split search from planning across two agents
6. **Worktrees → Sandboxes** -- each agent gets isolation (worktrees first, then full compute sandboxes)
7. **Kanban Queue** -- tickets from support/product/eng route into factory workflows
8. **Full Software Factory** -- routing agent classifies ticket type (feature / bug / chore / hotfix), spins correct specialized workflow, manages merge and ship

---

## Three Actors Detail

| Actor | Cost | Reliability | Speed |
|-------|------|-------------|-------|
| Engineer | High | High | Slow |
| Agent | Medium (tokens) | Medium-low | Medium |
| Code | Near-zero | Perfect | Fastest |

> "Everyone in their AI psychosis seems to forget code is fast, always runs the same way unless you tell it not to. And it costs nothing."

---

## Hotfix Workflow Pattern

Specialized ADW for production outages:
1. Support ticket → Slack → cracked engineer picks up
2. Engineer prompts scout → hot fix agent (specialist with surgical mandate)
3. Human-in-loop approval gate
4. Multiple parallel sandboxes race toward solution (first to pass wins)
5. Engineer validates → ships

---

## Design Principles for ADWs

1. **Keep it simple** -- start with the smallest workflow that solves a real problem
2. **Separate agents from code** -- don't have an agent call code inside a skill; run them as separate nodes with explicit information handoff
3. **Do it by hand first** -- walk the workflow step by step before automating; use Mermaid to diagram it
4. **Agents + code beats either alone** -- balance stochastic agent steps with deterministic code for reliability, speed, and testability
5. **Two constraints of agentic engineering** -- humans show up at the beginning (planning/prompting) and end (reviewing/validating)

---

## Relationship to Loop Engineering

Eisler does not deny loops exist -- he drew dozens of them in this video. His point: the loop is one control-flow primitive inside a larger workflow. Elevating it to a philosophy ("Loop Engineering") is like naming your entire architecture pattern after a while-loop.

> "If you want to call it a loop, I don't really care. I think a loop is too constrained."

This is a **terminology dispute with a substantive undercurrent**: by naming it "loop," practitioners might focus on the feedback cycle and miss the agent specialization, code-agent separation, routing logic, sandbox infrastructure, and organizational process that make a factory actually work.

---

## Contradictions / Tensions

> [!contradiction] Contradicts [[Loop Engineering]] framing from [[Addy Osmani]], [[lencx]], others
> This source argues "loop" is too narrow a frame. The loop-engineering corpus (Osmani, lencx, 五源信号站) treats loops as the primary architectural unit. Eisler concedes the loop exists but argues the Software Factory / ADW framing is more actionable and complete. Compatible at the implementation level; at odds at the naming level.
