import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractUrls } from './thread.ts'
import type { IntelMessage } from './types.ts'

export interface ExportRecord {
  id: string
  chatId: string
  senderId: string
  senderName: string
  timestamp: number
  text: string
  replyToId?: string
  replyToChatId?: string
  replyTo?: {
    id?: string
    chatId?: string
  }
  links?: { url: string }[]
  deletedAt?: number
}

export function toIntelMessage(record: ExportRecord): IntelMessage | null {
  if (record.deletedAt)
    return null
  const links = [...new Map([
    ...(record.links ?? []).filter(link => link.url),
    ...extractUrls(record.text).map(url => ({ url })),
  ].map(link => [link.url, link])).values()]
  if (!record.text.trim() && !links.length)
    return null
  return {
    id: record.id,
    chatId: record.chatId,
    senderId: record.senderId,
    senderName: record.senderName,
    timestamp: record.timestamp,
    text: record.text,
    replyToId: record.replyToId ?? record.replyTo?.id,
    replyToChatId: record.replyToChatId ?? record.replyTo?.chatId,
    links,
  }
}

export async function readExportDir(dir: string): Promise<IntelMessage[]> {
  const files = (await readdir(dir)).filter(file => file.endsWith('.jsonl')).sort()
  const messages: IntelMessage[] = []
  for (const file of files) {
    const content = await readFile(join(dir, file), 'utf8')
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim())
        continue
      const record = JSON.parse(line) as ExportRecord
      const message = toIntelMessage(record)
      if (message)
        messages.push(message)
    }
  }
  return messages
}
