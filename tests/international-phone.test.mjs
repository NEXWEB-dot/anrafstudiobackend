import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {onRequestPost} from '../functions/api/checkout.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = {
  SITE_ORIGIN: 'https://shop.test', CHECKOUT_ENABLED: 'true',
  RESEND_API_KEY: 'test-only', ADMIN_NOTIFY_EMAIL: 'owner@shop.test',
  MAIL_FROM: 'orders@shop.test', DELIVERY_FEE: '260',
};
const ref = '22222222-2222-4222-8222-222222222222';
const payload = phone => ({
  client_ref: ref, name: 'Test Customer', phone, email: 'customer@example.test',
  address: 'House 1, Karachi, Sindh, Pakistan', payment_method: 'cod',
  items: [{product_id: 'Product123', size: 'Small', qty: 1}],
});
const call = body => onRequestPost({env, request: new Request('https://api.test/api/checkout', {
  method: 'POST', headers: {Origin: env.SITE_ORIGIN, 'Content-Type': 'application/json'},
  body: JSON.stringify(body),
})});

test('checkout accepts international contacts and preserves pricing, emails and WhatsApp numbers', async () => {
  for (const phone of ['+923001234567', '+971501234567', '+447700900123', '+12025550123', '+966501234567', '+61412345678']) {
    const mails = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('apicdn.sanity.io')) return Response.json({result: [{
        id: 'Product123', slug: 'shirt', name: 'Shirt', price: 100,
        in_stock: true, sizes: ['Small'], images: [],
      }]});
      assert.equal(String(url), 'https://api.resend.com/emails');
      mails.push(JSON.parse(options.body));
      return Response.json({id: 'test-email'});
    };
    const response = await call(payload(phone));
    assert.equal(response.status, 200, phone);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.ref, ref);
    assert.equal(result.subtotal, 100);
    assert.equal(result.delivery_fee, 260);
    assert.equal(result.total, 360);
    assert.equal(result.method, 'cod');
    assert.equal(mails.length, 2);
    assert.deepEqual(mails[0].to, ['owner@shop.test']);
    assert.deepEqual(mails[1].to, ['customer@example.test']);
    assert.ok(mails[0].html.includes(`https://wa.me/${phone.slice(1)}`));
    assert.ok(mails[0].html.includes(phone));
    assert.ok(mails[1].html.includes(phone));
    assert.ok(mails[0].html.includes('House 1, Karachi, Sindh, Pakistan'));
  }
});

test('checkout rejects malformed phone numbers before contacting services', async () => {
  globalThis.fetch = () => assert.fail('invalid numbers must not reach external services');
  for (const phone of [null, 123456789, '', '03001234567', '971501234567', '+0123456789',
    '+1234567', '+1234567890123456', '++971501234567', '+971 50 1234567',
    '+92300123', '+971501234567<script>', '+971501234567\n']) {
    const response = await call(payload(phone));
    assert.equal(response.status, 400, String(phone));
    assert.equal((await response.json()).error, 'BAD_INPUT');
  }
});
