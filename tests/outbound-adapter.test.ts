import { strict as assert } from 'assert';
import { clearQuotaCache } from '../src/features/quota-manager.js';
import { createQQBotOutboundAdapter } from '../src/outbound-adapter.js';

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

async function main() {
  clearQuotaCache();

  await test('createQQBotOutboundAdapter: 创建适配器', () => {
    const adapter = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: () => false,
      shouldTreatDeliveredTextAsVisible: ({ kind }) => kind !== 'final',
      preferFinalAssistantVisibleText: true,
    });
    
    assert(adapter !== undefined);
    assert(typeof adapter.sendTextWithQuota === 'function');
    assert(typeof adapter.sendMediaWithQuota === 'function');
    assert(typeof adapter.canSendTyping === 'function');
  });

  await test('shouldSuppressLocalPayloadPrompt: 审批 payload 抑制', () => {
    const adapter = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: ({ payload }) => (payload as { type?: string })?.type === 'approval',
      shouldTreatDeliveredTextAsVisible: () => true,
      preferFinalAssistantVisibleText: true,
    });
    
    assert(adapter.shouldSuppressLocalPayloadPrompt({ payload: { type: 'approval' } }) === true);
    assert(adapter.shouldSuppressLocalPayloadPrompt({ payload: { type: 'text' } }) === false);
  });

  await test('shouldTreatDeliveredTextAsVisible: 文本可见性判断', () => {
    const adapter = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: () => false,
      shouldTreatDeliveredTextAsVisible: ({ kind }) => kind !== 'hidden',
      preferFinalAssistantVisibleText: true,
    });
    
    assert(adapter.shouldTreatDeliveredTextAsVisible({ kind: 'text' }) === true);
    assert(adapter.shouldTreatDeliveredTextAsVisible({ kind: 'hidden' }) === false);
  });

  await test('preferFinalAssistantVisibleText: 配置值传递', () => {
    const adapter1 = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: () => false,
      shouldTreatDeliveredTextAsVisible: () => true,
      preferFinalAssistantVisibleText: true,
    });
    assert(adapter1.preferFinalAssistantVisibleText === true);
    
    const adapter2 = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: () => false,
      shouldTreatDeliveredTextAsVisible: () => true,
      preferFinalAssistantVisibleText: false,
    });
    assert(adapter2.preferFinalAssistantVisibleText === false);
  });

  console.log('All outbound adapter tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
