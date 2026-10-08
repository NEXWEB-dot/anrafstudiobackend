import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {onRequestPost} from '../functions/api/checkout.js';
import {onRequest} from '../functions/_middleware.js';
const savedFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = savedFetch;});
const ref = '22222222-2222-4222-8222-222222222222';
const product = {id:'Product123',slug:'shirt',name:'Shirt',price:100,discountPercent:20,in_stock:true,sizes:['Small'],images:[]};
const env = {SITE_ORIGIN:'https://shop.test',CHECKOUT_ENABLED:'true',TURNSTILE_SECRET:'test',RESEND_API_KEY:'server-secret',MAIL_FROM:'orders@shop.test',ADMIN_NOTIFY_EMAIL:'owner@shop.test'};
const payload = () => ({client_ref:ref,name:'<img onerror="bad">',phone:'+923001234567',address:'Karachi',notes:'',turnstile_token:'token',items:[{product_id:'Product123',size:'Small',qty:2,price:1}]});
const request = (body, origin=env.SITE_ORIGIN) => new Request('https://api.test/api/checkout',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const call = (body=payload(), settings=env) => onRequestPost({request:request(body),env:settings});
function mock({products=[product],status=200,result={id:'email123'}}={}) {
  const mails=[];
  globalThis.fetch=async(url,options)=>{
    if (String(url).includes('siteverify')) return Response.json({success:true,hostname:'shop.test'});
    if (String(url).includes('apicdn.sanity.io')) return Response.json({result:products});
    assert.equal(String(url),'https://api.resend.com/emails');
    mails.push(options);
    return Response.json(result,{status});
  };
  return mails;
}
test('email checkout prices from Sanity, escapes customer input and uses stable idempotency keys',async()=>{
  const mails=mock();
  const response=await call();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(await response.json(),{ok:true,ref,total:160});
  const mail=JSON.parse(mails[0].body);
  assert.deepEqual(mail.to,['owner@shop.test']);
  assert.match(mail.html,/&lt;img/); assert.doesNotMatch(mail.html,/<img/);
  assert.match(mail.html,/PKR 160\.00/);
  assert.equal(mails[0].headers['Idempotency-Key'],`order/${ref}`);
  await call(); assert.equal(mails[1].headers['Idempotency-Key'],mails[0].headers['Idempotency-Key']);
});
test('missing settings, wrong origin and invalid input cannot send orders',async()=>{
  globalThis.fetch=()=>assert.fail('must not contact services');
  assert.equal((await call(payload(),{...env,CHECKOUT_ENABLED:'false'})).status,503);
  assert.equal((await onRequestPost({request:request(payload(),'https://evil.test'),env})).status,403);
  for (const body of [null,[],{...payload(),items:[null]},{...payload(),items:[{product_id:'Product123',size:'Small',qty:1.5}]},{...payload(),phone:'x'},{...payload(),items:[...payload().items,...payload().items]}])
    assert.equal((await call(body)).status,400);
  assert.equal((await call({notes:'x'.repeat(21000)})).status,413);
});
test('email failure, missing email receipt and service timeout never report success',async()=>{
  for (const options of [{status:503},{result:{}},{status:409}]) {
    mock(options); assert.equal((await call()).status,502);
  }
  mock(); const upstream=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url).includes('resend.com') ? Promise.reject(new Error('timeout')) : upstream(url,options);
  assert.equal((await call()).status,502);
});
test('checkout fails closed for unavailable Sanity, invalid bot verification, sold-out and removed sizes',async()=>{
  for (const [products,error] of [[[],'PRODUCT_UNAVAILABLE'],[[{...product,in_stock:false}],'OUT_OF_STOCK'],[[{...product,sizes:['Medium']}],'SIZE_UNAVAILABLE']]) {
    const mails=mock({products}); assert.equal((await (await call()).json()).error,error); assert.equal(mails.length,0);
  }
  globalThis.fetch=async()=>Response.json({success:true,hostname:'evil.test'});
  assert.equal((await call()).status,403);
  mock(); const upstream=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url).includes('sanity.io') ? Promise.reject(new Error('offline')) : upstream(url,options);
  assert.equal((await call()).status,503);
});
test('CORS allows only configured storefront and does not expose legacy admin routes',async()=>{
  const next=async()=>Response.json({ok:true});
  for (const [origin,status] of [['https://shop.test',204],['https://evil.test',403]]) {
    const r=await onRequest({env,next,request:new Request('https://api.test/api/checkout',{method:'OPTIONS',headers:{Origin:origin}})});
    assert.equal(r.status,status); assert.equal(r.headers.get('Access-Control-Allow-Origin'),status===204?origin:null);
  }
  const r=await onRequest({env,next,request:new Request('https://api.test/api/admin/orders')});
  assert.equal(r.status,404);
});
