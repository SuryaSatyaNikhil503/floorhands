#!/usr/bin/env node
// Stand-in for the `claude` CLI for tests and UI demos (FLOORHANDS_CLAUDE_BIN=scripts/fake-claude.mjs).
// Reads the prompt on stdin and prints stream-json lines like the real CLI does.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const tools = [];
const ti = args.indexOf('--tools');
if (ti >= 0) for (let i = ti + 1; i < args.length && !args[i].startsWith('--'); i++) tools.push(args[i]);

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const use = (name, input) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const mi = args.indexOf('--model');
const model = mi >= 0 ? args[mi + 1] : 'default';
out({ type: 'system', subtype: 'init', tools, model, claude_code_version: '0.0.0-fake' });
// Like the real CLI, make one model request to ANTHROPIC_BASE_URL when it is set (the spending guard, in front of a fake API in the
// tests), so the whole chain is exercised. Without it (UI demos) nothing is sent anywhere.
if (process.env.ANTHROPIC_BASE_URL) {
  const r = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? 'fake' },
    body: JSON.stringify({ model: model === 'default' ? 'claude-haiku-5-5' : `claude-${model}-5-5`, max_tokens: 1000, messages: [{ role: 'user', content: prompt.slice(0, 2000) }] }) });
  if (!r.ok) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `API ${r.status}: ${(await r.text()).slice(0, 200)}` }); process.exit(1); }
  await r.text();
}
await new Promise(r => setTimeout(r, 150));

let result;
if (prompt.includes('Team roster')) {
  const fence = '`'.repeat(3);
  use('Read', { file_path: 'README.md' });
  const plan = { summary: 'Add a demo note, then review it.', steps: [{ agent: 'fe', task: 'Create FLOORHANDS_DEMO.md with one line.' }, { agent: 'rfe', task: 'Review the change.' }] };
  result = `${fence}json\n${JSON.stringify(plan)}\n${fence}`;
} else if (tools.includes('Edit')) {
  use('Write', { file_path: 'FLOORHANDS_DEMO.md' });
  fs.writeFileSync(path.join(process.cwd(), 'FLOORHANDS_DEMO.md'), 'Hello from the team.\n');
  result = 'Created FLOORHANDS_DEMO.md.';
} else {
  use('Read', { file_path: 'FLOORHANDS_DEMO.md' });
  result = 'Reviewed: looks fine. No critical issues.';
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: result }] } });
out({
  type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01, duration_ms: 150, num_turns: 2, permission_denials: [],
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { [model]: {} },
});
