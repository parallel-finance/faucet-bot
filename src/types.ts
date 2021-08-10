export type LimitConfig = Map<string, number>

export type SendConfig = {
  dest: string
  token: string
  amount: number
  balance: string
}[]

export type MessageHandler = (
  channel: Record<string, string>,
  tokens: string,
  tx: string
) => void
