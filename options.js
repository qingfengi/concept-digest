const form = document.querySelector('#settings-form');
const baseUrl = document.querySelector('#base-url');
const model = document.querySelector('#model');
const key = document.querySelector('#api-key');
const clearKey = document.querySelector('#clear-key');
const save = document.querySelector('#save');
const status = document.querySelector('#status');
let savedKey = '';

function show(text, error = false) { status.textContent = text; status.className = error ? 'error' : ''; status.setAttribute('role', error ? 'alert' : 'status'); }
async function request(type, values = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...values });
  if (!result?.ok) throw new Error(result?.error || '扩展服务未响应');
  return result.data;
}
function fill(settings) {
  baseUrl.value = settings.baseUrl; model.value = settings.model; savedKey = settings.apiKey; key.value = ''; clearKey.checked = false; key.disabled = false;
  key.placeholder = savedKey ? '已保存；留空保留原密钥' : '输入密钥，本机服务可留空';
}
clearKey.addEventListener('change', () => { key.disabled = clearKey.checked; });
form.addEventListener('submit', async (event) => {
  event.preventDefault(); save.disabled = true; show('正在保存…');
  try {
    const settings = await request('saveSettings', { settings: { baseUrl: baseUrl.value.trim(), model: model.value.trim(), apiKey: clearKey.checked ? '' : key.value || savedKey } });
    fill(settings); show('设置已保存');
  } catch (error) { show(error.message, true); }
  finally { save.disabled = false; }
});
void request('getSettings').then(fill).catch((error) => show(error.message, true));
