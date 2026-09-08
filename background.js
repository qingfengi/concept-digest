const DEFAULT_SETTINGS = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' };
const MASKED_KEY = '********';
const SYSTEM_PROMPT = `你是一个概念讲解助手。用中文解释用户的概念，只返回 JSON：
{"explanation":"一句定义、直觉理解和关键要点","concepts":[{"name":"相关概念","why":"与当前概念的关系"}]}
给出 3 到 5 个直接相关的概念，不重复已有路径，不确定时明确说明，不编造。`;
let treeWrites = Promise.resolve();
let selection = '';

const storageReady = chrome.storage.local.setAccessLevel
  ? chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  : Promise.resolve();

async function getSettings() {
  await storageReady;
  const saved = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...saved.settings };
}

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('设置格式无效');
  let url;
  try { url = new URL(settings.baseUrl); } catch { throw new Error('请填写有效的服务地址'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址须使用 HTTPS，或本机 HTTP 地址，且不含凭据、查询参数和片段');
  }
  if (typeof settings.model !== 'string' || !settings.model.trim() || settings.model.length > 200) throw new Error('请填写模型名称');
  if (typeof settings.apiKey !== 'string' || settings.apiKey.length > 8192) throw new Error('密钥格式无效');
  return { baseUrl: url.href.replace(/\/+$/, ''), model: settings.model.trim(), apiKey: settings.apiKey };
}

async function saveSettings(settings) {
  const current = await getSettings();
  const next = validateSettings({ ...settings, apiKey: settings.apiKey === MASKED_KEY ? current.apiKey : settings.apiKey });
  await chrome.storage.local.set({ settings: next });
  return { ...next, apiKey: next.apiKey ? MASKED_KEY : '' };
}

async function getTree() {
  await storageReady;
  const saved = await chrome.storage.local.get('tree');
  if (!saved.tree) return { nodes: [] };
  if (!Array.isArray(saved.tree.nodes) || saved.tree.nodes.some((node) => !node || typeof node.id !== 'string' || typeof node.name !== 'string')) throw new Error('概念树数据格式异常，未覆盖现有记录');
  return saved.tree;
}

function mutateTree(change) {
  const result = treeWrites.then(async () => {
    const tree = await getTree();
    const value = change(tree);
    await chrome.storage.local.set({ tree });
    return value;
  });
  // Network calls stay concurrent; only the latest read/modify/write is serialized.
  treeWrites = result.catch(() => {});
  return result;
}

function conceptPath(nodeId, tree) {
  const path = [];
  const seen = new Set();
  let current = tree.nodes.find((node) => node.id === nodeId);
  if (!current) throw new Error('父概念已不存在，请从根概念重新开始');
  while (current) {
    if (seen.has(current.id)) throw new Error('概念路径存在循环，无法继续解释');
    seen.add(current.id);
    path.unshift(current.name);
    current = current.parentId ? tree.nodes.find((node) => node.id === current.parentId) : undefined;
  }
  return path;
}

async function callAI(concept, path) {
  const settings = validateSettings(await getSettings());
  const url = new URL(settings.baseUrl);
  if (!settings.apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('请先在设置中填写 API 密钥');
  const base = settings.baseUrl.replace(/\/+$/, '');
  const endpoint = /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: settings.model, temperature: 0.3, messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${path.length ? `概念路径：${path.join(' > ')}\n` : ''}请讲解：${concept}` }
      ] })
    });
  } catch { throw new Error('AI 连接失败或超时，请检查网络与服务设置'); }
  if (!response.ok) throw new Error(`AI 请求失败（HTTP ${response.status}），请检查服务设置`);
  let parsed;
  try {
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    // OpenAI-compatible providers may return either a string or text parts.
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((part) => part && typeof part.text === 'string').map((part) => part.text).join('')
        : '';
    if (!text.trim()) throw new Error();
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch { throw new Error('AI 返回的 JSON 无效，记录尚未保存'); }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.explanation !== 'string' || !parsed.explanation.trim() || parsed.explanation.length > 12000 || !Array.isArray(parsed.concepts)) throw new Error('AI 返回缺少有效的解释或概念列表');
  const seen = new Set([...path, concept]);
  const concepts = [];
  for (const item of parsed.concepts.slice(0, 20)) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || typeof item.why !== 'string' || item.why.length > 1000) continue;
    const name = item.name.trim();
    if (!seen.has(name) && concepts.length < 5) { concepts.push({ name, why: item.why.trim() }); seen.add(name); }
  }
  return { explanation: parsed.explanation.trim(), concepts };
}

async function explainConcept({ concept, parentId }) {
  if (typeof concept !== 'string' || !concept.trim() || concept.length > 200) throw new Error('概念需为 1 到 200 个字符');
  if (parentId != null && (typeof parentId !== 'string' || parentId.length > 200)) throw new Error('父概念编号无效');
  const tree = await getTree();
  const path = parentId ? conceptPath(parentId, tree) : [];
  const ai = await callAI(concept.trim(), path);
  return mutateTree((latest) => {
    if (parentId && !latest.nodes.some((node) => node.id === parentId)) throw new Error('父概念已被删除，本次解释未保存');
    const node = { id: `n_${crypto.randomUUID()}`, name: concept.trim(), parentId: parentId || null, summary: ai.explanation, concepts: ai.concepts, createdAt: Date.now() };
    latest.nodes.push(node);
    return { node, ...ai };
  });
}

async function deleteNode(id) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('概念编号无效');
  return mutateTree((tree) => {
    const removed = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of tree.nodes) if (removed.has(node.parentId) && !removed.has(node.id)) { removed.add(node.id); changed = true; }
    }
    const before = tree.nodes.length;
    tree.nodes = tree.nodes.filter((node) => !removed.has(node.id));
    return { ok: true, removed: before - tree.nodes.length };
  });
}

async function exportTree() {
  const tree = await getTree();
  const lines = ['# 概念树', ''];
  const seen = new Set();
  const byParent = new Map();
  for (const node of tree.nodes) {
    const parent = node.parentId || '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(node);
  }
  function walk(roots) {
    const stack = roots.slice().reverse().map((node) => ({ node, depth: 0 }));
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      lines.push(`${'  '.repeat(depth)}- ${node.name.replace(/[\r\n]+/g, ' ')}`);
      if (typeof node.summary === 'string') lines.push(`${'  '.repeat(depth + 1)}> ${node.summary.replace(/[\r\n]+/g, ' ')}`);
      for (const child of (byParent.get(node.id) || []).slice().reverse()) stack.push({ node: child, depth: depth + 1 });
    }
  }
  walk(byParent.get('') || []);
  walk(tree.nodes.filter((node) => !seen.has(node.id)));
  return { markdown: lines.join('\n') };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') throw new Error('消息来源无效');
      if (message.type === 'captureSelection' && sender.tab) {
        if (typeof message.text !== 'string' || message.text.length > 200) throw new Error('选择的文字过长');
        selection = message.text.trim();
        sendResponse({ ok: true });
        return;
      }
      if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('该操作仅允许扩展页面调用');
      let data;
      switch (message.type) {
        case 'explain': data = await explainConcept(message); break;
        case 'getTree': data = await getTree(); break;
        case 'deleteNode': data = await deleteNode(message.id); break;
        case 'exportTree': data = await exportTree(); break;
        case 'getSelection': data = { text: selection }; break;
        case 'getSettings': { const settings = await getSettings(); data = { ...settings, apiKey: settings.apiKey ? MASKED_KEY : '' }; break; }
        case 'saveSettings': data = await saveSettings(message.settings); break;
        default: throw new Error('未知操作');
      }
      sendResponse({ ok: true, data });
    } catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作未完成' }); }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
