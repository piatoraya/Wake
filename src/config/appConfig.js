import fs from 'node:fs/promises';
import path from 'node:path';

function dataDir() {
  return path.resolve(process.env.DATA_DIR || './data');
}

function configFile() {
  return path.join(dataDir(), 'config.json');
}

const DEFAULTS = { footer: 'by: ampang dev', tier_enabled: false };

export async function getAppConfig() {
  try {
    const raw = await fs.readFile(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setFooter(footer) {
  return setAppConfig({ footer });
}

export async function setAppConfig(patch) {
  const current = await getAppConfig();
  const next = { ...current, ...patch };
  if (typeof next.footer === 'string') next.footer = next.footer.trim();
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

export async function getFooter() {
  const cfg = await getAppConfig();
  return cfg.footer || DEFAULTS.footer;
}