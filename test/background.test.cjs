const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const extensionUrl = 'chrome-extension://fixture/';
const ai = (explanation = 'fixture explanation') => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ explanation, concepts: [{ name: 'child', why: 'related' }] }) } }] }) });

function fixture({ nodes = [], fetcher = async () => ai() } = {}) {
  const state = { tree: { nodes }, settings: { baseUrl: 'https://example.org/v1', model: 'fixture-model', apiKey: 'synthetic-private-value' } };
  let listener;
  let failWrites = 0;
  const context = vm.createContext({
    console, URL, AbortSignal, Set, Map, Promise, Date, crypto: { randomUUID },
    fetch: fetcher,
    chrome: {
      runtime: { id: 'fixture', getURL: (value) => extensionUrl + value, onMessage: { addListener: (fn) => { listener = fn; } }, onInstalled: { addListener: () => {} } },
      sidePanel: { setPanelBehavior: async () => {} },
      storage: { local: {
        setAccessLevel: async ({ accessLevel }) => assert.equal(accessLevel, 'TRUSTED_CONTEXTS'),
        get: async (key) => { await Promise.resolve(); return structuredClone({ [key]: state[key] }); },
        set: async (patch) => { await Promise.resolve(); if (failWrites-- > 0) throw new Error('synthetic storage failure'); Object.assign(state, structuredClone(patch)); }
      } }
    }
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  const request = (message, sender = { id: 'fixture', url: extensionUrl + 'sidepanel.html' }) => new Promise((resolve) => listener(message, sender, resolve));
  return { state, request, failNextWrite: () => { failWrites = 1; } };
}

test('concurrent explanations preserve both writes with independent model calls', async () => {
  const responses = [];
  const f = fixture({ fetcher: () => new Promise((resolve) => responses.push(resolve)) });
  const first = f.request({ type: 'explain', concept: 'first' });
  const second = f.request({ type: 'explain', concept: 'second' });
  while (responses.length < 2) await new Promise(setImmediate);
  responses[1](ai('second explanation')); responses[0](ai('first explanation'));
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(f.state.tree.nodes.length, 2);
  assert.deepEqual(f.state.tree.nodes.map((node) => node.name).sort(), ['first', 'second']);
});

test('deleting a parent while AI is pending prevents orphan creation and resurrection', async () => {
  let finish;
  const f = fixture({ nodes: [{ id: 'parent', name: 'parent' }], fetcher: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = f.request({ type: 'explain', concept: 'child', parentId: 'parent' });
  while (!finish) await new Promise(setImmediate);
  assert.equal((await f.request({ type: 'deleteNode', id: 'parent' })).ok, true);
  finish(ai()); const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /已被删除/); assert.equal(f.state.tree.nodes.length, 0);
});

test('deleting one branch while another explanation completes preserves unrelated nodes', async () => {
  const f = fixture({ nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C' }] });
  const [deleted, added] = await Promise.all([f.request({ type: 'deleteNode', id: 'a' }), f.request({ type: 'explain', concept: 'new' })]);
  assert.equal(deleted.data.removed, 2); assert.equal(added.ok, true);
  assert.deepEqual(f.state.tree.nodes.map((node) => node.name).sort(), ['C', 'new']);
});

test('failed write rejects only its own operation and later saves still work', async () => {
  const f = fixture(); f.failNextWrite();
  assert.equal((await f.request({ type: 'explain', concept: 'fail' })).ok, false);
  assert.equal((await f.request({ type: 'explain', concept: 'success' })).ok, true);
  assert.equal(f.state.tree.nodes.length, 1); assert.equal(f.state.tree.nodes[0].name, 'success');
});

test('invalid inputs and missing parents fail before any network call', async () => {
  let calls = 0;
  const f = fixture({ fetcher: async () => { calls++; return ai(); } });
  for (const values of [{ concept: null }, { concept: '' }, { concept: 'x'.repeat(201) }, { concept: 'a', parentId: {} }, { concept: 'a', parentId: 'missing' }]) assert.equal((await f.request({ type: 'explain', ...values })).ok, false);
  assert.equal(calls, 0);
});

test('invalid model JSON does not create empty records', async () => {
  for (const content of ['broken', 'null', '[]', '{}', '{"explanation":"","concepts":[]}', '{"explanation":"ok","concepts":null}']) {
    const f = fixture({ fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) });
    assert.equal((await f.request({ type: 'explain', concept: 'test' })).ok, false);
    assert.equal(f.state.tree.nodes.length, 0);
  }
});

test('settings API masks secrets and keeps existing key on masked save', async () => {
  const f = fixture();
  const settings = (await f.request({ type: 'getSettings' })).data;
  assert.equal(settings.apiKey, '********'); assert.ok(!JSON.stringify(settings).includes('synthetic-private-value'));
  assert.equal((await f.request({ type: 'saveSettings', settings: { ...settings, model: 'updated' } })).ok, true);
  assert.equal(f.state.settings.apiKey, 'synthetic-private-value');
  await f.request({ type: 'saveSettings', settings: { ...settings, apiKey: '' } });
  assert.equal(f.state.settings.apiKey, '');
});

test('content scripts cannot access settings or request model calls', async () => {
  const f = fixture(); const sender = { id: 'fixture', url: 'https://example.org/article', tab: { id: 1 } };
  assert.equal((await f.request({ type: 'getSettings' }, sender)).ok, false);
  assert.equal((await f.request({ type: 'explain', concept: 'private' }, sender)).ok, false);
  assert.equal((await f.request({ type: 'captureSelection', text: 'selected concept' }, sender)).ok, true);
  assert.equal((await f.request({ type: 'getSelection' })).data.text, 'selected concept');
  assert.equal((await f.request({ type: 'getTree' }, { id: 'other', url: extensionUrl + 'sidepanel.html' })).ok, false);
});

test('endpoint joins v1 once and upstream errors never echo secrets', async () => {
  const f = fixture({ fetcher: async (url, options) => {
    assert.equal(url, 'https://example.org/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 401, text: async () => 'synthetic-private-value' };
  } });
  const result = await f.request({ type: 'explain', concept: 'a' });
  assert.equal(result.ok, false); assert.ok(!result.error.includes('synthetic-private-value'));
  const settings = (await f.request({ type: 'getSettings' })).data;
  for (const baseUrl of ['javascript:alert(1)', 'http://example.org', 'https://user:password@example.org', 'https://example.org?key=private']) assert.equal((await f.request({ type: 'saveSettings', settings: { ...settings, baseUrl } })).ok, false);
});

test('export includes roots once and terminates for corrupted cyclic paths', async () => {
  const f = fixture({ nodes: [{ id: 'root', name: 'ROOT', summary: 'text' }, { id: 'a', parentId: 'b', name: 'A' }, { id: 'b', parentId: 'a', name: 'B' }] });
  const exported = await f.request({ type: 'exportTree' });
  assert.equal(exported.ok, true); assert.equal(exported.data.markdown.split('- ROOT').length - 1, 1);
  assert.match(exported.data.markdown, /- A/); assert.match(exported.data.markdown, /- B/);
  assert.equal((await f.request({ type: 'explain', concept: 'child', parentId: 'a' })).ok, false);
});

test('all extension manifest and HTML local resources exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_ui.page, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((item) => [...item.js, ...(item.css || [])])];
  for (const html of [manifest.side_panel.default_path, manifest.options_ui.page]) {
    const body = fs.readFileSync(path.join(root, html), 'utf8');
    for (const match of body.matchAll(/(?:src|href)="([^"]+)"/g)) files.push(match[1]);
  }
  for (const file of files) assert.equal(fs.existsSync(path.join(root, file)), true, file);
});
