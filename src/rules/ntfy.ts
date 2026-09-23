/**
 * Sends a notification through ntfy.
 *
 * Published as JSON to the server's root rather than as a body with a title
 * header: a header can only carry Latin-1, and a title in Dutch with an emoji
 * in it is exactly what somebody writes.
 */
export interface Notifier {
  send(title: string | undefined, message: string): Promise<void>;
}

/** The server every notification goes to. Only the topic is configured. */
export const NTFY_SERVER = 'https://ntfy.sh';

export function ntfy(topic: string, fetcher: typeof fetch = fetch): Notifier {
  return {
    async send(title, message) {
      const response = await fetcher(NTFY_SERVER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, message, ...(title ? { title } : {}) }),
      });
      if (!response.ok) {
        throw new Error(`ntfy answered ${response.status}`);
      }
    },
  };
}
