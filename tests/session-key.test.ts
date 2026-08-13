/**
 * Session Key 生成测试
 *
 * 验证框架级并发控制的关键：session key 生成逻辑。
 * session key 决定了哪些消息会被串行处理。
 *
 * 运行方式: npx tsx tests/session-key.test.ts
 */
import assert from 'node:assert';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// ── Session Key 生成逻辑（从 dispatch.ts:64 提取）──────────────────

function generateSessionKey(params: {
  accountId: string;
  chatScope: 'direct' | 'group';
  senderId: string;
  groupId?: string;
}): string {
  const { accountId, chatScope, senderId, groupId } = params;
  
  // 对应 dispatch.ts:61-62
  const peerId = chatScope === 'group' 
    ? (groupId ?? senderId) 
    : senderId;
  
  // 对应 dispatch.ts:64
  return `qqbot:${accountId}:${peerId}`;
}

// ── 测试开始 ──────────────────────────────────────────

group('私聊场景');

test('私聊应该使用用户 openid 作为 peerId', () => {
  const sessionKey = generateSessionKey({
    accountId: 'default',
    chatScope: 'direct',
    senderId: 'USER_OPENID_123',
  });
  
  assert.strictEqual(sessionKey, 'qqbot:default:USER_OPENID_123',
    '私聊 session key 应该包含用户 openid');
});

test('私聊不应该包含 groupId', () => {
  const sessionKey = generateSessionKey({
    accountId: 'default',
    chatScope: 'direct',
    senderId: 'USER_OPENID_456',
    groupId: 'GROUP_OPENID_789', // 应该被忽略
  });
  
  assert.strictEqual(sessionKey, 'qqbot:default:USER_OPENID_456',
    '私聊 session key 应该忽略 groupId 参数');
});

test('不同用户的 session key 应该不同', () => {
  const key1 = generateSessionKey({
    accountId: 'default',
    chatScope: 'direct',
    senderId: 'USER_A',
  });
  
  const key2 = generateSessionKey({
    accountId: 'default',
    chatScope: 'direct',
    senderId: 'USER_B',
  });
  
  assert.notStrictEqual(key1, key2,
    '不同用户的 session key 应该不同，确保并发隔离');
});

group('群聊场景');

test('群聊应该使用群 openid 作为 peerId', () => {
  const sessionKey = generateSessionKey({
    accountId: 'default',
    chatScope: 'group',
    senderId: 'USER_OPENID_123',
    groupId: 'GROUP_OPENID_456',
  });
  
  assert.strictEqual(sessionKey, 'qqbot:default:GROUP_OPENID_456',
    '群聊 session key 应该包含群 openid');
});

test('群聊缺少 groupId 时应该降级使用 senderId', () => {
  const sessionKey = generateSessionKey({
    accountId: 'default',
    chatScope: 'group',
    senderId: 'USER_OPENID_123',
    // groupId 缺失
  });
  
  assert.strictEqual(sessionKey, 'qqbot:default:USER_OPENID_123',
    '群聊缺少 groupId 时应该降级使用 senderId');
});

test('同一个群的不同用户应该共享 session key', () => {
  const user1Key = generateSessionKey({
    accountId: 'default',
    chatScope: 'group',
    senderId: 'USER_A',
    groupId: 'GROUP_123',
  });
  
  const user2Key = generateSessionKey({
    accountId: 'default',
    chatScope: 'group',
    senderId: 'USER_B',
    groupId: 'GROUP_123', // 同一个群
  });
  
  assert.strictEqual(user1Key, user2Key,
    '同一个群的不同用户应该共享 session key，确保群消息串行处理');
});

test('不同群的 session key 应该不同', () => {
  const group1Key = generateSessionKey({
    accountId: 'default',
    chatScope: 'group',
    senderId: 'USER_A',
    groupId: 'GROUP_1',
  });
  
  const group2Key = generateSessionKey({
    accountId: 'default',
    chatScope: 'group',
    senderId: 'USER_A',
    groupId: 'GROUP_2',
  });
  
  assert.notStrictEqual(group1Key, group2Key,
    '不同群的 session key 应该不同，确保群间并发');
});

group('多账户场景');

test('不同账户的私聊应该隔离', () => {
  const account1Key = generateSessionKey({
    accountId: 'default',
    chatScope: 'direct',
    senderId: 'USER_123',
  });
  
  const account2Key = generateSessionKey({
    accountId: 'bot2',
    chatScope: 'direct',
    senderId: 'USER_123', // 同一个用户
  });
  
  assert.notStrictEqual(account1Key, account2Key,
    '不同账户的私聊应该隔离，确保多机器人并发');
});

test('不同账户的群聊应该隔离', () => {
  const account1Key = generateSessionKey({
    accountId: 'default',
    chatScope: 'group',
    senderId: 'USER_123',
    groupId: 'GROUP_456',
  });
  
  const account2Key = generateSessionKey({
    accountId: 'bot2',
    chatScope: 'group',
    senderId: 'USER_123',
    groupId: 'GROUP_456', // 同一个群
  });
  
  assert.notStrictEqual(account1Key, account2Key,
    '不同账户的群聊应该隔离，确保多机器人并发');
});

group('格式验证');

test('session key 格式应该符合规范', () => {
  const sessionKey = generateSessionKey({
    accountId: 'default',
    chatScope: 'direct',
    senderId: 'USER_123',
  });
  
  const parts = sessionKey.split(':');
  assert.strictEqual(parts.length, 3, 'session key 应该有 3 个部分');
  assert.strictEqual(parts[0], 'qqbot', '第一部分应该是 qqbot');
  assert.strictEqual(parts[1], 'default', '第二部分应该是 accountId');
  assert.strictEqual(parts[2], 'USER_123', '第三部分应该是 peerId');
});

test('session key 不应该包含特殊字符', () => {
  const sessionKey = generateSessionKey({
    accountId: 'default',
    chatScope: 'direct',
    senderId: 'USER_123',
  });
  
  const validPattern = /^qqbot:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/;
  assert.ok(validPattern.test(sessionKey),
    'session key 应该只包含字母、数字、下划线和连字符');
});

// ── 输出测试结果 ──────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);

if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach(name => console.log(`  - ${name}`));
  process.exit(1);
} else {
  console.log('\n✅ 所有测试通过！');
  process.exit(0);
}
