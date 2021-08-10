import { options } from '@parallel-finance/api'
import { ApiPromise, WsProvider } from '@polkadot/api'
import { KeyringPair } from '@polkadot/keyring/types'
import { DispatchError } from '@polkadot/types/interfaces'
import { ITuple } from '@polkadot/types/types'
import BN from 'bn.js'
import { template } from 'lodash'
import { MessageHandler, SendConfig } from '../types'
import { Config } from '../util/config'
import { Deferred } from '../util/deferred'
import logger from '../util/logger'
import { Storage } from '../util/storage'
import { TaskData, TaskQueue } from './task-queue'

interface FaucetServiceConfig {
  account: KeyringPair
  template: Config['template']
  config: Config['faucet']
  storage: Storage
  task: TaskQueue
}

interface RequestFaucetParams {
  address: string
  strategy: string
  channel: {
    name: string
    account: string
  } & Record<string, string>
}

export class Service {
  public paraApi!: ApiPromise
  public relayApi!: ApiPromise
  private account: KeyringPair
  private template: Config['template']
  private config: Config['faucet']
  private storage: Storage
  private task: TaskQueue
  private sendMessageHandler!: Record<string, MessageHandler>
  private killCountdown: number = 1000 * 60
  private killTimer!: NodeJS.Timeout | null

  constructor({
    account,
    config,
    template,
    storage,
    task
  }: FaucetServiceConfig) {
    this.account = account
    this.config = config
    this.template = template
    this.storage = storage
    this.task = task
    this.sendMessageHandler = {}

    this.onConnected = this.onConnected.bind(this)
    this.onDisconnected = this.onDisconnected.bind(this)
  }

  private get isConnected() {
    return this.relayApi.isConnected && this.paraApi.isConnected
  }

  private get isDisconnected() {
    return !this.relayApi.isConnected || !this.paraApi.isConnected
  }

  private onConnected() {
    setTimeout(() => {
      if (this.isConnected) {
        if (this.killTimer) {
          clearTimeout(this.killTimer)
          this.killTimer = null
        }
      }
    }, 0)
  }

  private onDisconnected() {
    if (this.isDisconnected) {
      if (!this.killTimer) {
        this.killTimer = setTimeout(() => {
          process.exit(1)
        }, this.killCountdown)
      }
    }
  }

  public async connect(config: Config['faucet']) {
    this.relayApi = new ApiPromise({
      provider: new WsProvider(config.relayEndpoint)
    })

    this.paraApi = new ApiPromise(
      options({
        provider: new WsProvider(config.paraEndpoint)
      })
    )

    this.paraApi.on('connected', this.onConnected)
    this.relayApi.on('connected', this.onConnected)
    this.paraApi.on('disconnected', this.onDisconnected)
    this.relayApi.on('disconnected', this.onDisconnected)

    await this.relayApi.isReady.catch(() => {
      throw new Error('relaychain connect failed')
    })

    await this.paraApi.isReady.catch(() => {
      throw new Error('parachain connect failed')
    })

    this.task.process((task: TaskData) => {
      const { address, channel, strategy, params } = task
      const account = channel.account
      const channelName = channel.name
      const sendMessage = this.getMessageHandler(channelName)

      return this.sendTokens(params)
        .then((tx: string) => {
          logger.info(
            `send success, required from ${channelName}/${account} channel with address:${address} ${JSON.stringify(
              task.params
            )}`
          )

          if (!sendMessage) return

          sendMessage(
            channel,
            params.map((item) => `${item.token}: ${item.amount}`).join(', '),
            tx
          )
        })
        .catch(async (e) => {
          logger.error(e)

          await this.storage.decrKeyCount(`service_${strategy}_${address}`)

          if (account) {
            await this.storage.decrKeyCount(
              `service_${strategy}_${channelName}_${account}`
            )
          }
        })
    })
  }

  public registMessageHander(channel: string, handler: MessageHandler) {
    this.sendMessageHandler[channel] = handler
  }

  private getMessageHandler(channel: string) {
    return this.sendMessageHandler[channel]
  }

  public async queryBalance() {
    const result = await Promise.all(
      this.config.assets.map(({ name, network }) => {
        if (['Kusama', 'Polkadot', 'Westend', 'Rococo'].includes(network)) {
          return this.relayApi.derive.balances
            .account(this.account.address)
            .then((balance) => balance.freeBalance.toHuman())
        } else if (['Parallel', 'Heiko'].includes(network)) {
          return (this.paraApi as any).derive.currencies.balance(
            this.account.address,
            name
          )
        } else {
          throw new Error(`invalid token network: ${network}`)
        }
      })
    )

    return this.config.assets.map((token, index) => {
      return {
        token: token.name,
        balance: result[index] ? result[index] : '0'
      }
    })
  }

  public async getChainName() {
    return this.paraApi.rpc.system.chain()
  }

  public async sendTokens(config: SendConfig) {
    const deferred = new Deferred<string>()

    const txs = this.buildTx(config)
    for (const { tx, api } of txs) {
      const sigendTx = await tx.signAsync(this.account)

      const unsub = await sigendTx
        .send((result) => {
          if (result.isCompleted) {
            // extra message to ensure tx success
            let flag = true
            let errorMessage: DispatchError['type'] = ''

            for (const event of result.events) {
              const { data, method, section } = event.event

              if (section === 'utility' && method === 'BatchInterrupted') {
                flag = false
                errorMessage = 'batch error'
                break
              }

              // if extrinsic failed
              if (section === 'system' && method === 'ExtrinsicFailed') {
                const [dispatchError] = data as unknown as ITuple<
                  [DispatchError]
                >

                // get error message
                if (dispatchError.isModule) {
                  try {
                    const mod = dispatchError.asModule
                    const error = api.registry.findMetaError(
                      new Uint8Array([Number(mod.index), Number(mod.error)])
                    )

                    errorMessage = `${error.section}.${error.name}`
                  } catch (error) {
                    // swallow error
                    errorMessage = 'Unknown error'
                  }
                }
                flag = false
                break
              }
            }

            if (flag) {
              deferred.resolve(sigendTx.hash.toString())
            } else {
              deferred.reject(errorMessage)
            }

            unsub && unsub()
          }
        })
        .catch((e) => {
          deferred.reject(e)
        })
    }

    return deferred.promise
  }

  public buildTx(config: SendConfig) {
    const relayAssets = config.filter(({ network }) =>
      ['Kusama', 'Polkadot', 'Westend', 'Rococo'].includes(network)
    )
    const paraAssets = config.filter(({ network }) =>
      ['Heiko', 'Parallel'].includes(network)
    )
    const txs = []
    if (relayAssets.length) {
      txs.push({
        tx: this.relayApi.tx.utility.batch(
          relayAssets.map(({ token, balance, dest }) =>
            this.relayApi.tx.balances.transfer(dest, balance)
          )
        ),
        api: this.relayApi
      })
    }
    if (paraAssets.length) {
      txs.push({
        tx: this.paraApi.tx.utility.batch(
          paraAssets.map(({ token, balance, dest }) =>
            this.paraApi.tx.currencies.transfer(dest, token, balance)
          )
        ),
        api: this.paraApi
      })
    }
    return txs
  }

  public usage() {
    return this.template.usage
  }

  async faucet({
    strategy,
    address,
    channel
  }: RequestFaucetParams): Promise<any> {
    logger.info(
      `requect faucet, ${JSON.stringify(
        strategy
      )}, ${address}, ${JSON.stringify(channel)}`
    )

    const strategyDetail = this.config.strategy[strategy]

    const account = channel?.account
    const channelName = channel.name

    try {
      await this.task.checkPendingTask()
    } catch (e) {
      throw new Error(this.getErrorMessage('PADDING_TASK_MAX'))
    }

    if (!strategyDetail) {
      throw new Error(this.getErrorMessage('NO_STRAGEGY'))
    }

    // check account limit
    let accountCount = 0
    if (account && strategyDetail.checkAccount) {
      accountCount = await this.storage.getKeyCount(
        `service_${strategy}_${channelName}_${account}`
      )
    }

    if (strategyDetail.limit && accountCount >= strategyDetail.limit) {
      throw new Error(
        this.getErrorMessage('LIMIT', { account: channel.account || address })
      )
    }

    // check address limit
    let addressCount = 0
    try {
      addressCount = await this.storage.getKeyCount(
        `service_${strategy}_${address}`
      )
    } catch (e) {
      throw new Error(this.getErrorMessage('CHECK_LIMIT_FAILED'))
    }

    if (strategyDetail.limit && addressCount >= strategyDetail.limit) {
      throw new Error(
        this.getErrorMessage('LIMIT', { account: channel.account || address })
      )
    }

    // check build tx
    const params = strategyDetail.amounts.map((item) => ({
      token: item.asset,
      amount: item.amount,
      network: item.network,
      balance: new BN(item.amount.toString(), 10)
        .mul(new BN(item.decimals, 10))
        .toString(10),
      dest: address
    }))

    try {
      this.buildTx(params)
    } catch (e) {
      logger.error(e)

      throw new Error(this.getErrorMessage('CHECK_TX_FAILED', { error: e }))
    }

    // increase account & address limit count
    try {
      if (account && strategyDetail.checkAccount) {
        await this.storage.incrKeyCount(
          `service_${strategy}_${channelName}_${account}`,
          strategyDetail.frequency
        )
      }

      await this.storage.incrKeyCount(
        `service_${strategy}_${address}`,
        strategyDetail.frequency
      )
    } catch (e) {
      throw new Error(this.getErrorMessage('UPDATE_LIMIT_FAILED'))
    }

    try {
      const result = await this.task.insert({
        address,
        strategy,
        channel,
        params
      })

      return result
    } catch (e) {
      logger.error(e)

      await this.storage.decrKeyCount(`service_${strategy}_${address}`)

      if (account) {
        await this.storage.decrKeyCount(
          `service_${strategy}_${channelName}_${account}`
        )
      }

      throw new Error(this.getErrorMessage('INSERT_TASK_FAILED'))
    }
  }

  getErrorMessage(code: string, params?: any) {
    return template(this.template.error[code] || 'Faucet error.')(params)
  }

  getMessage(name: string, params?: any) {
    return template(this.template[name] || 'Empty')(params)
  }
}
