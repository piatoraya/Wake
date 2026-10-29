import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';
import { getUser, listUsers, withCollection } from '../config/database.js';
import { canCreateBotInstance } from './features.js';
import qrcode from 'qrcode-terminal';

const sockets = new Map(); // botId -> { sock, phone, registered }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseVersion() {
  const v = process.env.WA_VERSION || '2,3000,1045101284';
  const arr = v.split(',').map((n) => Number(n.trim()));
  return arr.length === 3 && arr.every(Number.isFinite) ? arr : [2, 3000, 1045101284];
}

function parseBrowser() {
  const b = process.env.WA_BROWSER || 'Mac OS,Chrome,139.0.7258.164';
  const arr = b.split(',');
  return arr.length === 3 ? arr : Browsers.macOS('Chrome');
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

async function updateInstance(botId, patch) {
  await withCollection('users', (users) => {
    for (const u of users) {
      const inst = (u.active_bot_instances || []).find((i) => i.bot_id === botId);
      if (inst) {
        Object.assign(inst, patch, { updated_at: new Date().toISOString() });
        return;
      }
    }
  });
}

export async function listInstances(ownerPhone = null) {
  const users = await listUsers();
  const out = [];
  for (const u of users) {
    if (ownerPhone && u.phone !== ownerPhone) continue;
    for (const inst of u.active_bot_instances || []) {
      out.push({ ...inst, owner_phone: u.phone, owner_name: u.name, running: sockets.has(inst.bot_id) });
    }
  }
  return out;
}

export async function updateInstancePhone(botId, phone) {
  const cleanPhone = String(phone || '').trim();
  if (cleanPhone && !/^62\\d{8,13}$/.test(cleanPhone)) throw new Error('Nomor bot tidak valid (format 62...)');
  await updateInstance(botId, { phone: cleanPhone });
  const inst = await getInstance(botId);
  return inst;
}

export async function getInstance(botId) {
  const all = await listInstances();
  return all.find((i) => i.bot_id === botId) || null;
}

export async function createInstance(ownerPhone, name, phone = '', method = 'pairing') {
  const user = await getUser(ownerPhone);
  if (!user) throw new Error('User tidak ditemukan');
  const check = await canCreateBotInstance(user);
  if (!check.allowed) throw new Error(check.reason);

  const slug = slugify(name);
  if (!slug) throw new Error('Nama bot tidak valid');
  const cleanPhone = String(phone || '').trim();
  if (cleanPhone && !/^62\\d{8,13}$/.test(cleanPhone)) throw new Error('Nomor bot tidak valid (format 62...)');

  const all = await listInstances();
  if (all.some((i) => i.slug === slug)) throw new Error('Nama bot sudah dipakai');

  const sessionDir = path.join('sessions', `baileys_auth_${slug}`);
  await fs.mkdir(path.resolve(sessionDir), { recursive: true });

  const meta = {
    bot_id: crypto.randomUUID(),
    name: name.trim(),
    slug,
    session_dir: sessionDir,
    phone: cleanPhone,
    connection_method: method === 'qr' ? 'qr' : 'pairing',
    status: 'provisioned',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await withCollection('users', (users) => {
    const u = users.find((x) => x.phone === ownerPhone);
    if (!u) throw new Error('User tidak ditemukan');
    if (!Array.isArray(u.active_bot_instances)) u.active_bot_instances = [];
    u.active_bot_instances.push(meta);
    u.updated_at = new Date().toISOString();
  });

  return meta;
}

export async function deleteInstance(ownerPhone, botId, isAdmin = false) {
  const inst = await getInstance(botId);
  if (!inst) throw new Error('Instance tidak ditemukan');
  if (!isAdmin && inst.owner_phone !== ownerPhone) throw new Error('Tidak berhak menghapus instance ini');

  await stopInstance(botId);
  await withCollection('users', (users) => {
    const u = users.find((x) => x.phone === inst.owner_phone);
    if (!u) return;
    u.active_bot_instances = (u.active_bot_instances || []).filter((i) => i.bot_id !== botId);
    u.updated_at = new Date().toISOString();
  });

  try {
    await fs.rm(path.resolve(inst.session_dir), { recursive: true, force: true });
  } catch { /* ignore */ }

  return inst;
}

export async function startInstance(botId, method = null, force = false) {
  const inst = await getInstance(botId);
  if (!inst) throw new Error('Instance tidak ditemukan');

  const chosenMethod = method || inst.connection_method || process.env.CONNECTION_METHOD || 'pairing';
  if (sockets.has(botId) && !force) {
    const e = sockets.get(botId);
    if (e.method === chosenMethod) return { botId, status: 'already_running', method: chosenMethod };
    await stopInstance(botId);
  }
  if (sockets.has(botId) && force) {
    await stopInstance(botId);
  }

  await updateInstance(botId, { connection_method: chosenMethod, status: 'connecting', pairing_code: null, last_qr: null });

  const sessionDir = path.resolve(inst.session_dir);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    version: parseVersion(),
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: parseBrowser(),
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  const entry = { sock, phone: inst.phone, registered: Boolean(state.creds?.me?.id && state.creds?.account), method: chosenMethod, lastQr: null };
  sockets.set(botId, entry);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, isNewLogin, qr } = update;
    const e = sockets.get(botId);
    if (!e) return;

    if (qr && e.method === 'qr' && !e.registered) {
      e.lastQr = qr;
      // generate ASCII QR server-side as fallback (tidak bergantung library browser)
      let ascii = '';
      try {
        ascii = await new Promise((resolve) => {
          qrcode.generate(qr, { small: true }, (out) => resolve(out || ''));
        });
      } catch { ascii = ''; }
      await updateInstance(botId, { status: 'waiting_qr', last_qr: qr, last_qr_ascii: ascii });
    }

    if (isNewLogin) {
      await updateInstance(botId, { status: 'reconnecting' });
      const old = sock;
      setTimeout(async () => {
        try {
          await stopInstance(botId);
          await startInstance(botId);
        } catch { /* ignore */ }
        try { old?.end?.(); } catch { /* ignore */ }
      }, 1000);
      return;
    }

    if (connection === 'open') {
      e.registered = true;
      const phone = sock.user?.id ? String(sock.user.id).split('@')[0].split(':')[0] : e.phone;
      e.phone = phone;
      await updateInstance(botId, { status: 'connected', phone });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      await updateInstance(botId, { status: loggedOut ? 'logged_out' : 'disconnected', last_error: `code ${code ?? 'unknown'}` });
      if (loggedOut) {
        // bersihkan auth lama otomatis (seperti bot utama)
        try {
          const inst = await getInstance(botId);
          if (inst?.session_dir) {
            const dir = path.resolve(inst.session_dir);
            await fs.rm(dir, { recursive: true, force: true });
            await fs.mkdir(dir, { recursive: true });
          }
        } catch { /* ignore */ }
        await stopInstance(botId);
        await updateInstance(botId, { status: 'provisioned', pairing_code: null, last_qr: null, last_qr_ascii: null, last_error: null });
      } else {
        setTimeout(() => { startInstance(botId).catch(() => {}); }, 5000);
      }
    }
  });

  await updateInstance(botId, { status: entry.registered ? 'connected' : 'connecting' });

  // pairing code auto-request if not registered and method = pairing
  if (!entry.registered && chosenMethod === 'pairing') {
    const phone = entry.phone || inst.phone;
    if (phone) {
      setTimeout(async () => {
        try {
          const s = sockets.get(botId)?.sock;
          if (!s || s.user) return;
          let waited = 0;
          while (!s.ws?.isOpen && waited < 20000) { await sleep(100); waited += 100; }
          if (!s.ws?.isOpen) return;
          await sleep(1200);
          const code = await s.requestPairingCode(phone);
          await updateInstance(botId, { status: 'pairing', pairing_code: code, pairing_code_expires_at: new Date(Date.now() + 60000).toISOString() });
        } catch (err) {
          await updateInstance(botId, { status: 'error', last_error: err?.message || String(err) });
        }
      }, 1500);
    }
  }

  return { botId, status: entry.registered ? 'connected' : 'connecting' };
}

export async function resetAuth(botId) {
  await stopInstance(botId);
  const inst = await getInstance(botId);
  if (!inst) throw new Error('Instance tidak ditemukan');
  const dir = path.resolve(inst.session_dir);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  await fs.mkdir(dir, { recursive: true });
  await updateInstance(botId, { status: 'provisioned', pairing_code: null, last_qr: null, last_error: null });
  return { botId, status: 'provisioned' };
}

export async function stopInstance(botId) {
  const entry = sockets.get(botId);
  if (entry?.sock) {
    try { await entry.sock.end(); } catch { /* ignore */ }
  }
  sockets.delete(botId);
  await updateInstance(botId, { status: 'stopped', pairing_code: null });
  return { botId, status: 'stopped' };
}

export async function requestPairingCode(botId) {
  const inst = await getInstance(botId);
  if (!inst) throw new Error('Instance tidak ditemukan');
  const phone = inst.phone;
  if (!phone) throw new Error('Nomor bot belum diisi');
  let entry = sockets.get(botId);
  if (!entry) {
    await startInstance(botId);
    entry = sockets.get(botId);
  }
  const sock = entry?.sock;
  if (!sock) throw new Error('Socket belum siap');
  if (sock.user) return { botId, code: null, status: 'connected' };

  let waited = 0;
  while (!sock.ws?.isOpen && waited < 20000) { await sleep(100); waited += 100; }
  if (!sock.ws?.isOpen) throw new Error('WebSocket belum terbuka');
  await sleep(1200);
  const code = await sock.requestPairingCode(phone);
  await updateInstance(botId, { status: 'pairing', pairing_code: code, pairing_code_expires_at: new Date(Date.now() + 60000).toISOString() });
  return { botId, code, status: 'pairing' };
}

export function isRunning(botId) {
  return sockets.has(botId);
}

export async function getQrInfo(botId) {
  const inst = await getInstance(botId);
  return { qr: inst?.last_qr || null, ascii: inst?.last_qr_ascii || null };
}

export function getInstanceMethod(botId) {
  return sockets.get(botId)?.method || null;
}