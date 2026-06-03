# Session 2 Brief: Perspective Warp — Board Image Update

*Paste this into a fresh Claude Code thread to start Session 2.*

---

## Context: What This App Is

Climbing route logger for a private angle-adjustable board. Routes reference holds by ID, and hold positions are stored as percentages within a `boardRegion` of the board photo. If the board photo changes and isn't aligned to the old coordinate space, all existing hold overlays render in the wrong positions.

**Full project context is in `CLAUDE.md` and `CURRENT_STATE.md`** — read both at session start.

---

## What Session 1 Built (COMPLETED)

A 3-step image update wizard in `BoardImageUpdateView.jsx` that lets the admin update the board photo from their phone:

```
upload → crop → confirm (+ save to Supabase Storage)
```

### How It Works Now
1. **Upload** — pick photo from gallery/camera, downscale to max 2000px
2. **Crop** — draggable crop rectangle with 4 corner handles, touch-friendly
3. **Confirm** — side-by-side comparison (current vs new), editable image name (auto-increments version), save button
4. **Save** — generates 4 responsive sizes (full, 2000w, 1200w, 800w), uploads to Supabase Storage `board-images` bucket, saves config to `board_settings` table

### Key Files from Session 1
| File | What It Does |
|------|-------------|
| `src/components/BoardImageUpdateView.jsx` (~600 lines) | The wizard component — `CropStep` sub-component + main wizard with upload/crop/confirm steps |
| `src/App.jsx` | `boardImageConfig` state, `handleBoardImageSave` (upload pipeline), lazy import + render block for wizard |
| `src/components/Settings.jsx` | Admin-only "Update Board Image" button |
| `src/lib/supabase.js` | `storageUrl()` helper |
| `TASK_SPEC_BOARD_IMAGE_UPDATE.md` | Full 3-session spec with shared contracts |

### Current Wizard Step Flow (in BoardImageUpdateView.jsx)
```jsx
const [step, setStep] = useState('upload'); // 'upload' | 'crop' | 'confirm'
```

- `step === 'upload'` → file picker, preview, "Next →" button
- `step === 'crop'` → `<CropStep>` component, outputs a cropped canvas
- `step === 'confirm'` → side-by-side preview, name input, "Save" button

The crop step's `onNext` callback receives the cropped canvas and transitions to confirm:
```jsx
onNext={(canvas) => { setCroppedCanvas(canvas); setStep('confirm'); }}
```

### Shared Contracts (DO NOT CHANGE)
- **Supabase bucket:** `board-images` (public read, authenticated write)
- **board_settings key:** `board_image_config` → `{ imageName, baseUrl, updatedAt }`
- **View state:** `updateBoardImage` (settings → updateBoardImage → settings)
- **Props:** `{ currentImgSrc, currentImageName, onSave, onCancel }`
- **onSave receives:** `{ imageName, imageBlobs: { full, w2000, w1200, w800 } }`

---

## Session 2 Task: Add Perspective Warp Step

### Goal
Insert an **align** step between crop and confirm:
```
upload → crop → align → confirm
```

The user drags 4 corner pins on the new image to align it with the old image (shown as a semi-transparent background). A canvas-based perspective warp corrects the new image to match the old coordinate space, so existing hold positions remain accurate.

### Why This Matters
Without perspective warp, the user must take the new photo from the exact same position as the old one. With it, they can take a photo from any reasonable angle and correct it by aligning 4 corners.

### Align Step Design

**Layout:**
- **Oversized workspace:** The align canvas should be **larger than both images** — add ~20% padding around the old image on all sides. This lets the user drag pins outside the old image's bounds, which is essential when the new photo was taken from a different distance or angle. The new image may need to be stretched larger than the old one to get accurate corner alignment. Without this, perspective corrections are clipped and lose accuracy at the edges.
- **Background layer:** Current board image centered in the oversized workspace, at adjustable transparency (slider, 0-100%)
- **Foreground layer:** Cropped new image, partially transparent, overlaid on the workspace
- **4 corner pins** (draggable, 44px+ touch targets) placed on the new image's corners — draggable anywhere within the oversized workspace (not constrained to the old image bounds)
- User drags pins until the new image's board edges align with the old image underneath

**Interaction:**
- Pins default to the 4 corners of the cropped image
- Each pin is independently draggable (touch + mouse, using the `lastTouchTimeRef` pattern from CLAUDE.md)
- As pins are dragged, a live preview shows the warped result (or updates on release if performance is an issue)
- Transparency slider lets the user see through the new image to the old one for alignment
- "Next" button applies the final warp and transitions to confirm
- "Back" button returns to crop
- "Skip" option for when the photo is already well-aligned (passes the cropped canvas through unchanged)

**Step labels update:**
```js
// Currently:
{ upload: 'Step 1 of 3 — Upload', crop: 'Step 2 of 3 — Crop', confirm: 'Step 3 of 3 — Confirm' }
// Should become:
{ upload: 'Step 1 of 4 — Upload', crop: 'Step 2 of 4 — Crop', align: 'Step 3 of 4 — Align', confirm: 'Step 4 of 4 — Confirm' }
```

### Perspective Warp Algorithm (Canvas Triangle Mesh)

This is a well-established canvas technique — no WebGL needed:

1. **Source quad:** The 4 corner pin positions (where the user dragged them) — in the cropped image's coordinate space
2. **Destination quad:** The 4 corners of the output canvas (i.e., a rectangle the same size as the cropped image)
3. **Subdivide** both quads into a triangle mesh (e.g., 10×10 grid = 200 triangles)
4. **For each triangle pair:** compute the affine transform from source → destination triangle, use `ctx.setTransform()` + `ctx.drawImage()` with clipping to render that piece
5. **Result:** A perspective-corrected canvas where the board area in the new image maps to the same rectangle as the old image

The mesh density (10×10) gives smooth results. Higher density = smoother but slower. 10×10 should be fine for mobile.

**Key math:** For each triangle, compute the affine transform matrix that maps 3 source points to 3 destination points. Canvas `setTransform(a, b, c, d, e, f)` applies this directly.

### Implementation Approach

**Option A: Self-contained AlignStep component** (recommended)
- Create a new `AlignStep` function component inside `BoardImageUpdateView.jsx` (same pattern as `CropStep`)
- Props: `{ croppedCanvas, currentImgSrc, onNext, onBack }`
- `onNext` receives the warped canvas (or the original if skipped)
- Keeps all warp logic contained — no changes to App.jsx

**The wizard integration is minimal:**
```jsx
// Add 'align' to step state
const [step, setStep] = useState('upload'); // 'upload' | 'crop' | 'align' | 'confirm'

// Crop step transitions to align instead of confirm
<CropStep onNext={(canvas) => { setCroppedCanvas(canvas); setStep('align'); }} ... />

// New align step block
{step === 'align' && croppedCanvas && (
  <AlignStep
    croppedCanvas={croppedCanvas}
    currentImgSrc={currentImgSrc}
    onNext={(warpedCanvas) => { setCroppedCanvas(warpedCanvas); setStep('confirm'); }}
    onBack={() => setStep('crop')}
  />
)}
```

Note: `onNext` replaces `croppedCanvas` with the warped version, so the confirm step and save pipeline work unchanged.

### Touch Handling Rules (from CLAUDE.md — CRITICAL)
- Use `lastTouchTimeRef` pattern: stamp `Date.now()` on touchstart, ignore mouse events within 500ms
- Corner pins need both `onTouchStart` and `onMouseDown` handlers
- Touch targets must be at minimum 44px
- Use `e.preventDefault()` on touchstart to prevent scroll while dragging pins

### Styling
- Follow existing app style: peach background `#FFAB94`, white cards, dark text `#1A0A00`
- Accent blue `#0047FF` for pins and active elements
- DM Sans body, Space Mono headings/labels
- Mobile-first, max-width 480px
- Pin styling: filled circles with white border, blue accent color, ~20px radius with 44px touch target

---

## Session 2 Scope — What to Change

### Files to Modify
1. **`src/components/BoardImageUpdateView.jsx`** — Add `AlignStep` component, update step state machine, update step labels

### Files NOT to Touch
- `src/App.jsx` — no changes needed (onSave contract unchanged)
- `src/components/Settings.jsx` — no changes
- `src/components/BoardView.jsx` / `BoardSetupView.jsx` / `HoldEditorView.jsx` — no changes
- Any hold data, route data, or coordinate system code

### Verification
1. `npm run build` succeeds
2. Full wizard flow works: upload → crop → align → confirm → save
3. "Skip" on align step passes cropped image through unchanged
4. Dragging pins on phone is smooth (44px targets, no scroll interference)
5. Warped output looks correct when pins are placed accurately
6. Existing functionality unaffected (route creation, hold manager, etc.)

---

## Session 3 (Future — NOT This Session)

Session 3 is deliberately not designed in detail here — it will get its own brief after Session 2 is complete. Start a new thread after Session 2 to get a focused Session 3 brief (same approach as this one).

Rough scope for awareness only:
- Phone UX testing and polish
- "Revert to previous image" option
- Cache busting for new image URLs
- Responsive image quality tuning
- Error recovery improvements

---

## How to Work (from CLAUDE.md)

This project uses a 3-phase workflow: **Design → Execution → Review**. Read CLAUDE.md's "Development Workflow" section for full details. The key points:

- **Phase 1:** Discuss the design, ask clarifying questions, get sign-off
- **Phase 2:** Spawn Sonnet subagents for implementation tasks
- **Phase 3:** Review changes, update CURRENT_STATE.md, report summary

The perspective warp is a single-component change (only `BoardImageUpdateView.jsx`), so it could potentially be done as a single subagent task or split into two (warp algorithm + UI integration) depending on cognitive scope.

---

## Session 1 Lessons Learned

Things that came up during Session 1 that are relevant:

1. **`capture="environment"` on file input forces camera on iOS** — we removed it so users can pick from gallery too. Don't add it back.
2. **Supabase Storage bucket must exist with correct RLS policies** — bucket `board-images` is already set up. Don't recreate.
3. **The CropStep component uses `lastTouchTimeRef` correctly** — follow the same pattern for AlignStep's pin dragging.
4. **Canvas operations are synchronous and fast** — the warp algorithm should run in the main thread. If it's slow on phone, reduce mesh density.
5. **Hold Manager SVG scaling was a separate issue** — it's been fixed and is unrelated to this feature. Don't touch BoardSetupView.jsx.
