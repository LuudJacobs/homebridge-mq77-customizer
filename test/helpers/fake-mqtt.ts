import { topicMatches } from '../../src/mqtt/topics.js';
import type { MessageHandler, MqttConnection } from '../../src/mqtt/client.js';

interface Published {
  topic: string;
  payload: string;
  retain: boolean;
}

/** In memory stand in for MqttConnection, so adapters can be driven directly. */
export class FakeMqtt {
  readonly published: Published[] = [];
  private readonly subscriptions: { filter: string; handler: MessageHandler }[] = [];

  subscribe(filter: string, handler: MessageHandler): () => void {
    const entry = { filter, handler };
    this.subscriptions.push(entry);
    return () => {
      const index = this.subscriptions.indexOf(entry);
      if (index >= 0) {
        this.subscriptions.splice(index, 1);
      }
    };
  }

  publish(topic: string, payload: string, options: { retain?: boolean } = {}): void {
    this.published.push({ topic, payload, retain: options.retain ?? false });
  }

  isOwnEcho(): boolean {
    return false;
  }

  get connected(): boolean {
    return true;
  }

  /** Simulates the broker delivering a message. */
  deliver(topic: string, payload: unknown, options: { retained?: boolean } = {}): void {
    const buffer = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    for (const subscription of this.subscriptions) {
      if (topicMatches(subscription.filter, topic)) {
        subscription.handler({ topic, payload: buffer, retained: options.retained ?? false });
      }
    }
  }

  get filters(): string[] {
    return this.subscriptions.map((subscription) => subscription.filter);
  }

  asConnection(): MqttConnection {
    return this as unknown as MqttConnection;
  }
}
