import { useState, useRef, useEffect, useCallback } from 'react';

// ─── Image helpers ────────────────────────────────────────────────────────────

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function resizeToBlob(sourceCanvas, targetWidth, quality) {
  if (sourceCanvas.width <= targetWidth) {
    return canvasToBlob(sourceCanvas, quality);
  }
  const scale = targetWidth / sourceCanvas.width;
  const c = document.createElement('canvas');
  c.width = targetWidth;
  c.height = Math.round(sourceCanvas.height * scale);
  c.getContext('2d').drawImage(sourceCanvas, 0, 0, c.width, c.height);
  return new Promise(resolve => c.toBlob(resolve, 'image/jpeg', quality));
}

const MAX_IMAGE_WIDTH = 2000;
const JPEG_QUALITY = 0.85;

// ─── Auto-increment name helper ───────────────────────────────────────────────

function autoIncrementName(name) {
  // Match _V followed by digits at the end of the string
  const match = name.match(/^(.*_V)(\d+)$/);
  if (match) {
    return match[1] + (parseInt(match[2], 10) + 1);
  }
  // No version pattern — append _V2
  return name + '_V2';
}

// ─── Crop step component ──────────────────────────────────────────────────────

function CropStep({ imageDataUrl, imageWidth, imageHeight, onNext, onBack }) {
  const containerRef = useRef(null);
  const lastTouchTimeRef = useRef(0);

  // Crop rect in image-pixel coordinates
  const initCrop = useCallback((iw, ih) => ({
    x: Math.round(iw * 0.05),
    y: Math.round(ih * 0.05),
    w: Math.round(iw * 0.90),
    h: Math.round(ih * 0.90),
  }), []);

  const [crop, setCrop] = useState(() => initCrop(imageWidth, imageHeight));
  const [displayScale, setDisplayScale] = useState(1);

  // Recalculate display scale when container resizes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setDisplayScale(rect.width / imageWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [imageWidth]);

  // Drag state tracked via ref to avoid stale closures
  const dragRef = useRef(null); // { type: 'move'|corner, startX, startY, startCrop }

  const getEventPos = (e) => {
    if (e.touches) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  };

  const toImageCoords = (clientX, clientY) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / displayScale,
      y: (clientY - rect.top) / displayScale,
    };
  };

  const clampCrop = (c, iw, ih) => {
    const x = Math.max(0, Math.min(c.x, iw - 10));
    const y = Math.max(0, Math.min(c.y, ih - 10));
    const w = Math.max(10, Math.min(c.w, iw - x));
    const h = Math.max(10, Math.min(c.h, ih - y));
    return { x, y, w, h };
  };

  const handleMoveStart = (e, type) => {
    if (e.touches) {
      lastTouchTimeRef.current = Date.now();
      e.stopPropagation();
    } else {
      if (Date.now() - lastTouchTimeRef.current < 500) return;
    }
    const pos = getEventPos(e);
    dragRef.current = { type, startX: pos.x, startY: pos.y, startCrop: { ...crop } };
  };

  const handleMoveMove = useCallback((e) => {
    if (!dragRef.current) return;
    const pos = getEventPos(e);
    const dx = (pos.x - dragRef.current.startX) / displayScale;
    const dy = (pos.y - dragRef.current.startY) / displayScale;
    const sc = dragRef.current.startCrop;

    let next;
    switch (dragRef.current.type) {
      case 'move':
        next = { x: sc.x + dx, y: sc.y + dy, w: sc.w, h: sc.h };
        break;
      case 'tl':
        next = { x: sc.x + dx, y: sc.y + dy, w: sc.w - dx, h: sc.h - dy };
        break;
      case 'tr':
        next = { x: sc.x, y: sc.y + dy, w: sc.w + dx, h: sc.h - dy };
        break;
      case 'bl':
        next = { x: sc.x + dx, y: sc.y, w: sc.w - dx, h: sc.h + dy };
        break;
      case 'br':
        next = { x: sc.x, y: sc.y, w: sc.w + dx, h: sc.h + dy };
        break;
      default:
        return;
    }
    setCrop(clampCrop(next, imageWidth, imageHeight));
  }, [displayScale, imageWidth, imageHeight]);

  const handleMoveEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMoveMove);
    window.addEventListener('mouseup', handleMoveEnd);
    window.addEventListener('touchmove', handleMoveMove, { passive: false });
    window.addEventListener('touchend', handleMoveEnd);
    return () => {
      window.removeEventListener('mousemove', handleMoveMove);
      window.removeEventListener('mouseup', handleMoveEnd);
      window.removeEventListener('touchmove', handleMoveMove);
      window.removeEventListener('touchend', handleMoveEnd);
    };
  }, [handleMoveMove, handleMoveEnd]);

  const handleApplyCrop = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(crop.w);
    canvas.height = Math.round(crop.h);
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      onNext(canvas);
    };
    img.src = imageDataUrl;
  };

  // Display coordinates (pixels on screen)
  const dx = crop.x * displayScale;
  const dy = crop.y * displayScale;
  const dw = crop.w * displayScale;
  const dh = crop.h * displayScale;

  const HANDLE_SIZE = 22; // half of 44px

  const cornerHandles = [
    { key: 'tl', cx: dx, cy: dy },
    { key: 'tr', cx: dx + dw, cy: dy },
    { key: 'bl', cx: dx, cy: dy + dh },
    { key: 'br', cx: dx + dw, cy: dy + dh },
  ];

  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
        Drag the corners or the rectangle to set the crop area.
      </p>

      {/* Image + crop overlay */}
      <div
        ref={containerRef}
        style={{ position: 'relative', width: '100%', userSelect: 'none', touchAction: 'none' }}
      >
        <img
          src={imageDataUrl}
          alt="Upload preview"
          style={{ display: 'block', width: '100%', height: 'auto' }}
          draggable={false}
        />

        {/* Dim overlay — 4 rectangles around the crop */}
        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          viewBox={`0 0 ${imageWidth * displayScale} ${imageHeight * displayScale}`}
          preserveAspectRatio="none"
        >
          {/* Top */}
          <rect x={0} y={0} width={imageWidth * displayScale} height={dy} fill="rgba(0,0,0,0.5)" />
          {/* Bottom */}
          <rect x={0} y={dy + dh} width={imageWidth * displayScale} height={imageHeight * displayScale - dy - dh} fill="rgba(0,0,0,0.5)" />
          {/* Left */}
          <rect x={0} y={dy} width={dx} height={dh} fill="rgba(0,0,0,0.5)" />
          {/* Right */}
          <rect x={dx + dw} y={dy} width={imageWidth * displayScale - dx - dw} height={dh} fill="rgba(0,0,0,0.5)" />
          {/* Crop border */}
          <rect x={dx} y={dy} width={dw} height={dh} fill="none" stroke="white" strokeWidth="2" />
        </svg>

        {/* Draggable body of the crop rect */}
        <div
          onMouseDown={(e) => handleMoveStart(e, 'move')}
          onTouchStart={(e) => handleMoveStart(e, 'move')}
          style={{
            position: 'absolute',
            left: dx, top: dy, width: dw, height: dh,
            cursor: 'move',
            touchAction: 'none',
          }}
        />

        {/* Corner handles */}
        {cornerHandles.map(({ key, cx, cy }) => (
          <div
            key={key}
            onMouseDown={(e) => { e.stopPropagation(); handleMoveStart(e, key); }}
            onTouchStart={(e) => { e.stopPropagation(); handleMoveStart(e, key); }}
            style={{
              position: 'absolute',
              left: cx - HANDLE_SIZE,
              top: cy - HANDLE_SIZE,
              width: HANDLE_SIZE * 2,
              height: HANDLE_SIZE * 2,
              cursor: key === 'tl' || key === 'br' ? 'nwse-resize' : 'nesw-resize',
              touchAction: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: 'white',
              boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
              border: '2px solid #0047FF',
            }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
        <button onClick={onBack} style={secondaryBtnStyle}>← Back</button>
        <button onClick={handleApplyCrop} style={{ ...primaryBtnStyle, flex: 1 }}>
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Shared button styles ─────────────────────────────────────────────────────

const primaryBtnStyle = {
  padding: '13px 20px',
  borderRadius: '12px',
  fontSize: '15px',
  fontWeight: 700,
  cursor: 'pointer',
  border: 'none',
  background: '#0047FF',
  color: '#fff',
  fontFamily: 'DM Sans, sans-serif',
};

const secondaryBtnStyle = {
  padding: '13px 20px',
  borderRadius: '12px',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
  border: '1px solid rgba(26,10,0,0.15)',
  background: 'rgba(26,10,0,0.06)',
  color: '#1A0A00',
  fontFamily: 'DM Sans, sans-serif',
};

// ─── Main wizard component ────────────────────────────────────────────────────

export default function BoardImageUpdateView({ currentImgSrc, currentImageName, onSave, onCancel }) {
  const [step, setStep] = useState('upload'); // 'upload' | 'crop' | 'confirm'

  // Upload step state
  const [uploadedDataUrl, setUploadedDataUrl] = useState(null);
  const [uploadedWidth, setUploadedWidth] = useState(0);
  const [uploadedHeight, setUploadedHeight] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Crop step state (canvas stored for confirm)
  const [croppedCanvas, setCroppedCanvas] = useState(null);

  // Confirm step state
  const [imageName, setImageName] = useState(() => autoIncrementName(currentImageName || 'Barn_Set_01_V5'));
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const stepLabels = { upload: 'Step 1 of 3 — Upload', crop: 'Step 2 of 3 — Crop', confirm: 'Step 3 of 3 — Confirm' };

  // ── Upload step handlers ──────────────────────────────────────────────────

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth;
      let h = img.naturalHeight;

      const canvas = document.createElement('canvas');
      if (w > MAX_IMAGE_WIDTH) {
        const scale = MAX_IMAGE_WIDTH / w;
        w = MAX_IMAGE_WIDTH;
        h = Math.round(h * scale);
      }
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);

      setUploadedWidth(w);
      setUploadedHeight(h);
      setUploadedDataUrl(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      setUploading(false);
    };
    img.onerror = () => { URL.revokeObjectURL(url); setUploading(false); };
    img.src = url;
    // Reset file input so the same file can be re-selected
    e.target.value = '';
  };

  // ── Confirm step handlers ──────────────────────────────────────────────────

  const validateName = (name) => {
    if (!name.trim()) return 'Name cannot be empty';
    if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) return 'Only letters, numbers, underscores, and hyphens allowed';
    return '';
  };

  const handleNameChange = (e) => {
    const val = e.target.value;
    setImageName(val);
    setNameError(validateName(val));
  };

  const handleSave = async () => {
    const err = validateName(imageName);
    if (err) { setNameError(err); return; }
    setSaving(true);
    setSaveError('');
    try {
      const full = await canvasToBlob(croppedCanvas, JPEG_QUALITY);
      const w2000 = await resizeToBlob(croppedCanvas, 2000, JPEG_QUALITY);
      const w1200 = await resizeToBlob(croppedCanvas, 1200, JPEG_QUALITY);
      const w800 = await resizeToBlob(croppedCanvas, 800, JPEG_QUALITY);
      await onSave({ imageName: imageName.trim(), imageBlobs: { full, w2000, w1200, w800 } });
    } catch (err) {
      console.error('[BoardImageUpdate] Save failed:', err);
      setSaveError('Upload failed. Please check your connection and try again.');
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '16px 12px', maxWidth: '480px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>
          Update Board Image
        </h2>
        <button
          onClick={onCancel}
          style={{
            padding: '5px 12px', borderRadius: '8px', fontSize: '11px', cursor: 'pointer',
            border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)',
            color: '#1A0A00', fontFamily: 'DM Sans, sans-serif',
          }}
        >
          Cancel
        </button>
      </div>

      {/* Step indicator */}
      <div style={{
        marginBottom: '20px',
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '1px',
        textTransform: 'uppercase',
        color: '#0047FF',
        fontFamily: 'Space Mono, monospace',
      }}>
        {stepLabels[step]}
      </div>

      {/* ── Step 1: Upload ── */}
      {step === 'upload' && (
        <div>
          <p style={{ margin: '0 0 16px', fontSize: '14px', color: '#1A0A00', lineHeight: 1.5 }}>
            Take a photo of the board or choose one from your gallery.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              ...primaryBtnStyle,
              width: '100%',
              marginBottom: '12px',
              opacity: uploading ? 0.6 : 1,
            }}
          >
            {uploading ? 'Loading…' : '📷 Choose / Take Photo'}
          </button>

          {/* Preview */}
          {uploadedDataUrl && (
            <div style={{ marginBottom: '16px' }}>
              <img
                src={uploadedDataUrl}
                alt="Uploaded preview"
                style={{ width: '100%', borderRadius: '10px', display: 'block', border: '1px solid rgba(26,10,0,0.12)' }}
              />
              <div style={{
                marginTop: '6px', fontSize: '11px', color: 'rgba(26,10,0,0.45)',
                textAlign: 'center', fontFamily: 'Space Mono, monospace',
              }}>
                {uploadedWidth} × {uploadedHeight}px
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={onCancel} style={secondaryBtnStyle}>Cancel</button>
            <button
              onClick={() => setStep('crop')}
              disabled={!uploadedDataUrl}
              style={{
                ...primaryBtnStyle,
                flex: 1,
                opacity: uploadedDataUrl ? 1 : 0.4,
                cursor: uploadedDataUrl ? 'pointer' : 'not-allowed',
              }}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Crop ── */}
      {step === 'crop' && uploadedDataUrl && (
        <CropStep
          imageDataUrl={uploadedDataUrl}
          imageWidth={uploadedWidth}
          imageHeight={uploadedHeight}
          onNext={(canvas) => { setCroppedCanvas(canvas); setStep('confirm'); }}
          onBack={() => setStep('upload')}
        />
      )}

      {/* ── Step 3: Confirm ── */}
      {step === 'confirm' && croppedCanvas && (
        <div>
          {/* Side-by-side comparison */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '20px' }}>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(26,10,0,0.45)', marginBottom: '6px', textAlign: 'center', fontFamily: 'Space Mono, monospace' }}>
                Current
              </div>
              <img
                src={currentImgSrc}
                alt="Current board"
                style={{ width: '100%', borderRadius: '8px', display: 'block', border: '1px solid rgba(26,10,0,0.12)' }}
              />
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: '#0047FF', marginBottom: '6px', textAlign: 'center', fontFamily: 'Space Mono, monospace' }}>
                New
              </div>
              <img
                src={croppedCanvas.toDataURL('image/jpeg', JPEG_QUALITY)}
                alt="New board"
                style={{ width: '100%', borderRadius: '8px', display: 'block', border: '2px solid #0047FF' }}
              />
            </div>
          </div>

          {/* Name input */}
          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block', marginBottom: '6px',
              fontSize: '11px', fontWeight: 700, letterSpacing: '1px',
              textTransform: 'uppercase', color: 'rgba(26,10,0,0.55)',
              fontFamily: 'Space Mono, monospace',
            }}>
              Image Name
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
              <input
                type="text"
                value={imageName}
                onChange={handleNameChange}
                style={{
                  flex: 1,
                  padding: '11px 12px',
                  borderRadius: '10px 0 0 10px',
                  border: nameError ? '2px solid #ef4444' : '1px solid rgba(26,10,0,0.2)',
                  background: '#fff',
                  fontSize: '14px',
                  color: '#1A0A00',
                  fontFamily: 'Space Mono, monospace',
                  outline: 'none',
                }}
                placeholder="Barn_Set_01_V6"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <div style={{
                padding: '11px 12px',
                borderRadius: '0 10px 10px 0',
                border: '1px solid rgba(26,10,0,0.2)',
                borderLeft: 'none',
                background: 'rgba(26,10,0,0.04)',
                fontSize: '14px',
                color: 'rgba(26,10,0,0.45)',
                fontFamily: 'Space Mono, monospace',
                whiteSpace: 'nowrap',
              }}>
                .jpg
              </div>
            </div>
            {nameError && (
              <div style={{ marginTop: '5px', fontSize: '12px', color: '#ef4444' }}>{nameError}</div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => { setStep('crop'); setSaveError(''); }} style={secondaryBtnStyle} disabled={saving}>
              ← Back
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !!nameError || !imageName.trim()}
              style={{
                ...primaryBtnStyle,
                flex: 1,
                opacity: (saving || !!nameError || !imageName.trim()) ? 0.5 : 1,
                cursor: (saving || !!nameError || !imageName.trim()) ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {saveError && (
            <div style={{ marginTop: '10px', padding: '10px', borderRadius: '8px', background: '#fef2f2', color: '#dc2626', fontSize: '13px' }}>
              {saveError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
