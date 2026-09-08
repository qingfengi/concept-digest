// Development-only real-browser verification. Uses a disposable profile and local mock AI.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.CONCEPT_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(root, 'qa'), { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'qa', 'browser-'));
  process.env.TEMP = directory;
  process.env.TMP = directory;
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/article') {
      response.setHeader('Content-Type', 'text/html;charset=utf-8');
      response.end('<!doctype html><html lang="zh"><body><p id="term">网页选词测试</p><input type="password" value="private-fixture"></body></html>');
      return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 32768) { response.writeHead(413); response.end(); return; } }
    const data = JSON.parse(body);
    requests.push(data);
    const concept = data.messages.at(-1).content.split('请讲解：').at(-1);
    if (concept === '失败测试') { response.writeHead(503); response.end('synthetic-private-upstream-body'); return; }
    const content = JSON.stringify({ explanation: `${concept}：这是本机测试解释，用来验证保存与递归。`, concepts: [{ name: `${concept}的子概念`, why: '用于验证递归路径' }] });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
      ...(process.env.CONCEPT_BROWSER_EXECUTABLE ? { executablePath: process.env.CONCEPT_BROWSER_EXECUTABLE } : { channel: 'chromium' }),
      headless: false,
      viewport: { width: 1000, height: 780 },
      acceptDownloads: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    });
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).hostname;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#base-url').fill(base);
    await options.locator('#model').fill('local-fixture');
    await options.locator('#api-key').fill('');
    await options.locator('#save').click();
    await options.locator('#status').filter({ hasText: '设置已保存' }).waitFor();
    assert.equal(await options.locator('#api-key').inputValue(), '');

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.setViewportSize({ width: 410, height: 780 });
    await panel.locator('#concept').fill('量化交易');
    await panel.locator('#explain').click();
    await panel.locator('#status').filter({ hasText: '解释与概念已保存' }).waitFor();
    assert.equal(await panel.locator('#name').innerText(), '量化交易');
    await panel.locator('#related button').click();
    await panel.locator('#status').filter({ hasText: '解释与概念已保存' }).waitFor();
    assert.equal(await panel.locator('#name').innerText(), '量化交易的子概念');
    assert.match(requests[1].messages.at(-1).content, /概念路径：量化交易/);
    assert.equal(await panel.locator('#tree button').count(), 2);
    const overflow = await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await panel.screenshot({ path: path.join(directory, 'concept-panel.png'), fullPage: true });
    await panel.reload();
    await panel.locator('#tree button').nth(1).waitFor();
    await panel.locator('#tree button').nth(1).click();
    assert.equal(await panel.locator('#name').innerText(), '量化交易的子概念');
    const downloaded = panel.waitForEvent('download');
    await panel.locator('#export').click();
    const download = await downloaded;
    const exported = path.join(directory, 'concept-tree.md');
    await download.saveAs(exported);
    const markdown = await fs.readFile(exported, 'utf8');
    assert.match(markdown, /- 量化交易\n/);
    assert.match(markdown, /  - 量化交易的子概念/);

    const article = await context.newPage();
    await article.goto(`${base}/article`);
    await article.locator('#term').selectText();
    await article.locator('#term').dispatchEvent('mouseup');
    await panel.bringToFront();
    await panel.locator('#selection').click();
    await panel.waitForFunction(() => document.querySelector('#concept').value === '网页选词测试');
    await panel.locator('#explain').click();
    await panel.locator('#status').filter({ hasText: '解释与概念已保存' }).waitFor();
    assert.equal(await panel.locator('#tree button').count(), 3);

    await panel.locator('#concept').fill('失败测试');
    await panel.locator('#explain').click();
    await panel.locator('#status').filter({ hasText: 'HTTP 503' }).waitFor();
    assert.equal(await panel.locator('#concept').inputValue(), '失败测试');
    assert.equal(await panel.locator('#tree button').count(), 3);
    assert.ok(!(await panel.locator('#status').innerText()).includes('synthetic-private-upstream-body'));

    await panel.locator('#tree button').first().click();
    panel.once('dialog', (dialog) => dialog.accept());
    await panel.locator('#delete').click();
    await panel.locator('#status').filter({ hasText: '概念已删除' }).waitFor();
    assert.equal(await panel.locator('#tree button').count(), 1);
    assert.deepEqual(errors, []);
    const result = { browser: await context.browser().version(), extensionId: id,
      verified: ['settings', 'explanation', 'recursive path', 'reload persistence', 'Markdown download', 'web selection', 'failure retains input without saving or exposing upstream body', 'branch deletion', '410px no overflow'],
      limitation: 'Extension pages tested in actual browser tabs; toolbar-opened native side panel not exercised.',
      mockRequests: requests.length, output: directory };
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
