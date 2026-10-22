import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getUser, listUsers, withCollection } from '../config/database.js';
import { canCreateBotInstance } from './quota.js';

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export async function listInstances(ownerPhone = null) {
  const users = await listUsers();
  const out = [];
  for (const u of users) {
    if (ownerPhone && u.phone !== ownerPhone) continue;
    for (const inst of u.active_bot_instances || []) {
      out.push({ ...inst, owner_phone: u.phone, owner_name: u.name });
    }
  }
  return out;
}

export async function createInstance(ownerPhone, name) {
  const user = await getUser(ownerPhone);
  if (!user) throw new Error('User tidak ditemukan');
  const check = canCreateBotInstance(user);
  if (!check.allowed) throw new Error(check.reason);

  const slug = slugify(name);
  if (!slug) throw new Error('Nama bot tidak valid');

  const all = await listInstances();
  if (all.some((i) => i.slug === slug)) throw new Error('Nama bot sudah dipakai');

  const sessionDir = `baileys_auth_${slug}`;
  await fs.mkdir(path.resolve(sessionDir), { recursive: true });

  const meta = {
    bot_id: crypto.randomUUID(),
    name: name.trim(),
    slug,
    session_dir: sessionDir,
    phone: '',
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

export async function getInstance(botId) {
  const all = await listInstances();
  return all.find((i) => i.bot_id === botId) || null;
}

export async function deleteInstance(ownerPhone, botId, isAdmin = false) {
  let targetUser = null;
  let instance = null;
  const users = await listUsers();
  for (const u of users) {
    const inst = (u.active_bot_instances || []).find((i) => i.bot_id === botId);
    if (inst) { targetUser = u; instance = inst; break; }
  }
  if (!instance) throw new Error('Instance tidak ditemukan');
  if (!isAdmin && targetUser.phone !== ownerPhone) throw new Error('Tidak berhak menghapus instance ini');

  await withCollection('users', (list) => {
    const u = list.find((x) => x.phone === targetUser.phone);
    if (!u) return;
    u.active_bot_instances = (u.active_bot_instances || []).filter((i) => i.bot_id !== botId);
    u.updated_at = new Date().toISOString();
  });

  // hapus folder sesi (best effort)
  try {
    await fs.rm(path.resolve(instance.session_dir), { recursive: true, force: true });
  } catch { /* ignore */ }

  return instance;
}