/** Domains Gmail delivers to the same mailboxes. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The address accounts are keyed by: trimmed and lowercased. For Gmail, also without a `+tag` in the part before the
 * `@`, and on gmail.com. Dots are kept, so an address reads the way its owner typed it. Other providers' addresses
 * are only lowercased, since their rules differ.
 */
export function canonicalEmail(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0 || !GMAIL_DOMAINS.has(address.slice(at + 1))) {
    return address;
  }
  return `${address.slice(0, at).split('+')[0]}@gmail.com`;
}

/**
 * For a normalized Gmail address with dots, the same address without them: for a while accounts were keyed that way,
 * so one may still be kept there. Null for any other address.
 */
export function undottedGmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  return email.slice(at + 1) === 'gmail.com' && local.includes('.') ? `${local.replaceAll('.', '')}@gmail.com` : null;
}
