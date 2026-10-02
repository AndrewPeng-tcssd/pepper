const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMailer } = require('../mailer');

test('Resend test sender sends only to the account email', async () => {
  const requests = [];
  const mailer = createMailer({
    RESEND_API_KEY: 're_test_key',
    RESEND_TEST_EMAIL: 'owner@example.test'
  }, async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ id: 'message-id' }) };
  });
  assert.equal(mailer.canSendTo('OWNER@example.test'), true);
  assert.equal(mailer.canSendTo('other@example.test'), false);
  await mailer.sendVerification({
    to: 'owner@example.test', purpose: 'signup',
    url: 'http://localhost:3000/verify.html?token=example'
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer re_test_key');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.to, ['owner@example.test']);
  assert.match(body.text, /verify\.html\?token=example/);
  await assert.rejects(
    mailer.sendVerification({ to: 'other@example.test', purpose: 'signup', url: 'http://localhost:3000/' }),
    { code: 'RESEND_TEST_RECIPIENT_ONLY' }
  );
  assert.equal(requests.length, 1);
});

test('Resend API errors do not count as accepted email', async () => {
  const mailer = createMailer({
    RESEND_API_KEY: 're_test_key',
    RESEND_TEST_EMAIL: 'owner@example.test'
  }, async () => ({ ok: false, status: 403 }));
  await assert.rejects(
    mailer.sendVerification({ to: 'owner@example.test', purpose: 'login', url: 'http://localhost:3000/' }),
    { code: 'RESEND_HTTP_403' }
  );
  assert.equal(createMailer({ RESEND_API_KEY: 're_test_key' }), null);
});

test('Verified-domain sender permits other recipient addresses', async () => {
  let sent;
  const mailer = createMailer({
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM: 'Pepper TCG <noreply@example.com>'
  }, async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: 'message-id' }) };
  });
  assert.equal(mailer.canSendTo('player@another.example'), true);
  await mailer.sendVerification({
    to: 'player@another.example', purpose: 'signup',
    url: 'http://localhost:3000/verify.html?token=example'
  });
  assert.equal(sent.from, 'Pepper TCG <noreply@example.com>');
  assert.deepEqual(sent.to, ['player@another.example']);
});
