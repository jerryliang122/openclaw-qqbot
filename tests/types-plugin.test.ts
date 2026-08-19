import { strict as assert } from 'assert';
import type { QQBotProbe, QQBotAudit, QQBotSessionRoute, QuotaState } from '../src/types-plugin.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

test('QQBotProbe type exists', () => {
  const probe: QQBotProbe = { ok: true, bot: { id: '123', username: 'test' } };
  assert(probe.ok === true);
});

test('QQBotAudit type exists', () => {
  const audit: QQBotAudit = { ok: true, checkedGroups: 5, unresolvedGroups: 0 };
  assert(audit.ok === true);
});

test('QQBotSessionRoute type exists', () => {
  const route: QQBotSessionRoute = {
    to: 'qqbot:c2c:user123',
    chatType: 'direct',
    sessionKey: 'session-1',
    baseSessionKey: 'session-1',
  };
  assert(route.chatType === 'direct');
});

test('QuotaState type exists', () => {
  const state: QuotaState = { count: 2, expiresAt: Date.now() + 3600000 };
  assert(state.count === 2);
});

console.log('All type definition tests passed');
