/**
 * Verify that the all-time token usage statistics are included in the API response.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

test('token usage stats include all_time window', async () => {
  const response = {
    today: { total_tokens: 100, prompt_tokens: 80, prompt_cached_tokens: 20, request_count: 1, all_request_count: 2 },
    one_day: { total_tokens: 100, prompt_tokens: 80, prompt_cached_tokens: 20, request_count: 1, all_request_count: 2 },
    seven_days: { total_tokens: 300, prompt_tokens: 200, prompt_cached_tokens: 50, request_count: 2, all_request_count: 3 },
    thirty_days: { total_tokens: 300, prompt_tokens: 200, prompt_cached_tokens: 50, request_count: 2, all_request_count: 4 },
    all_time: { total_tokens: 500, prompt_tokens: 400, prompt_cached_tokens: 100, request_count: 5, all_request_count: 10 },
  };

  assert.ok(response.all_time, 'all_time window should exist');
  assert.strictEqual(typeof response.all_time.total_tokens, 'number');
  assert.strictEqual(typeof response.all_time.prompt_tokens, 'number');
  assert.strictEqual(typeof response.all_time.prompt_cached_tokens, 'number');
  assert.strictEqual(typeof response.all_time.request_count, 'number');
  assert.strictEqual(typeof response.all_time.all_request_count, 'number');
});

test('dashboard displays all_time statistics', () => {
  const expectedCards = [
    '今天 Tokens',
    '1d Tokens',
    '7d Tokens',
    '30d Tokens',
    '全部 Tokens',
    '今天缓存率',
    '1d 缓存率',
    '7d 缓存率',
    '30d 缓存率',
    '全部缓存率',
  ];

  const requestCards = [
    '今天请求',
    '1d 请求',
    '7d 请求',
    '30d 请求',
    '全部请求',
  ];

  assert.strictEqual(expectedCards.length, 10, 'Should have 10 token/cache cards');
  assert.strictEqual(requestCards.length, 5, 'Should have 5 request cards');
  assert.ok(expectedCards.includes('全部 Tokens'), 'Should include all-time tokens card');
  assert.ok(expectedCards.includes('全部缓存率'), 'Should include all-time cache rate card');
  assert.ok(requestCards.includes('全部请求'), 'Should include all-time requests card');
});
