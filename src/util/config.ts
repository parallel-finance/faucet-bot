import toml from 'toml'
import { readFileSync } from 'fs'
import { OpUnitType } from 'dayjs'

export interface Config {
  storage: {
    redis: {
      url: string
    }
  }
  faucet: {
    relayEndpoint: string
    paraEndpoint: string
    assets: { assetId: number; network: string }[]
    account: {
      mnemonic: string
    }
    strategy: {
      [k in string]: {
        checkAccount: boolean
        amounts: {
          token: string
          assetId: number
          network: string
          amount: number
          decimals: string
        }[]
        limit: number
        frequency: [string, OpUnitType]
      }
    }
  }
  task: {
    redis: string
    maxPendingCount: number
  }
  channel: {
    api: {
      port: number | number
    }
    matrix: {
      enable: boolean
      token: string
      userId: string
    }
    discord: {
      enable: boolean
      activeChannelName: string
      token: string
    }
  }
  template: {
    [k in string]: string
  } & {
    error: {
      [k in string]: string
    }
  }
}

export const loadConfig = (path = 'config.toml'): Config => {
  try {
    const content = readFileSync(path, { encoding: 'utf-8' })
    const config = toml.parse(content)

    return config as Config
  } catch (e) {
    throw new Error(`load config failed: ${e}`)
  }
}
