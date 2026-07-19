# Flow Fabric Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the approved Token Route app icon and deliver the complete PNG and ICO asset set under the web package.

**Architecture:** Generate one 1024 px raster source with the built-in image generation tool, remove its flat chroma-key exterior to create transparent rounded corners, then derive the required large and favicon sizes with Pillow. Use optical corrections for the smallest variants if proportional downscaling weakens the monogram.

**Tech Stack:** Built-in image generation tool, imagegen chroma-key removal helper, Python 3, Pillow 12.1.1

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-19-flow-fabric-icon-design.md`.
- Create assets only under `packages/web/public/assets/icons/`.
- Use only `#003c33`, `#ffffff`, `#b26a00`, `#1863dc`, and `#ff7759`, except for antialiased edge pixels.
- Do not add arrows, labels, gradients, shadows, texture, or extra workflow symbols.
- Do not modify `packages/web/index.html`, add a manifest, or change the sidebar.

---

### Task 1: Generate and approve the 1024 px master

**Files:**
- Create: `packages/web/public/assets/icons/flow-fabric-icon-1024.png`

**Interfaces:**
- Consumes: Approved Token Route geometry and palette from the design spec.
- Produces: A visually approved 1024 x 1024 RGBA master used by Task 2.

- [ ] **Step 1: Confirm the master does not already exist**

Run:

```bash
test ! -e packages/web/public/assets/icons/flow-fabric-icon-1024.png
```

Expected: exit code 0.

- [ ] **Step 2: Generate the source artwork**

Use the built-in image generation tool with this prompt:

```text
Use case: logo-brand
Asset type: square app icon master
Primary request: Create the Flow Fabric "Token Route" icon, a subtle paired FF monogram formed by two clean execution paths.
Scene/backdrop: Place the rounded-square icon on a perfectly flat solid #ff00ff chroma-key exterior for background removal. The exterior must have no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Subject: A deep-green #003c33 rounded square with a corner radius of 22 percent. Inside it, two offset white #ffffff F-shaped paths made from vertical and horizontal segments with rounded caps and joins. Add exactly three circular execution nodes: amber #b26a00, blue #1863dc, and coral #ff7759, each on a distinct endpoint or junction.
Style/medium: Flat vector-like geometric brand mark rendered as a crisp raster image.
Composition/framing: Centered, symmetrical optical padding, icon fills most of the square while leaving a uniform chroma-key border outside its rounded corners.
Constraints: Preserve a clearly readable paired FF. Use only the specified icon colors. Exactly three colored nodes. Crisp edges. No cast shadow, contact shadow, reflection, watermark, or text.
Avoid: arrows, labels, gradients, bevels, 3D depth, fabric texture, extra nodes, extra workflow symbols, neon styling, terminal styling.
```

Expected: one square source image with a flat magenta exterior.

- [ ] **Step 3: Copy the generated source into a temporary workspace path**

Copy the exact saved file returned by the built-in image generation tool to `/tmp/flow-fabric-icon-chroma.png`.

Expected: `/tmp/flow-fabric-icon-chroma.png` exists and is the selected square source image.

- [ ] **Step 4: Remove the chroma-key exterior**

Run:

```bash
python "${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/scripts/remove_chroma_key.py" \
  --input /tmp/flow-fabric-icon-chroma.png \
  --out packages/web/public/assets/icons/flow-fabric-icon-1024.png \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```

Expected: the master PNG has an alpha channel and transparent corners.

- [ ] **Step 5: Normalize solid fills to the approved palette**

Run:

```bash
python3 -c 'from PIL import Image; p="packages/web/public/assets/icons/flow-fabric-icon-1024.png"; im=Image.open(p).convert("RGBA"); targets=[(0,60,51),(255,255,255),(178,106,0),(24,99,220),(255,119,89)]; out=[]; 
for r,g,b,a in im.getdata():
 d=[(r-tr)**2+(g-tg)**2+(b-tb)**2 for tr,tg,tb in targets]; i=min(range(len(d)),key=d.__getitem__); out.append((*targets[i],a) if d[i] <= 24**2 else (r,g,b,a))
im.putdata(out); im.save(p,optimize=True)'
```

Expected: near-matching solid fills use their exact approved RGB values while antialiased transition pixels remain intact.

- [ ] **Step 6: Inspect the master**

Open `packages/web/public/assets/icons/flow-fabric-icon-1024.png` with the local image viewer and check:

- The paired `FF` is legible.
- Exactly three colored nodes are present.
- There is no text, shadow, gradient, or texture.
- Corners are transparent.

If one check fails, make one targeted image-generation edit and repeat Steps 3 through 6.

### Task 2: Derive and verify the complete icon set

**Files:**
- Create: `packages/web/public/assets/icons/flow-fabric-icon-512.png`
- Create: `packages/web/public/assets/icons/flow-fabric-icon-256.png`
- Create: `packages/web/public/assets/icons/flow-fabric-icon-192.png`
- Create: `packages/web/public/assets/icons/apple-touch-icon.png`
- Create: `packages/web/public/assets/icons/favicon-64.png`
- Create: `packages/web/public/assets/icons/favicon-32.png`
- Create: `packages/web/public/assets/icons/favicon-16.png`
- Create: `packages/web/public/assets/icons/favicon.ico`

**Interfaces:**
- Consumes: `flow-fabric-icon-1024.png` from Task 1.
- Produces: The complete app icon and favicon deliverable set.

- [ ] **Step 1: Verify the derived files are absent**

Run:

```bash
test ! -e packages/web/public/assets/icons/flow-fabric-icon-512.png \
  -a ! -e packages/web/public/assets/icons/flow-fabric-icon-256.png \
  -a ! -e packages/web/public/assets/icons/flow-fabric-icon-192.png \
  -a ! -e packages/web/public/assets/icons/apple-touch-icon.png \
  -a ! -e packages/web/public/assets/icons/favicon-64.png \
  -a ! -e packages/web/public/assets/icons/favicon-32.png \
  -a ! -e packages/web/public/assets/icons/favicon-16.png \
  -a ! -e packages/web/public/assets/icons/favicon.ico
```

Expected: exit code 0.

- [ ] **Step 2: Create a temporary derivation script**

Create `/tmp/derive-flow-fabric-icons.py` with this content:

```python
from pathlib import Path
from PIL import Image

asset_dir = Path("packages/web/public/assets/icons")
master = Image.open(asset_dir / "flow-fabric-icon-1024.png").convert("RGBA")

sizes = {
    "flow-fabric-icon-512.png": 512,
    "flow-fabric-icon-256.png": 256,
    "flow-fabric-icon-192.png": 192,
    "apple-touch-icon.png": 180,
    "favicon-64.png": 64,
    "favicon-32.png": 32,
    "favicon-16.png": 16,
}

for filename, size in sizes.items():
    resized = master.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(asset_dir / filename, optimize=True)

master.save(
    asset_dir / "favicon.ico",
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
)
```

Expected: the script has one responsibility, deriving all requested image sizes from the approved master.

- [ ] **Step 3: Run the derivation script**

Run:

```bash
python3 /tmp/derive-flow-fabric-icons.py
```

Expected: all eight derived files are created without errors.

- [ ] **Step 4: Verify dimensions, color mode, transparency, and ICO frames**

Run:

```bash
python3 -c 'from pathlib import Path; from PIL import Image; d=Path("packages/web/public/assets/icons"); expected={"flow-fabric-icon-1024.png":(1024,1024),"flow-fabric-icon-512.png":(512,512),"flow-fabric-icon-256.png":(256,256),"flow-fabric-icon-192.png":(192,192),"apple-touch-icon.png":(180,180),"favicon-64.png":(64,64),"favicon-32.png":(32,32),"favicon-16.png":(16,16)}; [(_ for _ in ()).throw(AssertionError(f"{n}: {im.size} {im.mode}")) if im.size != s or im.mode != "RGBA" or im.getpixel((0,0))[3] != 0 else None for n,s in expected.items() for im in [Image.open(d/n)]]; ico=Image.open(d/"favicon.ico"); assert ico.ico.sizes()=={(16,16),(32,32),(48,48)}; print("all icon assets verified")'
```

Expected:

```text
all icon assets verified
```

- [ ] **Step 5: Inspect a contact sheet**

Create and view a contact sheet containing the 1024, 180, 64, 32, and 16 px files on both white and soft-stone backgrounds.

Expected:

- The monogram remains identifiable at every size.
- All three nodes remain distinct.
- The icon has no chroma-key fringe.

If the 32 or 16 px mark fails, redraw only that favicon variant with heavier strokes and larger nodes, preserving the approved geometry and palette.

- [ ] **Step 6: Verify project scope**

Run:

```bash
git status --short
```

Expected: only files in `packages/web/public/assets/icons/` are untracked or modified, apart from the already committed design and plan documents and the untracked `.superpowers/` browser-companion directory.

- [ ] **Step 7: Commit the assets**

```bash
git add packages/web/public/assets/icons
git commit -m "feat: add Flow Fabric app icons"
```
