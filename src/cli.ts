import { parseArgs } from 'node:util'

import { buildIntelDb, getIntelDbStats, queryIntelDb, readMessageContext } from './db.ts'
import { searchMessages } from './search.ts'
import { buildIndex, loadIndex, saveIndex } from './store.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: 'string' },
    out: { type: 'string' },
    db: { type: 'string' },
    names: { type: 'string' },
    config: { type: 'string' },
    'x-dir': { type: 'string' },
    'stats-out': { type: 'string' },
    source: { type: 'string', default: 'all' },
    chat: { type: 'string' },
    sender: { type: 'string' },
    index: { type: 'string' },
    days: { type: 'string', default: '30' },
    limit: { type: 'string', default: '20' },
    entities: { type: 'string' },
    'min-score': { type: 'string', default: '0.35' },
    json: { type: 'boolean', default: false },
  },
})

const command = positionals[0]
const json = Boolean(values.json)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (command === 'index') {
  if (!values.input || !values.out)
    fail('usage: telegram-search-mcp index --input <jsonl-dir> --out <threads.json>')
  const entities = values.entities
    ? values.entities.split(',').map(value => value.trim()).filter(Boolean)
    : undefined
  const index = await buildIndex(values.input, {
    entities,
    minScore: Number(values['min-score']),
  })
  await saveIndex(index, values.out)
  console.log(JSON.stringify({
    inputMessages: index.inputMessages,
    threadCount: index.threadCount,
    dedupedCount: index.dedupedCount,
    keptCount: index.keptCount,
  }, null, 2))
}
else if (command === 'build-db') {
  if (!values.db || !values.input)
    fail('usage: telegram-search-mcp build-db --db <intel.db> --input <jsonl-dir> [--names <sender-names.json>] [--config <config.json>] [--x-dir <x-dir>] [--stats-out <stats.json>]')
  const stats = buildIntelDb({
    dbPath: values.db,
    exportDir: values.input,
    senderNamesPath: values.names,
    xDir: values['x-dir'],
    statsOutPath: values['stats-out'],
    configPath: values.config,
  })
  console.log(JSON.stringify(stats, null, 2))
}
else if (command === 'query-db') {
  const query = positionals.slice(1).join(' ')
  if (!query || !values.db)
    fail('usage: telegram-search-mcp query-db <query> --db <intel.db> [--source all|tg|x] [--chat <chat>] [--sender <sender>] [--days 0] [--limit 25]')
  const res = queryIntelDb(values.db, {
    query,
    source: values.source as 'all' | 'tg' | 'x',
    chat: values.chat,
    sender: values.sender,
    days: values.days ? Number(values.days) : 0,
    limit: Number(values.limit),
  })
  console.log(JSON.stringify(res, null, 2))
}
else if (command === 'context') {
  const chatId = positionals[1]
  const messageId = positionals[2]
  if (!chatId || !messageId || !values.db)
    fail('usage: telegram-search-mcp context <chat_id> <message_id> --db <intel.db>')
  console.log(JSON.stringify(readMessageContext(values.db, { chat_id: chatId, message_id: messageId }), null, 2))
}
else if (command === 'db-stats') {
  if (!values.db)
    fail('usage: telegram-search-mcp db-stats --db <intel.db>')
  console.log(JSON.stringify(getIntelDbStats(values.db), null, 2))
}
else if (command === 'search') {
  const query = positionals.slice(1).join(' ')
  if (!query || !values.index)
    fail('usage: telegram-search-mcp search <query> --index <threads.json> [--days 30] [--limit 20]')
  const index = await loadIndex(values.index)
  const hits = searchMessages(index.items, query, {
    days: Number(values.days),
    limit: Number(values.limit),
  })
  if (json) {
    console.log(JSON.stringify(hits, null, 2))
  }
  else {
    for (const hit of hits) {
      const date = new Date(hit.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
      console.log(`${date}  ${hit.chatId}/${hit.messageId}  ${hit.text.replace(/\s+/g, ' ').slice(0, 160)}`)
    }
    if (!hits.length)
      console.log('no matches')
  }
}
else if (command === 'read') {
  const threadId = positionals[1]
  if (!threadId || !values.index)
    fail('usage: telegram-search-mcp read <thread_id> --index <threads.json>')
  const index = await loadIndex(values.index)
  const thread = index.items.find(item => item.id === threadId)
  if (!thread)
    fail(`thread not found: ${threadId}`)
  if (json) {
    console.log(JSON.stringify(thread, null, 2))
  }
  else {
    console.log(`thread ${thread.id}  ${thread.messageCount} messages  ${thread.startedAt}..${thread.endedAt}`)
    for (const message of thread.messages) {
      const date = new Date(message.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
      console.log(`[${message.id}] ${date} ${message.senderName}: ${message.text.replace(/\s+/g, ' ')}`)
    }
  }
}
else if (command === 'stats') {
  if (!values.index)
    fail('usage: telegram-search-mcp stats --index <threads.json>')
  const index = await loadIndex(values.index)
  let first = Infinity
  let last = -Infinity
  for (const thread of index.items) {
    first = Math.min(first, thread.startedAt)
    last = Math.max(last, thread.endedAt)
  }
  const stats = {
    inputMessages: index.inputMessages,
    threadCount: index.threadCount,
    dedupedCount: index.dedupedCount,
    keptCount: index.keptCount,
    from: index.items.length ? new Date(first * 1000).toISOString() : null,
    to: index.items.length ? new Date(last * 1000).toISOString() : null,
  }
  console.log(JSON.stringify(stats, null, 2))
}
else {
  console.log(`telegram-search-mcp

  build-db  --db <intel.db> --input <jsonl-dir> [--names <sender-names.json>] [--config <config.json>] [--x-dir <x-dir>]
  query-db  <query> --db <intel.db> [--source all|tg|x] [--chat <chat>] [--days 0] [--limit 25]
  context   <chat_id> <message_id> --db <intel.db>
  db-stats  --db <intel.db>
  index   --input <jsonl-dir> --out <threads.json>
  search  <query> --index <threads.json> [--days 30] [--limit 20] [--json]
  read    <thread_id> --index <threads.json> [--json]
  stats   --index <threads.json>`)
}
