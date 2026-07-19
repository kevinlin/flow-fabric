---
name: Flow Fabric
description: A local control plane for AI Developer Workflows, rendered as an append-only operator's ledger inside a calm command center.
colors:
  primary: "#17171c"
  deep-green: "#003c33"
  ink: "#212121"
  action-blue: "#1863dc"
  focus-blue: "#4c6ee6"
  form-focus: "#9b60aa"
  coral: "#ff7759"
  coral-soft: "#ffad9b"
  amber: "#b26a00"
  error: "#b30000"
  canvas: "#ffffff"
  soft-stone: "#eeece7"
  pale-green: "#edfce9"
  pale-blue: "#f1f5ff"
  pale-amber: "#fbf3e6"
  pale-red: "#fdf1f0"
  card-border: "#f2f2f2"
  muted: "#616161"
  slate: "#75758a"
  faint: "#93939f"
  hairline: "#d9d9dd"
  border-light: "#e5e7eb"
  on-dark: "#ffffff"
typography:
  display:
    fontFamily: '"Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif'
    fontSize: "34px"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  metric:
    fontFamily: '"Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif'
    fontSize: "32px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: '"Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif'
    fontSize: "20px"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  body:
    fontFamily: '"Inter", "Helvetica Neue", Arial, ui-sans-serif, system-ui, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  control:
    fontFamily: '"Inter", "Helvetica Neue", Arial, ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace'
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.06em"
  data:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace'
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "22px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  "2xl": "32px"
components:
  button:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.pill}"
    padding: "7px 16px"
  button-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.pill}"
    padding: "7px 16px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-dark}"
    typography: "{typography.control}"
    rounded: "{rounded.pill}"
    padding: "7px 16px"
  tab-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-dark}"
    typography: "{typography.control}"
    rounded: "{rounded.pill}"
    padding: "6px 16px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "20px 22px"
  card-incident:
    backgroundColor: "{colors.pale-red}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "20px 22px"
  tile:
    backgroundColor: "{colors.soft-stone}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "20px 22px"
  status-running:
    backgroundColor: "{colors.pale-amber}"
    textColor: "{colors.amber}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  status-waiting:
    backgroundColor: "{colors.pale-blue}"
    textColor: "{colors.action-blue}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  status-completed:
    backgroundColor: "{colors.pale-green}"
    textColor: "{colors.deep-green}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  status-incident:
    backgroundColor: "{colors.pale-red}"
    textColor: "{colors.error}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
---

# Design System: Flow Fabric

## 1. Overview

**Creative North Star: "The Operator's Ledger"**

Flow Fabric is the control plane for AI Developer Workflows, and its interface is the append-only record made legible. Every state transition of every instance is written down and never erased; the UI's whole job is to render that ledger so a single operator, glancing in for five seconds, knows exactly what is running, where each token sits, what it cost, and what failed. The visual system serves that reading. A white editorial canvas holds the record; a deep-green rail runs down the left as the persistent command spine; monospace labels mark every system value the way a ledger marks its columns. Numbers are tabular so they never jitter as they update. Nothing decorates.

The register is product: the tool disappears into the task. It stays quiet at rest and reserves its one loud voice for the incident — the paused token awaiting a human, which becomes the most saturated thing on the page the instant it appears. This is "command-center vigilance under editorial restraint": status, cost, and open incidents are always readable, but the surface only raises its voice when something is genuinely wrong. Because every screen doubles as a live client demo, there is no rough internal tier; polish is the floor.

This system explicitly rejects flashy consumer-AI product marketing (gradient hero text, big-number hero-metric templates, chatbot-cute styling, sparkle) and the terminal / hacker aesthetic (neon-on-black IDE cosplay). Familiar admin and dashboard affordances an operator already knows are welcome; costume and decoration are not.

**Key Characteristics:**
- White canvas record, one persistent deep-green command rail, hairlines instead of shadows.
- Monospace uppercase labels on every system value; sentence-case sans reserved for human prose.
- Weight-400 display type: hierarchy from size and negative tracking, not bold.
- Tabular numerics everywhere a value can change (cost, duration, counts, tokens).
- A pale, quiet status vocabulary that goes saturated only for incidents.
- Pill-shaped controls; the single commit action of a view fills near-black.

## 2. Colors: The Ledger Palette

A near-neutral record on white, anchored by one committed brand color (the deep-green rail) and a small, disciplined semantic set that maps one-to-one onto instance state.

### Primary
- **Graphite Near-Black** (`#17171c`): The commit color. Primary CTAs, the active tab, the platform-log panel, and dark surfaces. It is the "do it" of any view — an operator should be able to find the one committing action by looking for the one near-black pill.
- **Command Rail Green** (`#003c33`): The brand's committed color and its identity. It fills the persistent left navigation rail, draws the "completed / terminated" success state, and renders dashboard data bars. It is the only saturated color allowed to hold a large surface.

### Secondary
- **Signal Blue** (`#1863dc`): Links, secondary emphasis, and the "waiting" instance state (token parked on a user task or timer). Never a decorative fill.
- **Incident Coral** (`#ff7759`): The warm alarm marker — incident card borders, error-level log levels, and the running-token accent. Used sparingly and only to draw the eye to something that needs a human.

### Tertiary (semantic state)
- **Running Amber** (`#b26a00`): In-progress work — the "running" badge and the live token stroke on the diagram.
- **Alert Red** (`#b30000`): Failure and validation errors — incident reasons, failed states, error copy.
- **Field-Focus Violet** (`#9b60aa`) and **Focus Blue** (`#4c6ee6`): Input focus border and keyboard focus ring, respectively.

### Neutral
- **Canvas White** (`#ffffff`): The dominant page and card surface — the ledger's paper.
- **Ink** (`#212121`): Default body text.
- **Muted Ink** (`#616161`): De-emphasized body copy. Deliberately dark enough to clear 4.5:1 on white; it replaced a lighter gray to hold the AA line.
- **Slate** (`#75758a`) and **Faint Slate** (`#93939f`): Metadata, mono labels, and tertiary text.
- **Soft Stone** (`#eeece7`): The warm neutral second surface — dashboard tiles, inline code chips, agent chat bubbles, table-row hover.
- **Hairline** (`#d9d9dd`), **Border Light** (`#e5e7eb`), **Card Hairline** (`#f2f2f2`): The three rule weights that carry structure in place of shadow.
- **Status Washes** — **Pale Green** (`#edfce9`), **Pale Blue** (`#f1f5ff`), **Pale Amber** (`#fbf3e6`), **Pale Red** (`#fdf1f0`): The pale backgrounds behind status badges and state tints. Each is the near-white end of its own semantic hue, never a generic gray.

### Named Rules
**The Rail Rule.** Command Rail Green is the one committed color permitted to hold a large surface (the nav rail, data bars). Every other saturated color earns its place by mapping to a specific instance state — never decoration.

**The Quiet-Until-Wrong Rule.** State tints stay pale by default (the washes). Saturation is a signal, not a style: only the running amber and, above all, the incident coral/red are allowed to raise their voice, because they are the only states that demand a human.

## 3. Typography

**Display Font:** Space Grotesk (with Inter, ui-sans-serif, system-ui fallback)
**Body Font:** Inter (with Helvetica Neue, Arial fallback)
**Label / Mono Font:** ui-monospace / SF Mono / JetBrains Mono / Menlo

**Character:** A three-voice system with real contrast on the axis, not two lookalike sans. Space Grotesk's geometric, slightly mechanical display voice carves the page titles and the big dashboard numbers; Inter carries all human-readable body and controls; a monospace stack marks every machine value — labels, table headers, badges, JSON, logs. The split is semantic: if a person reads it as prose, it's Inter; if it's a system value or a column header, it's mono.

### Hierarchy
- **Display** (Space Grotesk, 400, 34px, line-height 1.05, tracking -0.02em): Page titles (h1). Weight 400 — hierarchy comes from size and tracking.
- **Metric** (Space Grotesk, 500, 32px, line-height 1): Dashboard tile values. Tabular numerics.
- **Headline** (Space Grotesk, 500, 20px, line-height 1.1): Card titles, definition names, the sidebar brand mark.
- **Body** (Inter, 400, 16px, line-height 1.5): Default human copy. Prose stays inside 65–75ch; dense tables may run wider.
- **Control** (Inter, 500, 14px): Buttons, tabs, inputs, nav links — every interactive label.
- **Label** (mono, 500, 11px, tracking 0.06em, UPPERCASE): Section headers (h2), table column heads, status badges, tile captions. The ledger's column markers.
- **Data** (mono, 400, 12.5px): Inline code, JSON value cells, platform logs.

### Named Rules
**The Mono-Label Rule.** Every system value — a table header, a status badge, a metric caption, a section marker — is uppercase monospace. Sentence-case sans is reserved for text a human wrote or reads as prose. This one rule is what makes the interface read as a ledger rather than a dashboard.

**The Weight-400 Display Rule.** Display type is never bold. Space Grotesk at 400–500 carries every heading; size and negative tracking do the hierarchy work. Reaching for 700 to make a heading "louder" is prohibited.

## 4. Elevation

Flow Fabric is flat by intent. Depth comes from three hairline rule weights (`#d9d9dd`, `#e5e7eb`, `#f2f2f2`), surface alternation (white canvas against soft-stone tiles against the deep-green rail), and rounded containment — not from stacked shadows. There is exactly one shadow in the system, and it appears only as a response to state.

### Shadow Vocabulary
- **Soft Lift** (`box-shadow: 0 1px 2px rgba(23,23,28,0.04), 0 2px 6px rgba(23,23,28,0.05)`): The single ambient shadow. Applied on card hover (paired with a 1px `translateY`) and on the floating BPMN zoom controls. Diffuse and low; it signals "interactive," never "important."

### Named Rules
**The Hairline-Over-Shadow Rule.** Structure is drawn with 1px rules and surface changes, not drop shadows. A card is defined by its border and its radius; it earns the Soft Lift only while hovered. If a surface needs a heavy shadow to separate from its background, the layout is wrong — change the surface tone instead.

## 5. Components

Components are **confident and tactile**: pill-shaped, decisive on interaction, with a firm hover response and real feedback rather than a whisper. They stay restrained at rest — hairline borders, flat fills — then commit clearly when touched. The commit action of a view fills near-black; everything else is an outline until the pointer arrives.

### Buttons
- **Shape:** Fully pill (999px radius). This is the system's signature control shape.
- **Default:** White fill, `#212121` ink, 1px hairline border, 7px 16px padding. On hover it inverts to a near-black fill with white text — a firm, tactile flip, not a tint. Active presses to `scale(0.97)`.
- **Primary / Commit:** Near-black (`#17171c`) fill with white text at rest — the one committing action per view (Refine's send, a form's submit). Hover lightens to `#2c2c34`.
- **Upload:** Outline pill variant; hover firms the border to ink and warms the fill to soft-stone.
- **Disabled:** 45% opacity, default cursor.

### Tabs
- Segmented pill row. Inactive tabs read as default outline buttons; the active tab fills near-black with white text. One selected tab per group, always visible.

### Cards / Containers
- **Corner Style:** 16px radius (`--r-md`).
- **Background:** White canvas, 1px `#e5e7eb` border.
- **Shadow Strategy:** Flat at rest; Soft Lift plus a 1px upward nudge on hover (see Elevation).
- **Internal Padding:** 20px 22px.
- **Incident variant:** Full 1px Incident-Coral border over a Pale-Red wash — a whole-card state change, no side stripe. This is the loudest card in the system by design.

### Inputs / Fields
- **Style:** White fill, 1px hairline border, 8px radius, 8px 12px padding.
- **Focus:** Border shifts to Field-Focus Violet (`#9b60aa`) with a soft 3px violet glow (`rgba(155,96,170,0.18)`) — a tactile, unmistakable focus without a hard ring.
- **Schema forms** pair a 140px mono label column against the field, with a raw-JSON escape hatch for inputs the flat form can't express.

### Status Badges
- **Shape:** Small pill, uppercase-to-lowercase mono at 11.5px.
- **Vocabulary:** running → Pale-Amber / Amber; waiting → Pale-Blue / Signal-Blue; completed & terminated → Pale-Green / Command-Rail-Green; incident, failed, error, aborted → Pale-Red / Alert-Red. Each badge is its semantic hue's pale wash behind that hue's ink. This same four-color state map drives the live token strokes on the diagram.

### Navigation (the command rail)
- **Style:** Fixed 232px left rail in Command Rail Green, full viewport height, sticky. The brand mark sits in Space Grotesk; a coral mono tagline sits beneath it.
- **Links:** White at 66% opacity at rest (control weight); hover raises to full white over a faint white overlay; the active route is full white over a stronger white overlay, 8px radius. The rail is the one place text sits on a saturated field — and it uses white-on-green, never gray-on-green.

### Signature: the BPMN canvas + live token markers
- The diagram renders in a bordered, near-white viewport with floating zoom controls. Live state paints directly onto nodes via a 3px stroke in the status color: running amber, done Command-Rail-Green, failed Alert-Red, waiting Signal-Blue (dashed). The diagram is the token position made literal — the clearest expression of "show engine truth, never improvise."

## 6. Do's and Don'ts

### Do:
- **Do** reserve the one near-black pill for the single commit action of each view; make everything else an outline until hover.
- **Do** set every system value — table headers, status badges, metric captions, section markers — in uppercase monospace, and every human-readable string in Inter.
- **Do** use `font-variant-numeric: tabular-nums` on every number that can change (cost, duration, counts, tokens) so columns never jitter as the ledger updates.
- **Do** draw structure with the three hairline weights and surface alternation; let the single Soft Lift appear only on hover.
- **Do** keep status tints pale by default and let only running (amber) and incident (coral/red) carry saturation.
- **Do** hold muted body copy at `#616161` or darker on white; keep body text ≥4.5:1 and large text ≥3:1 (WCAG 2.1 AA), including placeholders.
- **Do** give every interactive element visible keyboard focus and a `prefers-reduced-motion` fallback.

### Don't:
- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent stripe on cards, alerts, or list items. State changes recolor the whole border and tint the fill (see the incident card).
- **Don't** import flashy consumer-AI marketing: no gradient hero text, no big-number hero-metric templates, no chatbot-cute styling, no sparkle.
- **Don't** drift toward a terminal / hacker look: no neon-on-black, no IDE-console cosplay. The one dark surface is the platform-log panel, and it is a quiet graphite, not a green-on-black terminal.
- **Don't** bold display type to add emphasis; if a heading needs weight, it needs size or space, not 700.
- **Don't** put gray text on the green rail or on any colored field — use white (or the field's own darker shade), never a washed-out gray.
- **Don't** add drop shadows to separate surfaces; change the surface tone or add a hairline instead.
- **Don't** saturate inactive states — a resting badge, an idle tab, a completed row stays pale. Saturation is reserved for what needs a human now.
