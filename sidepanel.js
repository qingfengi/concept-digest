const input = document.querySelector('#concept');
const form = document.querySelector('#concept-form');
const status = document.querySelector('#status');
const treeElement = document.querySelector('#tree');
let nodes = [];
let selectedId;
let busy = false;

async function request(type, values = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...values });
  if (!result?.ok) throw new Error(result?.error || '扩展服务未响应');
  return result.data;
}

function setStatus(text, error = false) { status.textContent = text; status.className = error ? 'error' : ''; status.setAttribute('role', error ? 'alert' : 'status'); }
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll('button:not(#settings)')) button.disabled = value;
  input.disabled = value;
}

function selectNode(node) {
  selectedId = node.id;
  document.querySelector('#detail').hidden = false;
  document.querySelector('#name').textContent = node.name;
  document.querySelector('#summary').textContent = node.summary || '';
  const related = document.querySelector('#related'); related.replaceChildren();
  for (const concept of node.concepts || []) {
    if (!concept || typeof concept.name !== 'string') continue;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = concept.name; button.title = concept.why || ''; button.disabled = busy;
    button.addEventListener('click', () => void explain(concept.name, node.id)); related.append(button);
  }
  if (!related.children.length) related.textContent = '此记录没有保存衍生概念。';
  for (const button of treeElement.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === selectedId));
}

function renderTree() {
  treeElement.replaceChildren();
  if (!nodes.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '暂无保存的概念'; treeElement.append(empty); return; }
  for (const node of nodes) {
    let parent = node.parentId;
    let depth = 0;
    const seen = new Set([node.id]);
    while (parent && !seen.has(parent)) { seen.add(parent); const found = nodes.find((item) => item.id === parent); if (!found) break; depth++; parent = found.parentId; }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tree-node'; button.textContent = node.name; button.dataset.id = node.id;
    button.style.paddingLeft = `${12 + Math.min(depth, 8) * 12}px`; button.setAttribute('aria-pressed', String(node.id === selectedId)); button.disabled = busy;
    button.addEventListener('click', () => selectNode(node)); treeElement.append(button);
  }
}

async function refresh() {
  const tree = await request('getTree'); nodes = tree.nodes; renderTree();
  if (selectedId) {
    const selected = nodes.find((node) => node.id === selectedId);
    if (selected) selectNode(selected);
    else { selectedId = undefined; document.querySelector('#detail').hidden = true; }
  }
}

async function explain(concept, parentId) {
  if (busy || !concept.trim()) return;
  setBusy(true); setStatus('正在解释…');
  try {
    const result = await request('explain', { concept: concept.trim(), parentId });
    await refresh(); selectNode(result.node); setStatus('解释与概念已保存');
    if (!parentId) input.value = '';
  } catch (error) { setStatus(error.message || '解释未完成，输入已保留', true); }
  finally { setBusy(false); }
}

form.addEventListener('submit', (event) => { event.preventDefault(); void explain(input.value); });
document.querySelector('#settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
document.querySelector('#selection').addEventListener('click', async () => {
  try { const result = await request('getSelection'); if (!result.text) { setStatus('请先在网页上选中不超过 200 字的文字'); return; } input.value = result.text; input.focus(); setStatus('已读取选词，点击“解释并保存”继续'); }
  catch (error) { setStatus(error.message, true); }
});
document.querySelector('#refresh').addEventListener('click', () => void refresh().then(() => setStatus('已刷新')).catch((error) => setStatus(error.message, true)));
document.querySelector('#delete').addEventListener('click', async () => {
  if (busy || !selectedId || !window.confirm('删除此概念及其全部子概念？')) return;
  setBusy(true);
  try { await request('deleteNode', { id: selectedId }); await refresh(); setStatus('概念已删除'); }
  catch (error) { setStatus(error.message, true); }
  finally { setBusy(false); }
});
document.querySelector('#export').addEventListener('click', async () => {
  try {
    const { markdown } = await request('exportTree');
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'concept-tree.md'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setStatus('导出已开始');
  } catch (error) { setStatus(error.message, true); }
});
void refresh().catch((error) => setStatus(error.message, true));
