# Flow Fabric Icon Design

## Goal

Create a complete app icon and favicon image set for Flow Fabric. The icon must remain recognizable from a 1024 px app icon down to a 16 px browser favicon and must follow `PRODUCT.md` and `DESIGN.md`.

## Approved Direction

The approved concept is **Token Route**, a subtle `FF` monogram built from two execution paths.

The mark uses:

- Two white, rounded path strokes that read as a paired `FF`.
- Three circular nodes placed on the paths to suggest BPMN token movement.
- A deep-green rounded-square field that connects the icon to Flow Fabric's command rail.
- One amber node, one blue node, and one coral node, drawn from the existing semantic palette.

The icon is a compact brand mark, not a literal BPMN diagram. It must not add arrows, labels, gradients, shadows, texture, or extra workflow symbols.

## Visual Rules

### Palette

- Background: Command Rail Green, `#003c33`.
- Monogram paths: Canvas White, `#ffffff`.
- Running node: Running Amber, `#b26a00`.
- Waiting node: Signal Blue, `#1863dc`.
- Attention node: Incident Coral, `#ff7759`.

No other colors are permitted.

### Geometry

- Use a square canvas.
- Use a rounded-square background with a corner radius of 22 percent of the canvas width.
- Keep generous and even optical padding around the monogram.
- Build both `F` shapes from vertical and horizontal path segments with rounded caps and joins.
- Keep the second `F` offset to the right so the two letters read as a system without merging into one glyph.
- Place three nodes at distinct path endpoints or junctions.
- Separate each colored node from the white path or green field with enough contrast to remain visible at small sizes.

### Small-Size Treatment

The 64, 32, and 16 px favicon variants may use heavier path strokes and larger nodes than a proportional downscale. These changes are optical corrections, not alternate designs.

At 16 px:

- The paired `FF` must remain readable as a monogram.
- All three colored nodes must remain distinct.
- The green field must reach the image edges with transparent corners outside the rounded square.
- No fine detail may rely on antialiasing alone.

## Asset Set

Create all files under `packages/web/public/assets/icons/`.

| File | Dimensions | Purpose |
| --- | ---: | --- |
| `flow-fabric-icon-1024.png` | 1024 x 1024 | Master app icon |
| `flow-fabric-icon-512.png` | 512 x 512 | Desktop and high-density app icon |
| `flow-fabric-icon-256.png` | 256 x 256 | Desktop app icon |
| `flow-fabric-icon-192.png` | 192 x 192 | Web app icon |
| `apple-touch-icon.png` | 180 x 180 | Apple touch icon |
| `favicon-64.png` | 64 x 64 | High-density browser favicon |
| `favicon-32.png` | 32 x 32 | Standard browser favicon |
| `favicon-16.png` | 16 x 16 | Small browser favicon |
| `favicon.ico` | 16, 32, and 48 px frames | Multi-size browser favicon |

The task creates image assets only. It does not update `index.html`, add a web manifest, or change the sidebar brand treatment.

## Production Method

Use the built-in image generation path to create the 1024 px source artwork from the approved Token Route prompt. Inspect the generated source before deriving the remaining sizes.

Derive the large PNG variants from the accepted source. Create optically adjusted favicon variants when direct downscaling loses legibility. Package 16, 32, and 48 px frames into `favicon.ico`.

Do not retain rejected generations in the project asset folder.

## Verification

Verify:

1. Every listed file exists in the new asset folder.
2. Every PNG has the specified dimensions and an alpha channel.
3. `favicon.ico` contains 16, 32, and 48 px frames.
4. The rounded-square corners are transparent.
5. The mark is visually intact at 1024, 180, 64, 32, and 16 px.
6. Solid color areas use the exact approved RGB values. Only antialiased edge pixels may contain blended colors.
7. No unrequested project files are changed.
