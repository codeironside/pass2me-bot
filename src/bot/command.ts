/**
 * Resolve user text / button taps into canonical command ids.
 * Supports: interactive ids, cust_* tokens, aliases, and numeric menu picks.
 */

export type MenuOption = { id: string; label: string };

const ALIASES: Record<string, string> = {
  browse: 'cust_browse',
  search: 'cust_search',
  next: 'browse_next',
  more: 'browse_next',
  'next page': 'browse_next',
  prev: 'browse_prev',
  previous: 'browse_prev',
  'previous page': 'browse_prev',
  cart: 'cust_cart',
  orders: 'cust_orders',
  'my orders': 'cust_orders',
  wallet: 'cust_wallet',
  profile: 'cust_profile',
  'my profile': 'cust_profile',
  account: 'cust_profile',
  me: 'cust_profile',
  checkout: 'cust_checkout',
  pay: 'cust_checkout',
  'new location': 'loc_new',
  'new dropoff': 'loc_new',
  'clear cart': 'cust_clear_cart',
  'save for later': 'cust_save_later',
  'save later': 'cust_save_later',
  saved: 'cust_saved',
  'saved items': 'cust_saved',
  'buy later': 'cust_saved',
  menu: 'cust_home',
  help: 'cust_home',
  home: 'cust_home',
  start: 'cust_home',
  hi: 'cust_home',
  hello: 'cust_home',
};

/** hi / hello / start / menu — always jump back to the home menu */
export function isRestartHomeCommand(
  text: string,
  interactiveId?: string
): boolean {
  if (interactiveId === 'cust_home') return true;
  const lower = text.trim().toLowerCase();
  return (
    lower === 'hello' ||
    lower === 'hi' ||
    lower === 'start' ||
    lower === 'menu' ||
    lower === 'home' ||
    lower === 'help'
  );
}

/** Dashboard “Continue on WhatsApp” prefilled signup message */
export function isWebsiteSignupContinue(text: string): boolean {
  const lower = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!lower) return false;
  if (lower.includes('just signed up') && lower.includes('pas2me')) return true;
  if (lower.includes('continue on whatsapp') && lower.includes('signed up')) {
    return true;
  }
  return (
    lower ===
    'hi, i just signed up on pas2me and want to continue on whatsapp.'
  );
}

export function resolveCommand(params: {
  text: string;
  interactiveId?: string;
  lastMenu?: MenuOption[];
}): string {
  const interactive = params.interactiveId?.trim();
  if (interactive) return interactive.toLowerCase();

  const raw = params.text.trim();
  const lower = raw.toLowerCase();

  // Numeric pick from last menu (1-based)
  if (/^\d{1,2}$/.test(lower) && params.lastMenu && params.lastMenu.length > 0) {
    const idx = Number(lower) - 1;
    if (idx >= 0 && idx < params.lastMenu.length) {
      return params.lastMenu[idx]!.id.toLowerCase();
    }
  }

  // Direct cust_* / prod_* / add_* / pay_* / loc_* / merch_* tokens
  if (
    /^(cust_|prod_|add_|save_|saved_|pay_|loc_|log_|merch_|wal_|inv_|mode_|dev_)/i.test(lower)
  ) {
    return lower;
  }

  if (ALIASES[lower]) return ALIASES[lower]!;

  return lower;
}

export function formatTextMenu(
  body: string,
  buttons: MenuOption[],
  note?: string
): string {
  const lines = [
    body,
    '',
    ...buttons.map((b, i) => `${i + 1}. ${b.label}`),
    '',
    'Reply with the *number* or the option name.',
  ];
  if (note) lines.push(note);
  return lines.join('\n');
}
