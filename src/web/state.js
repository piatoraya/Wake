// State bersama untuk status bot (di-update oleh proses bot bila web terintegrasi).
export const botState = {
  status: 'offline', // offline | connecting | online | reconnecting
  phone: '',
  method: '',
  version: '',
  uptimeStart: null,
  lastError: '',
  gemini: null,
};

export function setBotState(patch) {
  Object.assign(botState, patch);
  if (patch.status === 'online' && !botState.uptimeStart) botState.uptimeStart = Date.now();
  if (patch.status === 'offline') botState.uptimeStart = null;
}

export function getBotUptime() {
  if (!botState.uptimeStart) return 0;
  return Math.floor((Date.now() - botState.uptimeStart) / 1000);
}
