import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFloor, initials } from '../ui/floor.js';

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const read = f => fs.readFileSync(path.join(uiDir, f), 'utf8');
const uiScripts = fs.readdirSync(uiDir).filter(f => f.endsWith('.js'));

const roster = {
  pods: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
  agents: [
    { id: 'a1', pod: 'a' }, { id: 'a2', pod: 'a' }, { id: 'a3', pod: 'a', lead: true }, { id: 'a4', pod: 'a' },
    { id: 'b1', pod: 'b', lead: true }, { id: 'b2', pod: 'b' },
    { id: 'c1', pod: 'c', lead: true }, { id: 'c2', pod: 'c' }, { id: 'c3', pod: 'c' },
  ],
};

test('every agent gets exactly one desk, inside its own pod', () => {
  const f = layoutFloor(roster);
  assert.equal(f.pods.length, 3);
  const desks = f.pods.flatMap(p => p.desks.map(d => ({ ...d, pod: p })));
  assert.equal(desks.length, 9);
  assert.deepEqual(desks.map(d => d.agentId).sort(), roster.agents.map(a => a.id).sort());
  for (const d of desks) {
    assert.ok(d.x > d.pod.x + 40 && d.x < d.pod.x + d.pod.w - 40, `${d.agentId} inside pod horizontally`);
    assert.ok(d.y > d.pod.y + 48 && d.y < d.pod.y + d.pod.h, `${d.agentId} inside pod vertically`);
  }
});

test('desks never overlap and pods do not overlap', () => {
  const f = layoutFloor(roster);
  const desks = f.pods.flatMap(p => p.desks);
  for (let i = 0; i < desks.length; i++) for (let j = i + 1; j < desks.length; j++) {
    const dx = Math.abs(desks[i].x - desks[j].x), dy = Math.abs(desks[i].y - desks[j].y);
    assert.ok(dx >= 170 || dy >= 130, `${desks[i].agentId} overlaps ${desks[j].agentId}`);
  }
  for (let i = 1; i < f.pods.length; i++) assert.ok(f.pods[i].x >= f.pods[i - 1].x + f.pods[i - 1].w);
  assert.ok(f.pods.every(p => p.x + p.w <= f.width && p.y + p.h <= f.height));
});

test('the lead takes the first desk', () => {
  const a = layoutFloor(roster).pods[0];
  assert.equal(a.desks[0].agentId, 'a3');
});

test('initials uses the first letters of up to two words', () => {
  assert.equal(initials('FE REVIEWER'), 'FR');
  assert.equal(initials('ARCHITECT'), 'A');
  assert.equal(initials('FRONT-END ENGINEER'), 'FE');
  assert.equal(initials('SRE'), 'S');
});

test('initials copes with odd input', () => {
  assert.equal(initials('  front  end '), 'FE');
  assert.equal(initials(''), '');
  assert.equal(initials(undefined), '');
  assert.equal(initials(null), '');
  assert.equal(initials(42), '4');
});

test('an agent whose pod is unknown lands in an UNASSIGNED fallback pod instead of vanishing', () => {
  const f = layoutFloor({ pods: [{ id: 'a', name: 'A' }], agents: [{ id: 'a1', pod: 'a' }, { id: 'x1', pod: 'ghost' }, { id: 'x2' }] });
  assert.equal(f.pods.length, 2);
  assert.equal(f.pods[1].name, 'UNASSIGNED');
  assert.deepEqual(f.pods[1].desks.map(d => d.agentId).sort(), ['x1', 'x2']);
  assert.ok(f.pods[1].x >= f.pods[0].x + f.pods[0].w);
  assert.ok(f.pods.every(p => p.x + p.w <= f.width && p.y + p.h <= f.height));
});

test('no UNASSIGNED pod appears when every agent has a pod', () => {
  assert.ok(!layoutFloor(roster).pods.some(p => p.name === 'UNASSIGNED'));
});

test('prototype-looking ids and missing arrays are harmless', () => {
  const f = layoutFloor({ pods: [{ id: '__proto__', name: 'P' }], agents: [{ id: 'z', pod: '__proto__' }, { id: 'constructor', pod: 'constructor' }] });
  assert.deepEqual(f.pods.map(p => p.name), ['P', 'UNASSIGNED']);
  assert.equal(f.pods[0].desks.length, 1);
  assert.equal(f.pods[1].desks[0].agentId, 'constructor');
  assert.deepEqual(layoutFloor({}).pods, []);
  assert.deepEqual(layoutFloor({ pods: [{ id: 'e', name: 'E' }] }).pods[0].desks, []);
});

test('stacked layout: one column, same pod width, nothing overlaps, desks inside their pods', () => {
  const wide = layoutFloor(roster);
  const f = layoutFloor(roster, { stack: true });
  assert.equal(f.pods.length, 3);
  const podW = wide.pods[0].w;
  assert.ok(f.pods.every(p => p.w === podW && p.x === f.pods[0].x));
  assert.equal(f.width, podW + 2 * 28);
  assert.ok(f.width < wide.width);
  for (let i = 1; i < f.pods.length; i++) assert.ok(f.pods[i].y >= f.pods[i - 1].y + f.pods[i - 1].h, 'pods stack without overlap');
  assert.ok(f.pods.every(p => p.x + p.w <= f.width && p.y + p.h <= f.height));
  const desks = f.pods.flatMap(p => p.desks.map(d => ({ ...d, pod: p })));
  assert.equal(desks.length, 9);
  for (const d of desks) {
    assert.ok(d.x > d.pod.x + 40 && d.x < d.pod.x + d.pod.w - 40, `${d.agentId} inside pod horizontally`);
    assert.ok(d.y > d.pod.y + 48 && d.y < d.pod.y + d.pod.h, `${d.agentId} inside pod vertically`);
  }
  for (let i = 0; i < desks.length; i++) for (let j = i + 1; j < desks.length; j++) {
    const dx = Math.abs(desks[i].x - desks[j].x), dy = Math.abs(desks[i].y - desks[j].y);
    assert.ok(dx >= 170 || dy >= 130, `${desks[i].agentId} overlaps ${desks[j].agentId}`);
  }
  assert.equal(f.pods[0].desks[0].agentId, 'a3', 'lead still first');
});

test('stack: false (or no options) keeps the side-by-side layout', () => {
  assert.deepEqual(layoutFloor(roster, { stack: false }), layoutFloor(roster));
});

const SCANNED = [...uiScripts, 'index.html'];

test('ui sources never use HTML-injecting or code-evaluating APIs', () => {
  assert.ok(uiScripts.includes('app.js') && uiScripts.includes('floor.js') && uiScripts.includes('model.js'));
  const banned = [
    /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /setHTMLUnsafe/, /DOMParser/, /createContextualFragment/, /srcdoc/i,
    /javascript:/i, /\bFunction\s*\(/, /new\s+Function/, /\bimport\s*\(/, /\beval\b/,
    /\b(?:setTimeout|setInterval)\s*\(\s*['"`]/, /['"`]on['"`]\s*\+/,
  ];
  for (const f of SCANNED) {
    const src = read(f);
    for (const re of banned) assert.ok(!re.test(src), `${f} must not match ${re}`);
  }
});

test('ui files contain no external URLs', () => {
  for (const f of [...SCANNED, 'style.css']) {
    const src = read(f);
    // the SVG namespace identifier is a name, not a fetched resource
    const urls = src.replaceAll('http://www.w3.org/2000/svg', '').match(/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}/gi);
    assert.equal(urls, null, `${f} must not reference external URLs`);
  }
});

test('index.html complies with the strict CSP: no inline script, style or handlers', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    assert.equal(body.trim(), '', 'script tags must have no inline body');
    assert.match(attrs, /\bsrc="\//, 'script must load a same-origin file');
  }
  assert.ok(!/<style\b/i.test(html), 'no inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no style= attributes');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no on*= handlers');
});

test('app.js builds elements only through the allowlisted helper', () => {
  const src = read('app.js');
  assert.ok(!/\.style\b/.test(src) && !/['"]style['"]/.test(src), 'no style manipulation');
  assert.ok(!/setAttribute\(\s*['"]on/.test(src));
  assert.match(src, /isAllowedAttr\(/);
});

test('floor accessibility markup: group role with a title, status text hidden visually via a class', () => {
  const html = read('index.html');
  assert.match(html, /<svg id="floor"[^>]*role="group"/);
  assert.ok(!/<svg[^>]*role="img"/.test(html));
  assert.match(html, /id="conn-text"[^>]*aria-live="polite"/);
  assert.match(html, /id="boot"[^>]*aria-live="assertive"/);
  assert.match(read('style.css'), /\.sr-only\s*\{[^}]*clip/);
});

test('the project notes line is a static element filled with textContent only', () => {
  const html = read('index.html');
  assert.match(html, /<p id="notes-line"[^>]*class="muted"[^>]*><\/p>/);
  const src = read('app.js');
  assert.match(src, /\$\('#notes-line'\)\.textContent\s*=/);
  assert.match(src, /Project notes: none · create /);
  assert.match(src, /Project notes: \$\{[^}]+\} bytes · edit /);
  assert.ok(!/notes[^\n]*innerHTML/i.test(src));
});
