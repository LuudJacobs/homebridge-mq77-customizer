import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import type { Logger } from '../logger.js';
import { topicMatches } from './topics.js';

export interface BrokerConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  clientId?: string;
}

export interface MqttMessage {
  topic: string;
  payload: Buffer;
  retained: boolean;
}

export type MessageHandler = (message: MqttMessage) => void;

interface Subscription {
  filter: string;
  handler: MessageHandler;
}

/**
 * One broker connection shared by every source.
 *
 * Adapters subscribe to filters and get their own messages routed to them, so
 * several sources on different base topics never need separate connections.
 */
export class MqttConnection {
  private client?: MqttClient;
  private readonly subscriptions: Subscription[] = [];
  /** Topics we published to recently, used to ignore the echo of our own writes. */
  private readonly ownPublishes = new Map<string, number>();

  constructor(
    private readonly config: BrokerConfig,
    private readonly log: Logger,
  ) {}

  connect(): void {
    if (this.client) {
      return;
    }

    const options: IClientOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username || undefined,
      password: this.config.password || undefined,
      clientId: this.config.clientId || `mqtt-customizer-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
      resubscribe: true,
    };

    this.log.info(`Connecting to MQTT broker at ${this.config.host}:${this.config.port}`);
    const client = mqtt.connect(options);
    this.client = client;

    client.on('connect', () => {
      this.log.info('Connected to MQTT broker');
      // Subscriptions registered before the connection came up, and after a
      // session was not resumed, both need replaying.
      for (const subscription of this.subscriptions) {
        this.sendSubscribe(subscription.filter);
      }
    });

    client.on('reconnect', () => this.log.debug('Reconnecting to MQTT broker'));
    client.on('close', () => this.log.debug('MQTT connection closed'));
    client.on('error', (error) => this.log.error(`MQTT error: ${error.message}`));

    client.on('message', (topic, payload, packet) => {
      const message: MqttMessage = { topic, payload, retained: packet.retain === true };
      for (const subscription of this.subscriptions) {
        if (!topicMatches(subscription.filter, topic)) {
          continue;
        }
        try {
          subscription.handler(message);
        } catch (error) {
          this.log.error(`Handler for ${subscription.filter} threw on ${topic}: ${describe(error)}`);
        }
      }
    });
  }

  subscribe(filter: string, handler: MessageHandler): () => void {
    const subscription: Subscription = { filter, handler };
    this.subscriptions.push(subscription);

    if (this.client?.connected) {
      this.sendSubscribe(filter);
    }

    return () => {
      const index = this.subscriptions.indexOf(subscription);
      if (index >= 0) {
        this.subscriptions.splice(index, 1);
      }
      // Only drop the broker subscription once nothing else wants the filter.
      if (!this.subscriptions.some((s) => s.filter === filter)) {
        this.client?.unsubscribe(filter);
      }
    };
  }

  publish(topic: string, payload: string, options: { retain?: boolean } = {}): void {
    if (!this.client?.connected) {
      this.log.warn(`Dropping publish to ${topic}, broker not connected`);
      return;
    }
    this.ownPublishes.set(topic, Date.now());
    this.client.publish(topic, payload, { retain: options.retain ?? false, qos: 0 });
  }

  /**
   * True when we published to this topic within the window. Publishing to
   * `x/set` usually makes the other end publish state back on `x`, so the
   * rules engine uses this to avoid acting on its own writes.
   */
  isOwnEcho(topic: string, windowMs = 2000): boolean {
    const at = this.ownPublishes.get(topic);
    if (at === undefined) {
      return false;
    }
    if (Date.now() - at > windowMs) {
      this.ownPublishes.delete(topic);
      return false;
    }
    return true;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) {
      return;
    }
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
  }

  get connected(): boolean {
    return this.client?.connected === true;
  }

  private sendSubscribe(filter: string): void {
    this.client?.subscribe(filter, { qos: 0 }, (error) => {
      if (error) {
        this.log.error(`Failed to subscribe to ${filter}: ${error.message}`);
      } else {
        this.log.debug(`Subscribed to ${filter}`);
      }
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
