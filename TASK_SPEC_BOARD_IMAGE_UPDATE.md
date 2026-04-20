# Task Spec: Phone-Based Board Image Update

*Feature: Replace the board photo from your phone, align it to the existing coordinate space, and manually add new holds via Hold Manager.*

**Safe rollback tag:** `v1.0-pre-image-update` (pushed to remote)

---

## Overview

### What This Feature Does
Lets the admin update the board photo entirely from their phone — upload, crop, perspective-align to the old image, save. All existing holds and routes remain intact because the new image is warped to match the old coordinate space. New holds are added manually via the existing Hold Manager.

### What This Feature Does NOT Touch
- The Python detection pipeline (`detect_holds.py`, `merge_holds.py`) — unchanged
- Hold IDs, hold data, route data — unchanged
- The three-layer hold data architecture — unchanged
- Any existing touch/SVG/coordinate handling — unchanged

---

## Session Plan

### Session 1: Upload + Crop + Save Pipeline
End state: Admin can upload a photo, crop it, rename it, and save it as the new board image. No perspective warp yet — useful for photos taken from a consistent position.

### Session 2: Perspective Warp
End state: A new step between crop and save lets the user drag 4 corner pins to align the new image to the old one via live perspective warp with transparency overlay.

### Session 3: Polish & Edge Cases
End state: Responsive image generation, phone UX refinements, error handling, testing.

---

## Shared Contracts (ALL tasks must use these exactly)

### Supabase Storage
- **Bucket name:** `board-images`
- **Public bucket** (anyone can read, only authenticated can upload)
- **File path pattern:** `{imageName}.jpg`, `{imageName}-800w.jpg`, `{imageName}-1200w.jpg`, `{imageName}-2000w.jpg`
- **Public URL pattern:** `{VITE_SUPABASE_URL}/storage/v1/object/public/board-images/{filename}`

### board_settings Key
- **Key:** `board_image_config`
- **Data shape:**
```json
{
  "imageName": "Barn_Set_01_V6",
  "baseUrl": "https://xxx.supabase.co/storage/v1/object/public/board-images",
  "updatedAt": "2026-04-12T..."
}
```
- App derives full URLs: `${baseUrl}/${imageName}.jpg`, `${baseUrl}/${imageName}-800w.jpg`, etc.
- When `board_image_config` is null/missing, fall back to existing `DEFAULT_BOARD_IMAGE` / `DEFAULT_BOARD_SRCSET` constants (the static files in `public/`)

### View State
- **View name:** `updateBoardImage`
- **Navigation:** `settings → updateBoardImage` (admin only)
- **Return:** wizard Cancel or completion → `settings`

### Component
- **File:** `src/components/BoardImageUpdateView.jsx`
- **Lazy-loaded** in App.jsx (same pattern as BoardSetupView)
- **Props from App.jsx:**
```js
{
  currentImgSrc,        // current board image URL (for alignment reference)
  currentImageName,     // e.g. "Barn_Set_01_V5" (for suggested naming)
  onSave,               // callback({ imageName, imageBlobs }) — App.jsx handles upload + board_settings update
  onCancel,             // callback() — returns to settings
}
```
- **onSave receives:**
```js
{
  imageName: "Barn_Set_01_V6",        // user-chosen name
  imageBlobs: {
    full: Blob,     // max 2000px wide, JPEG
    w2000: Blob,    // 2000px wide
    w1200: Blob,    // 1200px wide
    w800: Blob,     // 800px wide
  }
}
```
- **App.jsx handles** the Supabase Storage upload + board_settings update + state refresh. This keeps the wizard component pure (no Supabase dependency).

### Image Processing Constants
```js
const MAX_IMAGE_WIDTH = 2000;
const RESPONSIVE_WIDTHS = [2000, 1200, 800];
const JPEG_QUALITY = 0.85;
```

### Naming Convention
- Current images: `Barn_Set_01_V5`
- Wizard pre-fills with auto-incremented name: `Barn_Set_01_V6`
- User can edit the name freely
- Extension `.jpg` is always appended automatically (not editable)

---

## Session 1: Detailed Task Breakdown

### Task 1: Supabase Storage + Dynamic Image Loading
**Goal:** The app can load its board image from Supabase Storage URLs, with fallback to the existing static files.

**Files to modify:**
- `src/lib/supabase.js` — add helper to build storage URLs
- `src/App.jsx` — load `board_image_config` from board_settings, derive imgSrc/imgSrcSet/imgSizes from it, fall back to DEFAULT_* constants
- `src/components/BoardView.jsx` — remove hardcoded fallback `/Barn_Set_01_V5.jpg`, rely on props only
- `src/components/BoardSetupView.jsx` — same: remove hardcoded fallback
- `src/components/HoldEditorView.jsx` — same: remove hardcoded fallback
- `src/components/Settings.jsx` — remove the old manual image filename input UI (lines 19-44), replace with "Update Board Image" button that triggers the new view

**Supabase Storage bucket creation:**
- Add a one-time setup note in code comments, OR
- Create the bucket programmatically on first upload attempt using `supabase.storage.createBucket()` (with `{ public: true }`)

**Key logic in App.jsx:**
```js
// Load board_image_config from board_settings (same pattern as hold_overrides)
const [boardImageConfig, setBoardImageConfig] = useState(null);

// In the existing board_settings fetch effect, also fetch 'board_image_config'

// Derive image props:
const imgSrc = boardImageConfig
  ? `${boardImageConfig.baseUrl}/${boardImageConfig.imageName}.jpg`
  : DEFAULT_BOARD_IMAGE;
const imgSrcSet = boardImageConfig
  ? `${boardImageConfig.baseUrl}/${boardImageConfig.imageName}-800w.jpg 800w, ${boardImageConfig.baseUrl}/${boardImageConfig.imageName}-1200w.jpg 1200w, ${boardImageConfig.baseUrl}/${boardImageConfig.imageName}-2000w.jpg 2000w`
  : DEFAULT_BOARD_SRCSET;
const imgSizes = DEFAULT_BOARD_SIZES; // always '100vw'
```

**Verification:**
- App loads normally with no `board_image_config` in DB (fallback works)
- `npm run build` succeeds
- No visual changes to existing functionality

---

### Task 2: Wizard Component — Upload + Crop + Rename
**Goal:** New multi-step wizard component where admin can upload a photo, crop it, and name it.

**Files to create:**
- `src/components/BoardImageUpdateView.jsx` — the wizard

**Files to modify:**
- `src/App.jsx` — add view state, lazy import, navigation handlers, render block

**Wizard steps (internal state machine):**
```
upload → crop → confirm
```

**Step: Upload**
- File input accepting `image/*` with `capture="environment"` for camera
- On file select: load into canvas, downscale if wider than 2000px (maintain aspect ratio)
- Show preview of uploaded image
- "Next" button to proceed to crop

**Step: Crop**
- Show the uploaded image with a draggable/resizable crop rectangle overlay
- Crop rectangle has 4 corner handles + 4 edge handles (for resize)
- Touch-friendly handles (min 44px hit targets)
- "Crop to Board" button applies the crop → stores cropped canvas
- "Back" to return to upload

**Step: Confirm**
- Show cropped result alongside (or toggled with) the current board image
- Image name input field (pre-filled with auto-incremented name)
  - Parse current name, find version number, increment: `Barn_Set_01_V5` → `Barn_Set_01_V6`
  - If no version pattern detected, append `_V2`
  - Show `.jpg` suffix as non-editable label next to the input
- "Save" button → calls onSave with imageName + generated blobs
- "Back" to return to crop

**Image resize helper** (used in confirm step for responsive sizes):
```js
function resizeToWidth(canvas, targetWidth, quality = 0.85) {
  if (canvas.width <= targetWidth) {
    return new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  }
  const scale = targetWidth / canvas.width;
  const c = document.createElement('canvas');
  c.width = targetWidth;
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', quality));
}
```

**App.jsx integration:**
```js
// Lazy import
const BoardImageUpdateView = lazy(() => import('./components/BoardImageUpdateView'));

// Navigation
const handleUpdateBoardImage = () => setView('updateBoardImage');
const handleBoardImageCancel = () => setView('settings');

// Save handler
const handleBoardImageSave = async ({ imageName, imageBlobs }) => {
  // 1. Ensure bucket exists (createBucket is idempotent — 409 if exists, that's fine)
  await supabase.storage.createBucket('board-images', { public: true }).catch(() => {});

  // 2. Upload all sizes
  const baseUrl = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/board-images`;
  const uploads = [
    supabase.storage.from('board-images').upload(`${imageName}.jpg`, imageBlobs.full, { contentType: 'image/jpeg', upsert: true }),
    supabase.storage.from('board-images').upload(`${imageName}-2000w.jpg`, imageBlobs.w2000, { contentType: 'image/jpeg', upsert: true }),
    supabase.storage.from('board-images').upload(`${imageName}-1200w.jpg`, imageBlobs.w1200, { contentType: 'image/jpeg', upsert: true }),
    supabase.storage.from('board-images').upload(`${imageName}-800w.jpg`, imageBlobs.w800, { contentType: 'image/jpeg', upsert: true }),
  ];
  await Promise.all(uploads);

  // 3. Save config to board_settings
  const config = { imageName, baseUrl, updatedAt: new Date().toISOString() };
  await supabase.from('board_settings').upsert({ key: 'board_image_config', data: config });
  setBoardImageConfig(config);

  // 4. Return to settings
  setView('settings');
};

// Render (inside the view === 'updateBoardImage' block)
<BoardImageUpdateView
  currentImgSrc={imgSrc}
  currentImageName={boardImageConfig?.imageName || 'Barn_Set_01_V5'}
  onSave={handleBoardImageSave}
  onCancel={handleBoardImageCancel}
/>
```

**Settings.jsx changes:**
- Remove old image filename input (lines 19-44 in Settings.jsx)
- Add new prop: `onUpdateBoardImage` (callback to trigger the wizard)
- Add "Update Board Image" button (admin only) that calls `onUpdateBoardImage()`

**Styling:**
- Follow existing app style: peach background, white cards, dark text, DM Sans body, Space Mono headings
- Mobile-first, max-width 480px
- Touch-friendly controls (min 44px targets)

**Verification:**
- Can upload a photo from camera and gallery
- Photo is downscaled to max 2000px wide
- Crop rectangle is draggable and resizable on phone
- Name field auto-fills with incremented version
- `npm run build` succeeds

---

### Task 3: Save Pipeline + End-to-End Wiring
**Goal:** Saving actually uploads to Supabase Storage and the app reloads with the new image.

**This task is already mostly specified in Task 2's App.jsx integration section.** The reason it's a separate task: Task 2's subagent focuses on the wizard UI. Task 3's subagent focuses on:

1. **The upload + save logic in App.jsx** (handleBoardImageSave)
2. **Loading board_image_config on app startup** (in the existing board_settings fetch)
3. **Error handling** — upload failures show user-friendly message, don't leave app in broken state
4. **Loading state** — show spinner/progress during upload
5. **End-to-end testing** — verify the full flow works: upload → crop → name → save → image appears

**Files to modify:**
- `src/App.jsx` — handleBoardImageSave implementation, board_image_config loading in init effect, loading state
- `src/components/BoardImageUpdateView.jsx` — add loading/error states to confirm step, disable Save button during upload

**Key concern:** The board_image_config must be loaded during app initialization, alongside the existing board_settings fetches. Find the existing effect that loads `hold_overrides` and `custom_holds` from board_settings and add `board_image_config` to the same fetch.

**Verification:**
- Full flow: upload → crop → name → save → new image loads
- Refreshing the app loads the new image (not the old one)
- Other devices see the new image after tab switch (visibility refetch)
- If no board_image_config in DB, app still works with default static image
- `npm run build` succeeds

---

## Session 2: Perspective Warp (future — designed but not built in Session 1)

### Where It Fits
Inserted as a new step between Crop and Confirm in the wizard:
```
upload → crop → align → confirm
```

### Align Step Design
- **Background:** Current board image at adjustable transparency (slider, 0-100%)
- **Foreground:** Cropped new image, partially transparent
- **4 corner pins** (draggable, 44px+ touch targets) on the new image
- Pins default to the image corners
- User drags pins until the board edges in the new image align with the old image
- **Live warp preview** using canvas triangle-mesh perspective transform
- "Next" applies the final warp → outputs a corrected canvas that matches the old coordinate space

### Perspective Warp Algorithm (canvas triangle mesh)
1. Define source quad (4 corner pin positions on the new image)
2. Define destination quad (the 4 corners of the output canvas — i.e. the old image's board area)
3. Subdivide both quads into a triangle mesh (e.g. 10x10 grid = 200 triangles)
4. For each triangle: use canvas `setTransform()` with the affine matrix mapping source → dest triangle, `drawImage()` with clipping
5. Result: perspective-corrected image in the old coordinate space

This is a well-established technique. No WebGL needed.

---

## Session 3: Polish (future)

- Responsive image generation quality tuning
- Phone UX testing (iOS Safari, Android Chrome)
- Error recovery (partial upload failure, network interruption)
- Progress indicator during upload
- "Revert to previous image" option
- Confirm dialog before overwriting
- Cache busting for the new image URLs

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Breaking existing hold/route data | This feature ONLY changes the board image URL. Hold data, route data, coordinate systems are untouched. |
| Breaking BoardView/BoardSetupView rendering | Task 1 only changes where the image URL comes from, not how it's used. Same props, same rendering. |
| Supabase Storage permissions | Bucket is public-read, auth-write. Same auth the app already uses. |
| Large file uploads on mobile | Downscale to 2000px max before upload. JPEG at 0.85 quality ≈ 300-500KB. |
| Touch handling in crop UI | New component, no interaction with existing touch handlers. Self-contained. |
| Perspective warp (Session 2) | Deferred to its own session. Session 1 works without it. |
