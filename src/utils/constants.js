export const V_GRADES = [
  'VB', 'V0-', 'V0', 'V0+', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6',
  'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15',
];

export const FONT_GRADES = [
  '3', '3+', '4', '4+', '5', '5+',
  '6A', '6A+', '6B', '6B+', '6C', '6C+',
  '7A', '7A+', '7B', '7B+', '7C', '7C+',
  '8A', '8A+', '8B', '8B+', '8C',
];

export const HOLD_TYPES = [
  'Crimps', 'Slopers', 'Pinches', 'Jugs', 'Mini jug',
  'Pockets', 'Edges', 'Undercuts', 'Volumes', 'Jibs', 'Macro',
];

// Physical hold color name → display hex (for dots/indicators)
export const HOLD_COLOR_DOT = {
  black: '#444', blue: '#0047FF', purple: '#c084fc', green: '#22a870',
  orange: '#FF8C00', yellow: '#D4A000', pink: '#FF69B4', red: '#FF5252', white: '#888',
  cyan: '#22d3ee', grey: '#999', wood: '#b08860',
};

export const MATERIALS = ['Wood', 'PU', 'Fibreglass', 'Dual-tex'];

// Map hold-level singular types → route-level plural types
export const HOLD_TYPE_SINGULAR_TO_PLURAL = {
  'Jug': 'Jugs', 'Mini Jug': 'Mini jug', 'Crimp': 'Crimps', 'Half Crimp': 'Crimps',
  'Pinch': 'Pinches', 'Sloper': 'Slopers', 'Edge': 'Edges',
  'Pocket': 'Pockets', 'Undercut': 'Undercuts', 'Volume': 'Volumes', 'Macro': 'Macro',
};

export const TECHNIQUES = [
  'Heel hooks', 'Toe hooks', 'Dynos',
  'Drop knee', 'Bat hang', 'Campus',
];

export const STYLES = [
  'Power', 'Technical', 'Endurance',
];

export const SELECTION_MODES = {
  START:     'start',
  HAND:      'hand',
  FOOT:      'foot',
  HAND_ONLY: 'handOnly',
  FINISH:    'finish',
};

export const MODE_COLORS = {
  [SELECTION_MODES.HAND]: '#0047FF',
  [SELECTION_MODES.HAND_ONLY]: '#c084fc',
  [SELECTION_MODES.START]: '#22a870',
  [SELECTION_MODES.FINISH]: '#FF5252',
  [SELECTION_MODES.FOOT]: '#D4A000',
};

export const MODE_LABELS = {
  [SELECTION_MODES.HAND]: 'Hold',
  [SELECTION_MODES.HAND_ONLY]: 'Hand only',
  [SELECTION_MODES.START]: 'Start',
  [SELECTION_MODES.FINISH]: 'Finish',
  [SELECTION_MODES.FOOT]: 'Foot only',
};

// ─── Grade Conversion (Rockfax Bouldering Chart) ────────────────────
// Bi-directional lookup between V-Grade and Font grade systems.
// Source: Rockfax.com bouldering grade conversion poster.
// Each row: [Font grade, V-Grade]
// Where a V-Grade spans two Font grades, both rows map to that V-Grade.
export const GRADE_CONVERSION = [
  ['3',   'VB'],
  ['3+',  'V0-'],
  ['4',   'V0'],
  ['4+',  'V0+'],
  ['5',   'V1'],
  ['5+',  'V2'],
  ['6A',  'V3'],
  ['6A+', 'V3'],
  ['6B',  'V4'],
  ['6B+', 'V4'],
  ['6C',  'V5'],
  ['6C+', 'V5'],
  ['7A',  'V6'],
  ['7A+', 'V7'],
  ['7B',  'V8'],
  ['7B+', 'V9'],
  ['7C',  'V10'],
  ['7C+', 'V11'],
  ['8A',  'V12'],
  ['8A+', 'V13'],
  ['8B',  'V14'],
  ['8B+', 'V15'],
  ['8C',  'V15'],
];

// Build lookup maps: V→Font and Font→V (uses first match for many-to-one)
export const V_TO_FONT = {};
export const FONT_TO_V = {};
GRADE_CONVERSION.forEach(([f, v]) => {
  if (!V_TO_FONT[v]) V_TO_FONT[v] = f;   // first Font for this V (e.g. V3→6A, V4→6B)
  if (!FONT_TO_V[f]) FONT_TO_V[f] = v;   // first V for this Font
});

/** Convert a grade string from one system to the other */
export function convertGrade(grade, fromSystem, toSystem) {
  if (fromSystem === toSystem) return grade;
  if (fromSystem === 'V') return V_TO_FONT[grade] || grade;
  return FONT_TO_V[grade] || grade;
}

/**
 * Extract YouTube video ID from various URL formats:
 * https://www.youtube.com/watch?v=abc123
 * https://youtu.be/abc123
 * https://youtube.com/shorts/abc123
 * https://www.youtube.com/embed/abc123
 */
export function getYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

export function getYouTubeThumbnail(url) {
  const id = getYouTubeId(url);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

export const BOARD_SPECS = {
  widthM: 4.8,
  heightM: 4.5,
  hingeOffConcreteM: 0.6,
  hingeOffMattingM: 0.3,
  minAngle: 18,
  maxAngle: 55,
};
