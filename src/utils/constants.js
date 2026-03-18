export const V_GRADES = [
  'VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6',
  'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16',
];

export const FONT_GRADES = [
  '3', '4', '4+', '5', '5+',
  '6A', '6A+', '6B', '6B+', '6C', '6C+',
  '7A', '7A+', '7B', '7B+', '7C', '7C+',
  '8A', '8A+', '8B', '8B+',
];

export const HOLD_TYPES = [
  'Crimps', 'Slopers', 'Pinches', 'Jugs', 'Mini jug',
  'Pockets', 'Edges', 'Volumes', 'Jibs', 'Macro',
];

export const TECHNIQUES = [
  'Heel hooks', 'Toe hooks', 'Compression', 'Dynos',
  'Body tension', 'Flagging', 'Drop knee', 'Bat hang', 'Campus',
];

export const STYLES = [
  'Powerful', 'Technical', 'Endurance', 'Dynamic',
  'Static', 'Balancey', 'Reachy', 'Morpho',
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

export const BOARD_SPECS = {
  widthM: 4.8,
  heightM: 4.5,
  hingeOffConcreteM: 0.6,
  hingeOffMattingM: 0.3,
  minAngle: 18,
  maxAngle: 55,
};
