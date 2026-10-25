/** Domains Gmail delivers to the same mailboxes. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The address accounts are keyed by: trimmed and lowercased. For Gmail, also without dots or a `+tag` in the part
 * before the `@`, and on gmail.com: Gmail delivers every such spelling to the same mailbox, so they are one person.
 * Other providers' addresses are only lowercased, since their rules differ.
 */
export function canonicalEmail(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0 || !GMAIL_DOMAINS.has(address.slice(at + 1))) {
    return address;
  }
  return `${address.slice(0, at).split('+')[0].replaceAll('.', '')}@gmail.com`;
}
