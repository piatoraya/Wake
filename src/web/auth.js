import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { readCollection, withCollection } from '../config/database.js';
import { addAuditLog } from './audit.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30m';
const REFRESH_EXPIRES = process.env.REFRESH_EXPIRES || '7d';

export const ROLES = { OWNER: 'owner', ADMIN: 'admin' };

export function getAdminUsers() {
  return readCollection('admin_users');
}

export async function findAdminByUsername(username) {
  const users = await readCollection('admin_users');
  return users.find((u) => u.username === username && u.is_active !== false) || null;
}

export async function findAdminById(id) {
  const users = await readCollection('admin_users');
  return users.find((u) => u.id === id) || null;
}

export async function seedDefaultAdmins() {
  const users = await readCollection('admin_users');
  if (users.length > 0) return users;
  const ownerUser = process.env.WEB_OWNER_USERNAME || 'owner';
  const ownerPass = process.env.WEB_OWNER_PASSWORD || 'owner123';
  const adminUser = process.env.WEB_ADMIN_USERNAME || 'admin';
  const adminPass = process.env.WEB_ADMIN_PASSWORD || 'admin123';
  const now = new Date().toISOString();
  const seeded = [
    {
      id: crypto.randomUUID(),
      username: ownerUser,
      password_hash: await bcrypt.hash(ownerPass, 12),
      role: ROLES.OWNER,
      name: 'Owner',
      email: '',
      is_active: true,
      created_at: now,
    },
    {
      id: crypto.randomUUID(),
      username: adminUser,
      password_hash: await bcrypt.hash(adminPass, 12),
      role: ROLES.ADMIN,
      name: 'Admin Operasional',
      email: '',
      is_active: true,
      created_at: now,
    },
  ];
  await withCollection('admin_users', (list) => {
    list.push(...seeded);
  });
  console.log(`[WEB] Seed admin users: ${ownerUser} (owner), ${adminUser} (admin). Ganti password di .env!`);
  return seeded;
}

export async function createAdminUser({ username, password, role, name, email }) {
  return withCollection('admin_users', async (list) => {
    if (list.some((u) => u.username === username)) throw new Error('Username sudah dipakai');
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      username,
      password_hash: await bcrypt.hash(password, 12),
      role: role === ROLES.OWNER ? ROLES.OWNER : ROLES.ADMIN,
      name: name || username,
      email: email || '',
      is_active: true,
      created_at: now,
      last_login: null,
    };
    list.push(user);
    return stripPassword(user);
  });
}

export async function updateAdminUser(id, fields) {
  return withCollection('admin_users', async (list) => {
    const u = list.find((x) => x.id === id);
    if (!u) return null;
    if (fields.username) u.username = fields.username;
    if (fields.password) u.password_hash = await bcrypt.hash(fields.password, 12);
    if (fields.role) u.role = fields.role === ROLES.OWNER ? ROLES.OWNER : ROLES.ADMIN;
    if (fields.name !== undefined) u.name = fields.name;
    if (fields.email !== undefined) u.email = fields.email;
    if (fields.is_active !== undefined) u.is_active = !!fields.is_active;
    return stripPassword(u);
  });
}

export async function deleteAdminUser(id) {
  return withCollection('admin_users', (list) => {
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    return true;
  });
}

export function stripPassword(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

export async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password_hash);
}

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function signRefreshToken(user) {
  return jwt.sign({ sub: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_EXPIRES });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const token = req.cookies?.access_token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Login diperlukan' } });
  req.user = payload;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Akses ditolak' } });
    }
    next();
  };
}

export function isOwner(user) {
  return user?.role === ROLES.OWNER;
}
