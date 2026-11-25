import assert from 'node:assert/strict'
import test from 'node:test'

import { scoreThread } from '../src/score.ts'
import { buildThreads } from '../src/thread.ts'
import type { IntelMessage } from '../src/types.ts'

function message(id: string, timestamp: number, text: string): IntelMessage {
  return {
    id,
    chatId: 'g1',
    senderId: 'u1',
    senderName: 'Alice',
    timestamp,
    text,
  }
}

test('a thread with a link and entity scores higher than plain chatter', () => {
  const linked = buildThreads([
    message('1', 1000, 'Docker 部署 PostgreSQL 失败'),
    message('2', 1010, '教程 https://example.com/guide'),
  ], { entities: ['Docker', 'PostgreSQL'] })[0]
  const plain = buildThreads([
    message('3', 2000, '今天天气不错'),
    message('4', 2010, '是啊挺好的'),
  ])[0]
  assert.ok(scoreThread(linked).score > scoreThread(plain).score)
  assert.equal(scoreThread(linked).keep, true)
})
