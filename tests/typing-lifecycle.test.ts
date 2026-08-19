import { strict as assert } from 'assert';
import {
  startTypingWithRenewal,
  stopTyping,
  cleanupAllTyping,
  isTypingActive,
} from '../src/typing-lifecycle.js';
import { clearQuotaCache } from '../src/features/quota-manager.js';

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

let sendTypingCallCount = 0;
const mockSendTyping = async () => {
  sendTypingCallCount++;
  return true;
};

await test('startTypingWithRenewal: 启动 typing', async () => {
  cleanupAllTyping();
  clearQuotaCache();
  sendTypingCallCount = 0;

  const params = {
    accountId: 'test-account',
    to: 'qqbot:c2c:user123',
    replyToId: 'msg-1',
    sendTyping: mockSendTyping,
  };

  await startTypingWithRenewal(params);

  assert(sendTypingCallCount === 1, 'Should call sendTyping once');
  assert(isTypingActive('test-account', 'msg-1') === true, 'Should be active');
});

await test('stopTyping: 停止 typing', () => {
  cleanupAllTyping();

  const params = {
    accountId: 'test-account',
    to: 'qqbot:c2c:user123',
    replyToId: 'msg-2',
  };

  stopTyping(params);
  assert(isTypingActive('test-account', 'msg-2') === false, 'Should not be active');
});

await test('cleanupAllTyping: 清理所有 typing', () => {
  cleanupAllTyping();
  assert(isTypingActive('test-account', 'msg-1') === false);
});

console.log('All typing lifecycle tests passed');
