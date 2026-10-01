// shared/alerts.js — email alerting via Resend with per-key deduplication

// HTML-escape values for email bodies. Use on EVERY interpolated value.
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

export async function sendMail(env, { to, subject, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`mail ${r.status}`);
}

/**
 * Send an alert email at most once per cooldown period per key.
 * This function MUST NOT throw into request handling — it swallows all errors.
 */
export async function alertOnce(env, key, message, cooldownMs = 6 * 3600_000) {
  try {
    const o = await env.PRIVATE.get('state/alerts.json');
    const st = o ? await o.json() : {};
    if (Date.now() - (st[key] ?? 0) < cooldownMs) return;
    st[key] = Date.now();
    await env.PRIVATE.put('state/alerts.json', JSON.stringify(st));
    await sendMail(env, {
      to: env.ALERT_EMAIL,
      subject: `[Store alert] ${key}`,
      html: `<p>${esc(message)}</p>`,
    });
  } catch { /* swallow — alerting must never take down a request */ }
}
