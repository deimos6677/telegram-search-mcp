export interface IntelMessage {
  id: string
  chatId: string
  chatName?: string
  senderId: string
  senderName: string
  /** Unix seconds. */
  timestamp: number
  text: string
  replyToId?: string
  replyToChatId?: string
  links?: { url: string }[]
}

export interface IntelThread {
  id: string
  chatId: string
  chatIds: string[]
  startedAt: number
  endedAt: number
  messages: IntelMessage[]
  messageCount: number
  participantCount: number
  linkCount: number
  entities: string[]
  topics: string[]
  replyDepth: number
}
