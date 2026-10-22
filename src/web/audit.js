import { readCollection, writeCollection, withCollection } from '../config/database.js';
import crypto from 'node:crypto';

export async function addAuditLog({ adminId, action, entity, entityId = null, before = null, after = null, ip = '', userAgent = '' }) {
  return withCollection('audit_logs', (logs) => {
    const entry = {
      id: crypto.randomUUID(),
      admin_id: adminId,
      action,
      entity,
      entity_id: entityId,
      before,
      after,
      ip,
      user_agent: userAgent,
      created_at: new Date().toISOString(),
    };
    logs.push(entry);
    // batasi 5000 entri terakhir
    if (logs.length > 5000) logs.splice(0, logs.length - 5000);
    return entry;
  });
}

export async function listAuditLogs({ limit = 100, offset = 0 } = {}) {
  const logs = await readCollection('audit_logs');
  const sorted = [...logs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { total: sorted.length, items: sorted.slice(offset, offset + limit) };
}
