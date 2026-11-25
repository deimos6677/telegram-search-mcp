import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface ChatMeta {
  name: string
  username?: string
}

export interface IntelConfig {
  chats?: Record<string, ChatMeta>
  excludedChats?: string[]
  aliasGroups?: string[][]
  compoundFixes?: Array<[string, string]>
}

interface ResolvedConfig {
  chats: Record<string, ChatMeta>
  excludedChats: Set<string>
  aliasMap: Map<string, string[]>
  compoundFixes: Array<[RegExp, string]>
}

export const CHATS: Record<string, ChatMeta> = {}

export const ALIAS_GROUPS: string[][] = [
  ['k8s', 'kubernetes', '容器编排'],
  ['pg', 'postgres', 'postgresql'],
  ['ts', 'typescript'],
  ['js', 'javascript'],
  ['py', 'python'],
  ['db', 'database', '数据库'],
  ['llm', '大模型', '大语言模型'],
  ['rag', '检索增强'],
  ['docker', '容器'],
  ['proxy', '代理'],
]

const STOPWORDS = new Set([
  '的', '了', '和', '与', '或', '是', '在', '有', '吗', '呢', '啊', '吧', '呀',
  '怎么', '如何', '什么', '哪个', '哪些', '可以', '之后', '以后', '请问', '大家',
  '有没有', '知道', '一下', '为什么', '能不能', '多少', '还是', '以及',
])

function buildAliasMap(groups: string[][]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const group of groups) {
    const normalized = group.map(item => item.toLowerCase()).filter(Boolean)
    for (const item of normalized)
      map.set(item, normalized)
  }
  return map
}

export function loadIntelConfig(configPath?: string): ResolvedConfig {
  const target = configPath ?? process.env.TG_INTEL_CONFIG
  let raw: IntelConfig = {}
  if (target && existsSync(target))
    raw = JSON.parse(readFileSync(target, 'utf8')) as IntelConfig

  const chats: Record<string, ChatMeta> = { ...CHATS, ...(raw.chats ?? {}) }
  const excludedChats = new Set((raw.excludedChats ?? []).map(String))
  const aliasGroups = [...ALIAS_GROUPS, ...(raw.aliasGroups ?? [])]
  const compoundFixes: Array<[RegExp, string]> = (raw.compoundFixes ?? []).map(
    ([pattern, replacement]) => [new RegExp(pattern, 'gi'), replacement],
  )
  return {
    chats,
    excludedChats,
    aliasMap: buildAliasMap(aliasGroups),
    compoundFixes,
  }
}

const zhSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

export function ftsSegment(text: string): string {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9]+|[\u4e00-\u9fff]/g))
    tokens.push(match[0])
  return tokens.join(' ')
}

function termToPhrase(term: string): string | null {
  const seg = ftsSegment(term)
  return seg ? `"${seg}"` : null
}

export function expandQueryGroups(rawQuery: string, configPath?: string): {
  groups: string[][]
  ftsStrict: string
  ftsPairs: string | null
  ftsRelaxed: string | null
} {
  const { aliasMap, compoundFixes } = loadIntelConfig(configPath)
  const chunks = rawQuery
    .toLowerCase()
    .split(/[\s,，、/|;；?？!！:：()（）【】[\]"'“”‘’]+/)
    .filter(Boolean)

  const rawTerms: string[] = []
  for (const chunk of chunks) {
    if (aliasMap.has(chunk) || !/[\u4e00-\u9fff]{4,}/.test(chunk)) {
      rawTerms.push(chunk)
      continue
    }
    let joined = [...zhSegmenter.segment(chunk)]
      .filter(part => part.isWordLike)
      .map(part => part.segment)
      .join(' ')
    for (const [pattern, replacement] of compoundFixes)
      joined = joined.replace(pattern, replacement)
    rawTerms.push(...joined.split(/\s+/).filter(Boolean))
  }

  const filtered = rawTerms.filter(term => !STOPWORDS.has(term))
  const effective = filtered.length ? filtered : rawTerms
  const seen = new Set<string>()
  const groups: string[][] = []

  for (const term of effective) {
    const expanded = aliasMap.get(term) ?? [term]
    const key = expanded.join('|')
    if (seen.has(key))
      continue
    seen.add(key)
    groups.push(expanded)
  }

  const ftsClauses = groups
    .map((alts) => {
      const phrases = alts.map(termToPhrase).filter((item): item is string => Boolean(item))
      if (!phrases.length)
        return null
      return phrases.length === 1 ? phrases[0] : `(${phrases.join(' OR ')})`
    })
    .filter((item): item is string => Boolean(item))

  let ftsPairs: string | null = null
  if (ftsClauses.length >= 3 && ftsClauses.length <= 6) {
    const pairs: string[] = []
    for (let i = 0; i < ftsClauses.length; i++) {
      for (let j = i + 1; j < ftsClauses.length; j++)
        pairs.push(`(${ftsClauses[i]} AND ${ftsClauses[j]})`)
    }
    ftsPairs = pairs.join(' OR ')
  }

  return {
    groups,
    ftsStrict: ftsClauses.join(' AND '),
    ftsPairs,
    ftsRelaxed: ftsClauses.length > 1 ? ftsClauses.join(' OR ') : null,
  }
}

function resolveSenderName(senderId: string, rawName: string | undefined, names: Record<string, string>): string {
  const mapped = names[senderId]
  if (mapped)
    return mapped
  const clean = (rawName ?? '').trim()
  if (clean && clean !== senderId && !/^\d+$/.test(clean))
    return clean
  const digits = String(senderId ?? '').replace(/\D/g, '')
  return digits ? `群友${digits.slice(-4)}` : '群友'
}

function tgLink(chatId: string, messageId: string, chats: Record<string, ChatMeta>): string {
  const username = chats[chatId]?.username
  return username ? `https://t.me/${username}/${messageId}` : `https://t.me/c/${chatId}/${messageId}`
}

function formatShanghai(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
}

export interface BuildDbOptions {
  dbPath: string
  exportDir: string
  senderNamesPath?: string
  xDir?: string
  statsOutPath?: string
  configPath?: string
}

export interface DbBuildStats {
  tgMessages: number
  xMessages: number
  totalMessages: number
  chats: Record<string, { name: string, count: number, lastTimestamp: number }>
  builtAt: string
}

export function buildIntelDb(options: BuildDbOptions): DbBuildStats {
  mkdirSync(dirname(options.dbPath), { recursive: true })
  const { chats, excludedChats } = loadIntelConfig(options.configPath)
  const names: Record<string, string> = options.senderNamesPath && existsSync(options.senderNamesPath)
    ? JSON.parse(readFileSync(options.senderNamesPath, 'utf8'))
    : {}

  const db = new DatabaseSync(options.dbPath)
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        pk INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_name TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reply_to_id TEXT,
        text TEXT NOT NULL,
        url TEXT NOT NULL,
        UNIQUE(source, chat_id, msg_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp, pk);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(chat_id, reply_to_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(seg, sender, chat, tokenize = 'unicode61');
    `)

    const seen = new Set<string>()
    const rows: Array<{
      source: string
      chatId: string
      chatName: string
      msgId: string
      senderId: string
      senderName: string
      timestamp: number
      replyToId: string | null
      text: string
      url: string
    }> = []

    let tgCount = 0
    let xCount = 0
    const chatStats: Record<string, { name: string, count: number, lastTimestamp: number }> = {}

    if (existsSync(options.exportDir)) {
      const files = readdirSync(options.exportDir).filter(file => file.endsWith('.jsonl')).sort()
      for (const file of files) {
        const content = readFileSync(join(options.exportDir, file), 'utf8')
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim())
            continue
          const rec = JSON.parse(line)
          if (rec.deletedAt || excludedChats.has(String(rec.chatId)))
            continue
          const text = String(rec.text ?? '').trim()
          const linkUrls = (rec.links ?? []).map((item: { url?: string }) => item?.url).filter(Boolean)
          const body = text || linkUrls.join(' ')
          if (!body)
            continue
          const chatId = String(rec.chatId)
          const msgId = String(rec.id)
          const uniq = `tg:${chatId}:${msgId}`
          if (seen.has(uniq))
            continue
          seen.add(uniq)
          const chatName = chats[chatId]?.name ?? chatId
          const senderId = String(rec.senderId ?? '')
          const senderName = resolveSenderName(senderId, rec.senderName, names)
          const ts = Number(rec.timestamp) || 0
          const replyToId = rec.replyToId ? String(rec.replyToId) : (rec.replyTo?.id ? String(rec.replyTo.id) : null)
          rows.push({
            source: 'tg',
            chatId,
            chatName,
            msgId,
            senderId,
            senderName,
            timestamp: ts,
            replyToId,
            text: body,
            url: tgLink(chatId, msgId, chats),
          })
          tgCount++
          const prev = chatStats[chatId] ?? { name: chatName, count: 0, lastTimestamp: 0 }
          prev.count++
          if (ts > prev.lastTimestamp)
            prev.lastTimestamp = ts
          chatStats[chatId] = prev
        }
      }
    }

    // build-db replaces the whole table, so a wrong or empty export dir must not wipe the existing db
    if (!tgCount)
      throw new Error(`no Telegram messages found in ${options.exportDir}; refusing to replace existing db`)

    if (options.xDir && existsSync(options.xDir)) {
      const userNames = new Map<string, string>()
      const followingPath = join(options.xDir, 'following.json')
      if (existsSync(followingPath)) {
        for (const user of JSON.parse(readFileSync(followingPath, 'utf8'))) {
          if (user?.handle)
            userNames.set(String(user.handle), String(user.name ?? user.handle))
        }
      }
      const postFiles = readdirSync(options.xDir).filter(name => /^posts-.+\.json$/.test(name)).sort()
      for (const file of postFiles) {
        const handle = file.replace(/^posts-/, '').replace(/\.json$/, '')
        const fullPath = join(options.xDir, file)
        const fallbackTs = Math.floor(statSync(fullPath).mtimeMs / 1000)
        const display = userNames.get(handle)
        const chatId = `x:@${handle}`
        const chatName = display && display !== handle ? `X @${handle} (${display})` : `X @${handle}`
        const posts = JSON.parse(readFileSync(fullPath, 'utf8'))
        for (const post of posts) {
          const body = String(post?.text ?? '').trim()
          const rawId = String(post?.id ?? '').trim()
          if (!body || !rawId)
            continue
          const msgId = rawId.split('/').pop() || rawId
          const uniq = `x:${chatId}:${msgId}`
          if (seen.has(uniq))
            continue
          seen.add(uniq)
          const parsedTs = post.at ? Math.floor(Date.parse(post.at) / 1000) : Number.NaN
          const ts = Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : fallbackTs
          rows.push({
            source: 'x',
            chatId,
            chatName,
            msgId,
            senderId: `@${handle}`,
            senderName: display ? `${display} (@${handle})` : `@${handle}`,
            timestamp: ts,
            replyToId: null,
            text: body,
            url: rawId.startsWith('http') ? rawId : `https://x.com${rawId}`,
          })
          xCount++
        }
      }

      const bookmarksPath = join(options.xDir, 'bookmarks.json')
      if (existsSync(bookmarksPath)) {
        const fallbackTs = Math.floor(statSync(bookmarksPath).mtimeMs / 1000)
        const bookmarks = JSON.parse(readFileSync(bookmarksPath, 'utf8'))
        bookmarks.forEach((entry: unknown, idx: number) => {
          const body = String(entry ?? '').trim()
          if (!body)
            return
          const msgId = `bm-${idx + 1}`
          rows.push({
            source: 'x',
            chatId: 'x:bookmarks',
            chatName: 'X 书签收藏',
            msgId,
            senderId: '@bookmark',
            senderName: 'X书签',
            timestamp: fallbackTs,
            replyToId: null,
            text: body,
            url: 'https://x.com/i/bookmarks',
          })
          xCount++
        })
      }
    }

    rows.sort((a, b) => a.timestamp - b.timestamp || a.msgId.localeCompare(b.msgId))

    const insertMsg = db.prepare(`
      INSERT INTO messages (pk, source, chat_id, chat_name, msg_id, sender_id, sender_name, timestamp, reply_to_id, text, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = db.prepare(`
      INSERT INTO messages_fts (rowid, seg, sender, chat)
      VALUES (?, ?, ?, ?)
    `)
    const putMeta = db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)

    const builtAt = new Date().toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM messages; DELETE FROM messages_fts;')
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        const pk = i + 1
        insertMsg.run(pk, r.source, r.chatId, r.chatName, r.msgId, r.senderId, r.senderName, r.timestamp, r.replyToId, r.text, r.url)
        insertFts.run(pk, ftsSegment(r.text), ftsSegment(r.senderName), ftsSegment(r.chatName))
      }
      const stats: DbBuildStats = {
        tgMessages: tgCount,
        xMessages: xCount,
        totalMessages: rows.length,
        chats: chatStats,
        builtAt,
      }
      putMeta.run('stats', JSON.stringify(stats))
      db.exec('COMMIT')
      if (options.statsOutPath)
        writeFileSync(options.statsOutPath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8')
      return stats
    }
    catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  finally {
    db.close()
  }
}

export interface QueryDbOptions {
  query: string
  source?: 'all' | 'tg' | 'x'
  chat?: string
  sender?: string
  days?: number
  limit?: number
}

export interface DbSearchHit {
  source: string
  chat_id: string
  chat_name: string
  message_id: string
  sender_name: string
  timestamp: number
  date: string
  reply_to_id: string | null
  url: string
  text: string
  score: number
}

export function queryIntelDb(dbPath: string, options: QueryDbOptions): { expanded_groups: string[][], total_returned: number, hits: DbSearchHit[] } {
  const { groups, ftsStrict, ftsPairs, ftsRelaxed } = expandQueryGroups(options.query)
  if (!ftsStrict)
    return { expanded_groups: [], total_returned: 0, hits: [] }

  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  const now = Math.floor(Date.now() / 1000)
  const minTs = options.days && options.days > 0 ? now - options.days * 86400 : 0

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const runFts = (matchExpr: string, maxRows: number) => {
      const clauses = ['messages_fts MATCH ?']
      const params: Array<string | number> = [matchExpr]
      if (options.source && options.source !== 'all') {
        clauses.push('m.source = ?')
        params.push(options.source)
      }
      if (minTs > 0) {
        clauses.push('m.timestamp >= ?')
        params.push(minTs)
      }
      if (options.chat) {
        clauses.push('(m.chat_id = ? OR lower(m.chat_name) LIKE ?)')
        params.push(options.chat, `%${options.chat.toLowerCase()}%`)
      }
      if (options.sender) {
        clauses.push('lower(m.sender_name) LIKE ?')
        params.push(`%${options.sender.toLowerCase()}%`)
      }
      params.push(maxRows)
      const sql = `
        SELECT m.pk, m.source, m.chat_id, m.chat_name, m.msg_id, m.sender_name,
               m.timestamp, m.reply_to_id, m.text, m.url,
               bm25(messages_fts, 5.0, 2.0, 1.0) AS rank
        FROM messages_fts
        JOIN messages m ON m.pk = messages_fts.rowid
        WHERE ${clauses.join(' AND ')}
        ORDER BY rank ASC, m.timestamp DESC
        LIMIT ?
      `
      return db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    }

    const rawRows = runFts(ftsStrict, limit * 3)
    const seenIds = new Set(rawRows.map(r => Number(r.pk)))
    if (rawRows.length < limit && ftsPairs) {
      for (const extra of runFts(ftsPairs, limit * 3)) {
        if (!seenIds.has(Number(extra.pk))) {
          seenIds.add(Number(extra.pk))
          rawRows.push(extra)
        }
      }
    }
    if (rawRows.length < Math.min(5, limit) && ftsRelaxed) {
      for (const extra of runFts(ftsRelaxed, limit * 2)) {
        if (!seenIds.has(Number(extra.pk))) {
          seenIds.add(Number(extra.pk))
          rawRows.push(extra)
        }
      }
    }

    const scored: DbSearchHit[] = rawRows.map((row) => {
      const bm25Score = Math.min(12, Math.abs(Number(row.rank) || 0))
      const ts = Number(row.timestamp)
      const ageDays = Math.max(0, (now - ts) / 86400)
      const recencyBoost = Math.max(0, 1.5 - ageDays / 120)
      const text = String(row.text)
      const hay = `${text} ${String(row.sender_name)} ${String(row.chat_name)}`.toLowerCase()
      const matchedGroups = groups.filter(alts => alts.some(alt => hay.includes(alt))).length
      const lenBoost = text.length >= 25 ? 0.8 : text.length >= 10 ? 0.3 : 0
      return {
        source: String(row.source),
        chat_id: String(row.chat_id),
        chat_name: String(row.chat_name),
        message_id: String(row.msg_id),
        sender_name: String(row.sender_name),
        timestamp: ts,
        date: formatShanghai(ts),
        reply_to_id: row.reply_to_id ? String(row.reply_to_id) : null,
        url: String(row.url),
        text: text.slice(0, 1000),
        score: Number((matchedGroups * 15 + bm25Score + recencyBoost + lenBoost).toFixed(3)),
      }
    })

    const hits = scored
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, limit)
    return { expanded_groups: groups, total_returned: hits.length, hits }
  }
  finally {
    db.close()
  }
}

export function readMessageContext(
  dbPath: string,
  options: { chat_id: string, message_id: string, before?: number, after?: number },
) {
  const before = Math.min(Math.max(options.before ?? 8, 0), 40)
  const after = Math.min(Math.max(options.after ?? 12, 0), 60)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const target = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? AND msg_id = ? LIMIT 1
    `).get(options.chat_id, options.message_id) as Record<string, unknown> | undefined
    if (!target)
      return null

    const collected = new Map<number, { row: Record<string, unknown>, role: string }>()
    collected.set(Number(target.pk), { row: target, role: 'target' })

    // Walk up reply_to_id chain (up to 6 hops) so parent context hours earlier is never lost
    let cursor = target
    for (let hop = 0; hop < 6 && cursor?.reply_to_id; hop++) {
      const parent = db.prepare(`
        SELECT * FROM messages WHERE chat_id = ? AND msg_id = ? LIMIT 1
      `).get(options.chat_id, String(cursor.reply_to_id)) as Record<string, unknown> | undefined
      if (!parent)
        break
      if (!collected.has(Number(parent.pk)))
        collected.set(Number(parent.pk), { row: parent, role: 'reply_ancestor' })
      cursor = parent
    }

    // Direct replies to target
    const directReplies = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? AND reply_to_id = ? ORDER BY pk ASC LIMIT 20
    `).all(options.chat_id, options.message_id) as Array<Record<string, unknown>>
    for (const reply of directReplies) {
      if (!collected.has(Number(reply.pk)))
        collected.set(Number(reply.pk), { row: reply, role: 'direct_reply' })
    }

    // Surrounding chronological window in the same chat
    const prevRows = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? AND pk < ? ORDER BY pk DESC LIMIT ?
    `).all(options.chat_id, Number(target.pk), before) as Array<Record<string, unknown>>
    for (const row of prevRows) {
      if (!collected.has(Number(row.pk)))
        collected.set(Number(row.pk), { row, role: 'context' })
    }
    const nextRows = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? AND pk > ? ORDER BY pk ASC LIMIT ?
    `).all(options.chat_id, Number(target.pk), after) as Array<Record<string, unknown>>
    for (const row of nextRows) {
      if (!collected.has(Number(row.pk)))
        collected.set(Number(row.pk), { row, role: 'context' })
    }

    const messages = [...collected.values()]
      .sort((a, b) => Number(a.row.pk) - Number(b.row.pk))
      .map(({ row, role }) => ({
        role,
        message_id: String(row.msg_id),
        sender_name: String(row.sender_name),
        date: formatShanghai(Number(row.timestamp)),
        timestamp: Number(row.timestamp),
        reply_to_id: row.reply_to_id ? String(row.reply_to_id) : null,
        url: String(row.url),
        text: String(row.text).slice(0, 1500),
      }))

    return {
      source: String(target.source),
      chat_id: String(target.chat_id),
      chat_name: String(target.chat_name),
      target_message_id: String(target.msg_id),
      message_count: messages.length,
      messages,
    }
  }
  finally {
    db.close()
  }
}

export function listRecentMessages(
  dbPath: string,
  options: { source?: 'all' | 'tg' | 'x', chat?: string, days?: number, limit?: number } = {},
) {
  const days = options.days ?? 3
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100)
  const minTs = Math.floor(Date.now() / 1000) - days * 86400
  const clauses = ['timestamp >= ?', 'length(text) >= 18']
  const params: Array<string | number> = [minTs]
  if (options.source && options.source !== 'all') {
    clauses.push('source = ?')
    params.push(options.source)
  }
  if (options.chat) {
    clauses.push('(chat_id = ? OR lower(chat_name) LIKE ?)')
    params.push(options.chat, `%${options.chat.toLowerCase()}%`)
  }
  params.push(limit)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(`
      SELECT source, chat_id, chat_name, msg_id, sender_name, timestamp, reply_to_id, url, text
      FROM messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map(row => ({
      source: String(row.source),
      chat_id: String(row.chat_id),
      chat_name: String(row.chat_name),
      message_id: String(row.msg_id),
      sender_name: String(row.sender_name),
      date: formatShanghai(Number(row.timestamp)),
      reply_to_id: row.reply_to_id ? String(row.reply_to_id) : null,
      url: String(row.url),
      text: String(row.text).slice(0, 600),
    }))
  }
  finally {
    db.close()
  }
}

export function getIntelDbStats(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const metaRow = db.prepare(`SELECT value FROM meta WHERE key = 'stats'`).get() as { value?: string } | undefined
    const bySource = db.prepare(`
      SELECT source, COUNT(*) AS count, MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts
      FROM messages GROUP BY source
    `).all() as Array<Record<string, unknown>>
    const byChat = db.prepare(`
      SELECT source, chat_id, chat_name, COUNT(*) AS count, MAX(timestamp) AS max_ts
      FROM messages GROUP BY source, chat_id, chat_name ORDER BY count DESC
    `).all() as Array<Record<string, unknown>>
    return {
      built: metaRow?.value ? JSON.parse(metaRow.value) : null,
      sources: bySource.map(r => ({
        source: String(r.source),
        count: Number(r.count),
        from: formatShanghai(Number(r.min_ts)),
        to: formatShanghai(Number(r.max_ts)),
      })),
      top_channels: byChat.slice(0, 20).map(r => ({
        source: String(r.source),
        chat_id: String(r.chat_id),
        chat_name: String(r.chat_name),
        count: Number(r.count),
        latest: formatShanghai(Number(r.max_ts)),
      })),
    }
  }
  finally {
    db.close()
  }
}

interface WikiDoc {
  relPath: string
  name: string
  title: string
  aliases: string[]
  tags: string[]
  links: string[]
  body: string
}

function loadWikiDocs(wikiDir: string): WikiDoc[] {
  if (!wikiDir || !existsSync(wikiDir))
    return []
  const docs: WikiDoc[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.'))
        continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      }
      else if (extname(entry.name).toLowerCase() === '.md') {
        const raw = readFileSync(full, 'utf8')
        const relPath = relative(wikiDir, full).replace(/\\/g, '/')
        const name = basename(entry.name, '.md')
        let title = name
        const aliases: string[] = []
        const tags: string[] = []
        const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
        const body = fmMatch ? raw.slice(fmMatch[0].length) : raw
        if (fmMatch) {
          const fm = fmMatch[1]
          const titleLine = fm.match(/^title:\s*(.+)$/m)
          if (titleLine)
            title = titleLine[1].trim().replace(/^['"]|['"]$/g, '')
          const collectList = (key: string, target: string[]) => {
            const block = fm.match(new RegExp(`^${key}:\\s*\\r?\\n((?:\\s+-\\s+.+\\r?\\n?)+)`, 'm'))
            if (block) {
              for (const line of block[1].split(/\r?\n/)) {
                const m = line.match(/^\s+-\s+(.+)$/)
                if (m)
                  target.push(m[1].trim().replace(/^['"]|['"]$/g, ''))
              }
            }
          }
          collectList('aliases', aliases)
          collectList('tags', tags)
        }
        const links = [...new Set(
          [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map(m => m[1].replace(/\\$/, '').trim()),
        )]
        docs.push({ relPath, name, title, aliases, tags, links, body })
      }
    }
  }
  walk(wikiDir)
  return docs.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-CN'))
}

export function searchWiki(wikiDir: string, query?: string) {
  const docs = loadWikiDocs(wikiDir)
  if (!query || !query.trim()) {
    return docs.map(d => ({
      path: d.relPath,
      title: d.title,
      aliases: d.aliases,
      tags: d.tags,
      outgoing_links: d.links,
    }))
  }
  const { groups } = expandQueryGroups(query)
  const flatTerms = groups.flat()
  const results = []
  for (const d of docs) {
    const headerHaystack = `${d.name} ${d.title} ${d.aliases.join(' ')} ${d.tags.join(' ')}`.toLowerCase()
    const bodyLower = d.body.toLowerCase()
    let score = 0
    for (const group of groups) {
      const inHeader = group.some(t => headerHaystack.includes(t))
      const inBody = group.some(t => bodyLower.includes(t))
      if (inHeader)
        score += 5
      else if (inBody)
        score += 2
    }
    if (!score)
      continue
    const lines = d.body.split(/\r?\n/).filter(line => line.trim())
    const hitLine = lines.find(line => flatTerms.some(t => line.toLowerCase().includes(t))) ?? lines[0] ?? ''
    results.push({
      path: d.relPath,
      title: d.title,
      tags: d.tags,
      score,
      snippet: hitLine.slice(0, 240),
      outgoing_links: d.links,
    })
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'zh-CN'))
}

export function readWikiNote(wikiDir: string, target: string) {
  const docs = loadWikiDocs(wikiDir)
  const norm = target.trim().replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').toLowerCase()
  const found = docs.find(d =>
    d.relPath.toLowerCase() === target.trim().toLowerCase()
    || d.relPath.replace(/\.md$/i, '').toLowerCase() === norm
    || d.name.toLowerCase() === norm
    || d.title.toLowerCase() === norm
    || d.aliases.some(a => a.toLowerCase() === norm),
  )
  if (!found)
    return null
  const backlinks = docs
    .filter(other => other.relPath !== found.relPath && other.links.some(link =>
      link.toLowerCase() === found.name.toLowerCase() || link.toLowerCase() === found.title.toLowerCase(),
    ))
    .map(other => ({ path: other.relPath, title: other.title }))
  return {
    path: found.relPath,
    title: found.title,
    aliases: found.aliases,
    tags: found.tags,
    outgoing_links: found.links,
    backlinks,
    content: found.body,
  }
}
