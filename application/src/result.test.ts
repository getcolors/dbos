import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicResult } from './result.js';

test('result is deterministic and identifies retry count', () => {
  const a = deterministicResult('workflow-1', 'hello', 2);
  const b = deterministicResult('workflow-1', 'hello', 2);
  assert.deepEqual(a, b);
  assert.equal(a.result, '2a08363e37d548b19801ded9abe4872f80f6a428577f1e94b50079771cc9eae9');
  assert.equal(a.activityAttempts, 2);
});
