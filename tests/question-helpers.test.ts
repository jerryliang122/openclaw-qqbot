/**
 * question-helpers 单元测试
 */
import { strict as assert } from 'node:assert';
import {
  buildQuestionKeyboard,
  parseQuestionButtonData,
  isAskUserPayload,
} from '../src/features/question-helpers.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

console.log('\n=== 1. isAskUserPayload ===');

test('有效单问题 payload -> true', () => {
  const payload = {
    channelData: {
      askUser: {
        questionId: 'ask_0123456789abcdef0123456789abcdef',
        optionValues: ['Yes', 'No'],
      },
    },
  };
  assert.equal(isAskUserPayload(payload), true);
});

test('4 个选项 -> true', () => {
  const payload = {
    channelData: {
      askUser: {
        questionId: 'ask_0123456789abcdef0123456789abcdef',
        optionValues: ['A', 'B', 'C', 'D'],
      },
    },
  };
  assert.equal(isAskUserPayload(payload), true);
});

test('缺少 channelData -> false', () => {
  assert.equal(isAskUserPayload({}), false);
});

test('缺少 askUser -> false', () => {
  assert.equal(isAskUserPayload({ channelData: {} }), false);
});

test('questionId 格式错误 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: { askUser: { questionId: 'bad_id', optionValues: ['A', 'B'] } },
    }),
    false,
  );
});

test('只有 1 个选项 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: {
        askUser: {
          questionId: 'ask_0123456789abcdef0123456789abcdef',
          optionValues: ['Only'],
        },
      },
    }),
    false,
  );
});

test('5 个选项 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: {
        askUser: {
          questionId: 'ask_0123456789abcdef0123456789abcdef',
          optionValues: ['A', 'B', 'C', 'D', 'E'],
        },
      },
    }),
    false,
  );
});

test('optionValues 非数组 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: {
        askUser: {
          questionId: 'ask_0123456789abcdef0123456789abcdef',
          optionValues: 'not-array',
        },
      },
    }),
    false,
  );
});

console.log('\n=== 2. buildQuestionKeyboard ===');

test('构建 2 个按钮', () => {
  const keyboard = buildQuestionKeyboard(
    'ask_0123456789abcdef0123456789abcdef',
    ['Yes', 'No'],
  );
  assert.ok(keyboard.content);
  assert.equal(keyboard.content.rows.length, 1);
  assert.equal(keyboard.content.rows[0].buttons.length, 2);

  const [btn1, btn2] = keyboard.content.rows[0].buttons;
  assert.equal(btn1.id, 'q0');
  assert.equal(btn1.render_data?.label, 'Yes');
  assert.equal(btn1.render_data?.visited_label, '已回答');
  assert.equal(btn1.render_data?.style, 1);
  assert.equal(btn1.action?.type, 1);
  assert.equal(btn1.action?.data, 'qqbot:q:ask_0123456789abcdef0123456789abcdef:0');
  assert.equal(btn1.action?.permission?.type, 2);
  assert.equal(btn1.action?.click_limit, 1);
  assert.equal(btn1.group_id, 'question');

  assert.equal(btn2.id, 'q1');
  assert.equal(btn2.render_data?.label, 'No');
  assert.equal(btn2.action?.data, 'qqbot:q:ask_0123456789abcdef0123456789abcdef:1');
});

test('构建 4 个按钮', () => {
  const keyboard = buildQuestionKeyboard(
    'ask_abcdef0123456789abcdef0123456789',
    ['Staging', 'Production', 'Cancel', 'Skip'],
  );
  assert.equal(keyboard.content!.rows[0].buttons.length, 4);
  assert.equal(
    keyboard.content!.rows[0].buttons[3].action?.data,
    'qqbot:q:ask_abcdef0123456789abcdef0123456789:3',
  );
});

console.log('\n=== 3. parseQuestionButtonData ===');

test('有效 button_data -> 解析成功', () => {
  const result = parseQuestionButtonData(
    'qqbot:q:ask_0123456789abcdef0123456789abcdef:0',
  );
  assert.ok(result);
  assert.equal(result.questionId, 'ask_0123456789abcdef0123456789abcdef');
  assert.equal(result.optionIndex, 0);
});

test('optionIndex=3 -> 解析成功', () => {
  const result = parseQuestionButtonData(
    'qqbot:q:ask_0123456789abcdef0123456789abcdef:3',
  );
  assert.ok(result);
  assert.equal(result.optionIndex, 3);
});

test('非 qqbot:q: 前缀 -> null', () => {
  assert.equal(parseQuestionButtonData('approve:v2:exec:xxx:allow-once'), null);
});

test('缺少 optionIndex -> null', () => {
  assert.equal(
    parseQuestionButtonData('qqbot:q:ask_0123456789abcdef0123456789abcdef'),
    null,
  );
});

test('questionId 格式错误 -> null', () => {
  assert.equal(parseQuestionButtonData('qqbot:q:bad_id:0'), null);
});

test('optionIndex 超出范围 -> null', () => {
  assert.equal(
    parseQuestionButtonData('qqbot:q:ask_0123456789abcdef0123456789abcdef:4'),
    null,
  );
});

test('optionIndex 为负数 -> null', () => {
  assert.equal(
    parseQuestionButtonData('qqbot:q:ask_0123456789abcdef0123456789abcdef:-1'),
    null,
  );
});

test('round-trip: buildQuestionKeyboard -> parseQuestionButtonData', () => {
  const questionId = 'ask_0123456789abcdef0123456789abcdef';
  const keyboard = buildQuestionKeyboard(questionId, ['A', 'B', 'C']);
  for (let i = 0; i < 3; i++) {
    const data = keyboard.content!.rows[0].buttons[i].action!.data!;
    const parsed = parseQuestionButtonData(data);
    assert.ok(parsed);
    assert.equal(parsed.questionId, questionId);
    assert.equal(parsed.optionIndex, i);
  }
});

console.log('\n==================================================');
const failed = process.exitCode ?? 0;
console.log(`测试结果: ${failed === 0 ? '全部通过' : `${failed} 个失败`}`);
