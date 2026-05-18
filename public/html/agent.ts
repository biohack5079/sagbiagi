export type GestureKey = 
  | 'wave' | 'nod' | 'joy' | 'jump' | 'dance' | 'shake_head' 
  | 'bow' | 'shrug' | 'surprised' | 'shy' | 'thinking' | 'tilt_head'
  | 'leftHandUp' | 'rightHandUp' | 'raise_hand' | 'leftHandDown' 
  | 'rightHandDown' | 'lower_hand' | 'reset';

export interface Message {
  id: string;
  text: string;
  isUser: boolean;
  senderName: string;
  image?: string;
  done?: boolean;
}

export const GESTURES: Record<string, any> = {
  wave: { bone: 'RightUpperArm', rot: [-1.2, 0, 1.2] },
  nod: { bone: 'Head', rot: [0.4, 0, 0] },
  joy: { action: 'jump' },
  jump: { action: 'jump' },
  dance: { action: 'dance' },
  shake_head: { action: 'shake_head' },
  bow: { bone: 'Head', rot: [0.6, 0, 0] },
  shrug: { action: 'shrug' },
  surprised: { action: 'surprised' },
  shy: { action: 'shy' },
  thinking: { bone: 'Head', rot: [0.2, 0.4, 0.2] },
  tilt_head: { bone: 'Head', rot: [0, 0, 0.3] },
  leftHandUp: { bones: ['LeftUpperArm'], rot: [0, 0, -1.4] },
  rightHandUp: { bones: ['RightUpperArm'], rot: [0, 0, 1.4] },
  raise_hand: { bones: ['RightUpperArm'], rot: [0, 0, 1.4] },
  leftHandDown: { bones: ['LeftUpperArm'], rot: [0, 0, 1.4] },
  rightHandDown: { bones: ['RightUpperArm'], rot: [0, 0, -1.4] },
  lower_hand: { pose: 'natural' },
  reset: { pose: 'natural' }
};