// $ 统一管理 RabbitMQ 的连接、消息发送、消费者绑定和消息确认，为文档发布后的 RAG 索引任务提供消息通道
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// $ 基于 amqplib 封装，负责连接自动恢复、Channel 自动重建、断线重连等工作。 (连接管理、断线重连、Channel 恢复)
import amqp, {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
// $ 负责真正与 RabbitMQ 通信，提供连接、创建 Channel、发送消息、消费消息等能力
import { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  RAG_REINDEX_EXCHANGE,
  RAG_REINDEX_QUEUE,
  RAG_RK_BY_IDS,
} from './mq.constants';

export type MessageHandler = (msg: ConsumeMessage) => Promise<void> | void;

@Injectable()
export class RabbitMqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: AmqpConnectionManager | null = null;
  private channel: ChannelWrapper | null = null;
  private readonly enabled: boolean;
  private readonly handlers = new Map<string, MessageHandler>();

  constructor(private readonly config: ConfigService) {
    this.enabled =
      this.config.get<string>('RABBITMQ_ENABLED', 'true') !== 'false';
  }

  get isEnabled() {
    return this.enabled;
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('RabbitMQ 已禁用（RABBITMQ_ENABLED=false）');
      return;
    }

    const url = this.config.get<string>(
      'RABBITMQ_URL',
      'amqp://guest:guest@localhost:5672',
    );
    const safeUrl = this.redactAmqpUrl(url);
    const timeoutMs = Number(
      this.config.get<string>('RABBITMQ_CONNECT_TIMEOUT_MS', '15000'),
    );

    this.logger.log(`正在连接 RabbitMQ：${safeUrl}（超时 ${timeoutMs}ms）`);

    this.connection = amqp.connect([url]);
    this.connection.on('connect', (arg) => {
      const connectedUrl =
        typeof arg === 'object' && arg && 'url' in arg
          ? String((arg as { url?: string }).url ?? url)
          : url;
      this.logger.log(`RabbitMQ 已连接：${this.redactAmqpUrl(connectedUrl)}`);
    });
    this.connection.on('disconnect', (err) =>
      this.logger.warn(`RabbitMQ 断开：${this.errorMessage(err?.err ?? err)}`),
    );
    this.connection.on('connectFailed', (err) =>
      this.logger.error(
        `RabbitMQ 连接失败：${this.errorMessage(err?.err ?? err)}（url=${safeUrl}）`,
      ),
    );
    this.channel = this.connection.createChannel({
      // `json: true` 表示发送对象时由包装库自动编码成 JSON。
      json: true,
      // 当底层连接恢复、Channel 被重新创建时，setup 也会重新执行。因此可以重新完成：Exchange、Queue、Binding、Consumer
      setup: async (ch: ConfirmChannel) => {
        // $ 创建Channel，在setup中先声明 交换机、队列和绑定关系、再绑定消费者
        this.logger.log('RabbitMQ channel setup：声明拓扑并绑定消费者');
        await this.assertTopology(ch);
        await this.bindConsumers(ch);
      },
    });

    try {
      // 等待 Channel 就绪；初始化失败时关闭连接、清空引用，并重新抛出错误
      await Promise.race([
        this.channel.waitForConnect(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `RabbitMQ 连接超时（${timeoutMs}ms）：${safeUrl}。请检查服务是否启动、5672 是否被其他容器占用、账号密码是否正确`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      this.logger.log('RabbitMQ channel 就绪');
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`RabbitMQ 初始化失败：${message}`);
      await this.connection.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      throw error;
    }
  }

  /** 日志里隐藏 AMQP 密码 */
  private redactAmqpUrl(url: string) {
    return url.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
  }

  private errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (
      typeof error === 'object' &&
      error &&
      'message' in error &&
      typeof (error as { message: unknown }).message === 'string'
    ) {
      return (error as { message: string }).message;
    }
    return String(error ?? 'unknown');
  }

  async onModuleDestroy() {
    await this.channel?.close();
    await this.connection?.close();
  }

  /** 注册队列消费者（在模块 init 前/后均可；连接就绪后生效） */
  registerHandler(queue: string, handler: MessageHandler) {
    this.handlers.set(queue, handler);
  }

  async publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
  ): Promise<boolean> {
    if (!this.enabled || !this.channel) {
      this.logger.warn(
        `跳过发消息（MQ 不可用）：exchange=${exchange}, rk=${routingKey}`,
      );
      return false;
    }

    try {
      await this.channel.publish(exchange, routingKey, payload, {
        contentType: 'application/json',
        persistent: true,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `发消息失败：exchange=${exchange}, rk=${routingKey}, error=${message}`,
      );
      return false;
    }
  }

  private async assertTopology(ch: ConfirmChannel) {
    // 交换机、队列与路由

    // 交换机类型配置为 topic, 路由参数模糊匹配
    await ch.assertExchange(RAG_REINDEX_EXCHANGE, 'topic', { durable: true });
    // 表示队列不存在就创建，已存在且参数一致则复用； `durable: true` 用于让队列在 Broker 重启后保留
    await ch.assertQueue(RAG_REINDEX_QUEUE, { durable: true });
    // 绑定对应的队列
    await ch.bindQueue(RAG_REINDEX_QUEUE, RAG_REINDEX_EXCHANGE, RAG_RK_BY_IDS);

    this.logger.log('RabbitMQ 拓扑已声明（RAG）');
  }

  private async bindConsumers(ch: ConfirmChannel) {
    for (const [queue, handler] of this.handlers.entries()) {
      await ch.consume(queue, async (msg) => {
        if (!msg) return;
        try {
          await handler(msg);
          // 告诉mq这个消息已经被处理了，可以删除了
          ch.ack(msg);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(`消费失败 queue=${queue}: ${message}`);
          // 告诉mq消息处理失败，按照指定策略处理
          ch.nack(msg, false, false);
        }
      });
      this.logger.log(`已注册消费者：${queue}`);
    }
  }
}
