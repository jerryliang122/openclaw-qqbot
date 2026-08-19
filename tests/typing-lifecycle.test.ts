import { strict as assert } from 'assert';
import {
  startTypingWithRenewal,
  stopTyping,
  cleanupAllTyping,
  isTypingActive,
} from '../src/typing-lifecycle.js';
import { clearQuotaCache, __test_getQuotaCache } from '../src/features/quota-manager.js';

function test(name: string, fn: () => Promise<void> | void) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => console.log(`✓ ${name}`)).catch((err) => {
        console.error(`✗ ${name}`);
        throw err;
      });
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

cleanupAllTyping();
clearQuotaCache();

let sendTypingCalls: Array<{ to: string; msgId?: string }> = [];
const mockSendTyping = async (params: { to: string; msgId?: string }) => {
  sendTypingCalls.push(params);
  return true;
};

await test('startTypingWithRenewal: 启动 typing with passive mode', async () => {
  cleanupAllTyping();
  clearQuotaCache();
  sendTypingCalls = [];

  const params = {
    accountId: 'test-account',
    to: 'qqbot:c2c:user123',
    replyToId: 'msg-1',
    sendTyping: mockSendTyping,
  };

  await startTypingWithRenewal(params);

  assert(sendTypingCalls.length === 1, 'Should call sendTyping once');
  assert(sendTypingCalls[0].msgId === 'msg-1', 'Should send with msgId in passive mode');
  assert(isTypingActive('test-account', 'msg-1') === true, 'Should be active');

  const cache = __test_getQuotaCache();
  const quotaKey = 'test-account:c2c:msg-1';
  const quotaState = cache.get(quotaKey);
  assert(quotaState?.count === 1, 'Should consume quota');
});

await test('startTypingWithRenewal: fallback to proactive mode when quota exhausted', async () => {
  cleanupAllTyping();
  clearQuotaCache();
  sendTypingCalls = [];

  const cache = __test_getQuotaCache();
  cache.set('test-account:c2c:msg-2', { count: 4, expiresAt: Date.now() + 60000 });

  const params = {
    accountId: 'test-account',
    to: 'qqbot:c2c:user456',
    replyToId: 'msg-2',
    sendTyping: mockSendTyping,
  };

  await startTypingWithRenewal(params);

  assert(sendTypingCalls.length === 1, 'Should call sendTyping once');
  assert(sendTypingCalls[0].msgId === undefined, 'Should fallback to proactive mode without msgId');
  assert(isTypingActive('test-account', 'msg-2') === true, 'Should still be active');
});

await test('stopTyping: 停止 typing', () => {
  cleanupAllTyping();

  const params = {
    accountId: 'test-account',
    to: 'qqbot:c2c:user123',
    replyToId: 'msg-3',
  };

  stopTyping(params);
  assert(isTypingActive('test-account', 'msg-3') === false, 'Should not be active');
});

await test('cleanupAllTyping: 清理所有 typing', () => {
  cleanupAllTyping();
  assert(isTypingActive('test-account', 'msg-1') === false);
});

console.log('All typing lifecycle tests passed');
