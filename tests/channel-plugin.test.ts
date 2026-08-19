/**
 * Integration test for qqbotPlugin
 * 
 * Verifies that the plugin has all required adapters
 */

import assert from 'node:assert';
import { qqbotPlugin } from '../src/channel.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

console.log('\n=== Channel Plugin Integration Tests ===\n');

test('qqbotPlugin is defined', () => {
  assert.ok(qqbotPlugin, 'qqbotPlugin should be defined');
});

test('qqbotPlugin has base property', () => {
  assert.ok(qqbotPlugin.base, 'qqbotPlugin should have base property');
});

const base = qqbotPlugin.base;

test('base has config adapter', () => {
  assert.ok(base.config, 'base should have config adapter');
  assert.ok(typeof base.config.listAccountIds === 'function', 'config should have listAccountIds');
  assert.ok(typeof base.config.resolveAccount === 'function', 'config should have resolveAccount');
  assert.ok(typeof base.config.defaultAccountId === 'function', 'config should have defaultAccountId');
  assert.ok(typeof base.config.isConfigured === 'function', 'config should have isConfigured');
  assert.ok(typeof base.config.describeAccount === 'function', 'config should have describeAccount');
  assert.ok(typeof base.config.setAccountEnabled === 'function', 'config should have setAccountEnabled');
  assert.ok(typeof base.config.deleteAccount === 'function', 'config should have deleteAccount');
});

test('base has message adapter', () => {
  assert.ok(base.message, 'base should have message adapter');
});

test('base has messaging adapter', () => {
  assert.ok(base.messaging, 'base should have messaging adapter');
});

test('base has status adapter', () => {
  assert.ok(base.status, 'base should have status adapter');
});

test('base has gateway adapter', () => {
  assert.ok(base.gateway, 'base should have gateway adapter');
});

test('base has outbound adapter', () => {
  assert.ok(base.outbound, 'base should have outbound adapter');
  assert.ok(typeof base.outbound.sendTextWithQuota === 'function', 'outbound should have sendTextWithQuota');
  assert.ok(typeof base.outbound.sendMediaWithQuota === 'function', 'outbound should have sendMediaWithQuota');
  assert.ok(typeof base.outbound.canSendTyping === 'function', 'outbound should have canSendTyping');
});

test('base has agentPrompt adapter', () => {
  assert.ok(base.agentPrompt, 'base should have agentPrompt adapter');
});

test('base has heartbeat adapter', () => {
  assert.ok(base.heartbeat, 'base should have heartbeat adapter');
});

test('base has threading adapter', () => {
  assert.ok(base.threading, 'base should have threading adapter');
});

test('base has groups adapter', () => {
  assert.ok(base.groups, 'base should have groups adapter');
  assert.ok(typeof base.groups.resolveRequireMention === 'function', 'groups should have resolveRequireMention');
  assert.ok(typeof base.groups.resolveToolPolicy === 'function', 'groups should have resolveToolPolicy');
});

test('base has mentions adapter', () => {
  assert.ok(base.mentions, 'base should have mentions adapter');
  assert.ok(typeof base.mentions.stripMentions === 'function', 'mentions should have stripMentions');
});

test('base has setup adapter', () => {
  assert.ok(base.setup, 'base should have setup adapter');
  assert.ok(typeof base.setup.resolveAccountId === 'function', 'setup should have resolveAccountId');
  assert.ok(typeof base.setup.applyAccountName === 'function', 'setup should have applyAccountName');
  assert.ok(typeof base.setup.validateInput === 'function', 'setup should have validateInput');
  assert.ok(typeof base.setup.applyAccountConfig === 'function', 'setup should have applyAccountConfig');
});

test('base has setupWizard', () => {
  assert.ok(base.setupWizard, 'base should have setupWizard');
});

test('base has auth adapter', () => {
  assert.ok(base.auth, 'base should have auth adapter');
  assert.ok(base.auth.login, 'auth should have login');
});

test('base has onboarding adapter', () => {
  assert.ok(base.onboarding, 'base should have onboarding adapter');
});

test('outbound adapter has deliveryMode', () => {
  assert.ok(base.outbound.deliveryMode, 'outbound should have deliveryMode');
  assert.strictEqual(base.outbound.deliveryMode, 'direct', 'deliveryMode should be direct');
});

test('outbound adapter has shouldSuppressLocalPayloadPrompt', () => {
  assert.ok(typeof base.outbound.shouldSuppressLocalPayloadPrompt === 'function', 
    'outbound should have shouldSuppressLocalPayloadPrompt');
});

test('outbound adapter has shouldTreatDeliveredTextAsVisible', () => {
  assert.ok(typeof base.outbound.shouldTreatDeliveredTextAsVisible === 'function', 
    'outbound should have shouldTreatDeliveredTextAsVisible');
});

test('outbound adapter has preferFinalAssistantVisibleText', () => {
  assert.ok(typeof base.outbound.preferFinalAssistantVisibleText === 'boolean', 
    'outbound should have preferFinalAssistantVisibleText');
});

console.log('\n✓ All tests passed!\n');
