import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'style.css'), 'utf8');

const tokens = body => Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(m => [m[1], m[2].toLowerCase()]));
const light = tokens(/(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
const darkOverrides = tokens(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
const schemes = { light, dark: { ...light, ...darkOverrides } };

const channel = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = hex => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// [text token, background token, where it is used]
const PAIRS = [
  ['ink', 'bg', 'body text, textarea, diff pane'],
  ['ink', 'panel', 'cards, labels, buttons, task list'],
  ['ink', 'pod', 'agent names on the floor'],
  ['ink', 'add', 'added diff lines'],
  ['ink', 'del', 'removed diff lines'],
  ['muted', 'bg', 'muted text, placeholder, diff meta lines'],
  ['muted', 'panel', 'muted text in cards, default badge'],
  ['muted', 'pod', 'pod names, roles and tool chips on the floor'],
  ['accent-ink', 'accent', 'primary button label, idle avatar initials'],
  ['working-ink', 'working', 'avatar initials while working'],
  ['warn', 'panel', 'working / awaiting badge text'],
  ['warn', 'bg', 'working / awaiting badge text on page'],
  ['ok', 'panel', 'done / approved badge text, live indicator'],
  ['ok', 'bg', 'ok text on page'],
  ['danger', 'panel', 'failed badge, errors, reject button'],
  ['danger', 'bg', 'errors on page'],
];

test('style.css exposes both colour schemes', () => {
  assert.ok(Object.keys(light).length >= 15, 'light tokens parsed');
  assert.ok(Object.keys(darkOverrides).length >= 10, 'dark overrides parsed');
});

for (const [scheme, t] of Object.entries(schemes)) {
  test(`every text/background pairing is at least 4.5:1 (${scheme})`, () => {
    for (const [fg, bg, use] of PAIRS) {
      assert.ok(t[fg] && t[bg], `token missing: ${fg} or ${bg}`);
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${scheme}: --${fg} ${t[fg]} on --${bg} ${t[bg]} = ${r.toFixed(2)} (${use})`);
    }
  });
}

test('the rules that paint text use the audited tokens', () => {
  const rule = sel => new RegExp(sel.replace(/[.\\^$*+?()[\]{}|]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? '';
  assert.match(rule('.avatar text.init'), /fill:\s*var\(--accent-ink\)/);
  assert.match(rule('.agent.working .avatar text.init'), /fill:\s*var\(--working-ink\)/);
  assert.match(rule('.agent.working .avatar circle'), /fill:\s*var\(--working\)/);
  assert.match(css, /\.badge\.awaiting_approval\s*\{\s*color:\s*var\(--warn\)/);
  assert.match(css, /\.badge\.planning[^{]*\{\s*color:\s*var\(--warn\)/);
  assert.match(css, /\.badge\.done[^{]*\{\s*color:\s*var\(--ok\)/);
  assert.match(css, /\.badge\.failed\s*\{\s*color:\s*var\(--danger\)/);
  assert.match(css, /::placeholder\s*\{\s*color:\s*var\(--muted\)/);
});
