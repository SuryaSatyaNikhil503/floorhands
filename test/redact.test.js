import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../server/redact.js';

test('redacts well-known token shapes', () => {
  const cases = [
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_' + 'a'.repeat(36),
    'github_pat_' + 'A1_'.repeat(10),
    'sk-ant-api03-' + 'x'.repeat(30),
    'sk-proj-' + 'y'.repeat(40),
    'xoxb-1234567890-abcdef',
    'AIza' + 'b'.repeat(35),
    'npm_' + 'c'.repeat(36),
    'sk_live_' + 'd'.repeat(24),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];
  for (const c of cases) {
    const out = redact(`found ${c} in config`);
    assert.ok(!out.includes(c), c);
    assert.match(out, /\[REDACTED/);
  }
});

test('redacts a PEM private key block whole', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(`key:\n${pem}\nend`), 'key:\n[REDACTED private key]\nend');
});

test('redacts the password in a URL but keeps user and host', () => {
  assert.equal(redact('DATABASE_URL=postgres://app:hunter2secret@db.internal:5432/x'), 'DATABASE_URL=postgres://app:[REDACTED]@db.internal:5432/x');
});

test('redacts a quoted literal assigned to a secret-looking name, keeping the finding readable', () => {
  assert.equal(redact('const JWT_SECRET = "dev-secret-123456";'), 'const JWT_SECRET = "[REDACTED]";');
  assert.equal(redact("api_key: 'abcd1234efgh'"), "api_key: '[REDACTED]'");
  assert.equal(redact('"password": "correct horse"'), '"password": "correct horse"', 'contains a space: prose, not a credential');
});

test('leaves code that merely mentions secrets alone', () => {
  const code = 'const password = req.body.password;\nif (!token) return 401; // check the api_key header';
  assert.equal(redact(code), code);
  assert.equal(redact('src/auth.ts:12 hardcoded JWT secret'), 'src/auth.ts:12 hardcoded JWT secret');
});

test('passes non-strings and empty strings through', () => {
  assert.equal(redact(''), '');
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(null), null);
});
