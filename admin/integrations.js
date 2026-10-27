import {resendGet} from './orders.js';

export async function webhookSecret(env) {
  if (env.RESEND_WEBHOOK_SECRET) return env.RESEND_WEBHOOK_SECRET;
  return (await env.DB.prepare("SELECT value FROM integrations WHERE name='resend_webhook_secret'").first())?.value;
}

// Owner-authenticated setup. Provider keys and signing secrets never leave the server.
export async function configureResend(env, origin) {
  if (await webhookSecret(env)) return {ok:true, alreadyConfigured:true};
  const endpoint = `${origin}/api/webhooks/resend`;
  const list = await resendGet(env, '/webhooks');
  const existing = list.data?.find(item => item.endpoint === endpoint);
  let data;
  if (existing) {
    data = await resendGet(env, `/webhooks/${existing.id}`);
    if (data.status !== 'enabled' || !data.events?.includes('email.sent')) throw Object.assign(new Error('The existing Resend webhook must be enabled for email.sent.'), {status:409});
  } else {
    const response = await fetch('https://api.resend.com/webhooks', {
      method:'POST', signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${env.RESEND_ADMIN_API_KEY || env.RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({endpoint,events:['email.sent']}),
    });
    if (!response.ok) throw Object.assign(new Error(`Resend webhook setup failed (${response.status}). A full-access Resend key is required.`), {status:502});
    data = await response.json();
  }
  if (!data.signing_secret || !data.id) throw Object.assign(new Error('Resend did not return a signing secret. Set RESEND_WEBHOOK_SECRET on the backend.'), {status:502});
  await env.DB.batch([
    env.DB.prepare("INSERT INTO integrations(name,value) VALUES('resend_webhook_secret',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").bind(data.signing_secret),
    env.DB.prepare("INSERT INTO integrations(name,value) VALUES('resend_webhook_id',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").bind(data.id),
  ]);
  return {ok:true};
}
