// Stand-in for the Cloudflare Email Service binding in integration tests (wired up in vitest.config.ts as an RPC
// service binding named EMAIL). Every message is written to the MAILS KV namespace, which the tests read through
// TEST_MAILS. Recipients starting with "fail+" simulate a delivery failure.
import { WorkerEntrypoint } from 'cloudflare:workers';

export class MailSink extends WorkerEntrypoint {
  async send(message) {
    const to = Array.isArray(message.to) ? message.to : [message.to];
    if (to.some(address => String(address).startsWith('fail+'))) {
      throw new Error('E_DELIVERY_FAILED: simulated delivery failure');
    }
    const messageId = crypto.randomUUID();
    const record = {
      messageId,
      to,
      from: message.from,
      subject: message.subject,
      html: message.html ?? null,
      text: message.text ?? null,
      sentAt: Date.now(),
    };
    for (const address of to) {
      await this.env.MAILS.put(`${String(address).toLowerCase()}/${Date.now()}-${messageId}`, JSON.stringify(record));
    }
    return { messageId };
  }
}

export default {
  fetch() {
    return new Response('mail sink', { status: 404 });
  },
};
