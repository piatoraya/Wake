import fs from 'node:fs/promises';
import path from 'node:path';

function dataDir() {
  return path.resolve(process.env.DATA_DIR || './data');
}

function settingsFile() {
  return path.join(dataDir(), 'web_settings.json');
}

const DEFAULTS = { domain: '' };

export async function getWebSettings() {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[WEB_SETTINGS] gagal baca:', err.message);
    return { ...DEFAULTS };
  }
}

export async function setWebSettings(patch) {
  const current = await getWebSettings();
  const next = { ...current, ...patch };
  // normalisasi domain: trim, hapus trailing slash
  if (typeof next.domain === 'string') {
    next.domain = next.domain.trim().replace(/\/+$/, '');
  }
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

export function normalizeDomain(input) {
  const v = String(input || '').trim();
  if (!v) return '';
  // terima "example.com" atau "https://example.com"
  let url;
  try {
    url = new URL(v.includes('://') ? v : `https://${v}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  return `${url.protocol}//${url.host}`;
}