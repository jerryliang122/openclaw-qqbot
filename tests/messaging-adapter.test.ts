import { strict as assert } from 'assert';
import { qqbotMessagingAdapter } from '../src/messaging-adapter.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

console.log('\n=== Messaging Adapter Tests ===\n');

test('resolveInboundConversation: C2C 消息保存完整目标', () => {
  const result = qqbotMessagingAdapter.resolveInboundConversation({
    to: 'qqbot:c2c:user123',
  });

  assert.ok(result, 'Should return result');
  assert.strictEqual(result.conversationId, 'qqbot:c2c:user123', 'Should preserve full target');
  assert.strictEqual(result.parentConversationId, 'qqbot:c2c:user123', 'Should preserve full target');
});

test('resolveInboundConversation: 群聊消息保存完整目标', () => {
  const result = qqbotMessagingAdapter.resolveInboundConversation({
    to: 'qqbot:group:group456',
  });

  assert.ok(result, 'Should return result');
  assert.strictEqual(result.conversationId, 'qqbot:group:group456', 'Should preserve full target');
  assert.strictEqual(result.parentConversationId, 'qqbot:group:group456', 'Should preserve full target');
});

test('resolveDeliveryTarget: 从 C2C conversationId 正确构建目标', () => {
  const result = qqbotMessagingAdapter.resolveDeliveryTarget({
    conversationId: 'qqbot:c2c:user123',
  });

  assert.ok(result, 'Should return result');
  assert.strictEqual(result.to, 'qqbot:c2c:user123', 'Should build correct target');
});

test('resolveDeliveryTarget: 从群聊 conversationId 正确构建目标', () => {
  const result = qqbotMessagingAdapter.resolveDeliveryTarget({
    conversationId: 'qqbot:group:group456',
  });

  assert.ok(result, 'Should return result');
  assert.strictEqual(result.to, 'qqbot:group:group456', 'Should build correct target');
});

test('resolveDeliveryTarget: 优先使用 parentConversationId', () => {
  const result = qqbotMessagingAdapter.resolveDeliveryTarget({
    conversationId: 'qqbot:c2c:user123',
    parentConversationId: 'qqbot:group:group789',
  });

  assert.ok(result, 'Should return result');
  assert.strictEqual(result.to, 'qqbot:group:group789', 'Should use parentConversationId');
});

test('resolveInboundConversation: 空目标返回 null', () => {
  const result = qqbotMessagingAdapter.resolveInboundConversation({
    to: '',
  });

  assert.strictEqual(result, null, 'Should return null for empty target');
});

test('resolveDeliveryTarget: 空目标返回 null', () => {
  const result = qqbotMessagingAdapter.resolveDeliveryTarget({
    conversationId: '',
  });

  assert.strictEqual(result, null, 'Should return null for empty conversationId');
});

console.log('\n✓ All messaging adapter tests passed!\n');
