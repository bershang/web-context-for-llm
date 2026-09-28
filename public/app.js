const apiKeyInput = document.querySelector('#apiKey');
const configNameInput = document.querySelector('#configName');
const urlList = document.querySelector('#urlList');
const urlRowTemplate = document.querySelector('#urlRowTemplate');
const addUrlBtn = document.querySelector('#addUrlBtn');
const testBtn = document.querySelector('#testBtn');
const loadBtn = document.querySelector('#loadBtn');
const checkStatusBtn = document.querySelector('#checkStatusBtn');
const actionMessage = document.querySelector('#actionMessage');
const statusBadge = document.querySelector('#statusBadge');
const resultOutput = document.querySelector('#resultOutput');
const sourceSummary = document.querySelector('#sourceSummary');
const recentList = document.querySelector('#recentList');
const textViewBtn = document.querySelector('#textViewBtn');
const payloadViewBtn = document.querySelector('#payloadViewBtn');

const RECENT_KEY = 'webContextForLlmRecentConfigsV1';
let lastTestPayload = null;
let currentView = 'text';

function setMessage(message, kind = '') {
  actionMessage.textContent = message;
  actionMessage.className = `action-message ${kind}`.trim();
}

function getApiKey() { return apiKeyInput.value.trim(); }
function persistApiKeyForTab() { sessionStorage.setItem('webContextApiKey', getApiKey()); }

function addUrlRow(value = '') {
  const row = urlRowTemplate.content.firstElementChild.cloneNode(true);
  const input = row.querySelector('.url-input');
  const removeBtn = row.querySelector('.remove-url');
  input.value = value;
  removeBtn.addEventListener('click', () => {
    if (urlList.children.length === 1) input.value = '';
    else row.remove();
  });
  urlList.appendChild(row);
}

function getUrls() {
  return [...document.querySelectorAll('.url-input')]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function setUrls(urls) {
  urlList.innerHTML = '';
  (urls.length ? urls : ['']).forEach(addUrlRow);
}

function getRecentConfigs() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}

function saveRecentConfig() {
  const name = configNameInput.value.trim() || `Configuration ${new Date().toLocaleDateString()}`;
  const urls = getUrls();
  if (!urls.length) return;
  const existing = getRecentConfigs().filter((item) => item.name !== name);
  localStorage.setItem(RECENT_KEY, JSON.stringify([{ name, urls, savedAt: new Date().toISOString() }, ...existing].slice(0, 3)));
  renderRecentConfigs();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function renderRecentConfigs() {
  const configs = getRecentConfigs();
  recentList.innerHTML = '';
  if (!configs.length) {
    recentList.innerHTML = '<p class="empty">No saved configurations yet.</p>';
    return;
  }
  for (const config of configs) {
    const button = document.createElement('button');
    button.className = 'recent-item';
    button.innerHTML = `<strong>${escapeHtml(config.name)}</strong><span>${config.urls.length} URL${config.urls.length === 1 ? '' : 's'}</span>`;
    button.addEventListener('click', () => {
      configNameInput.value = config.name;
      setUrls(config.urls);
      setMessage(`Loaded “${config.name}” into the form.`, 'ok');
    });
    recentList.appendChild(button);
  }
}

async function apiRequest(path, options = {}) {
  const key = getApiKey();
  if (!key) throw new Error('Enter the API key first.');
  persistApiKeyForTab();

  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(typeof payload === 'object' ? payload.error : payload || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function setBusy(value) {
  testBtn.disabled = value;
  loadBtn.disabled = value;
  checkStatusBtn.disabled = value;
}

function renderSources(payload) {
  sourceSummary.innerHTML = '';
  if (!payload?.sources?.length) return;
  for (const source of payload.sources) {
    const item = document.createElement('div');
    item.className = `source-chip ${source.success ? 'success' : 'error'}`;
    item.innerHTML = source.success
      ? `<strong>${escapeHtml(source.title || source.url)}</strong><span>HTTP ${source.status} · ${source.characters.toLocaleString()} chars · ${escapeHtml(source.extractionMethod)}</span>`
      : `<strong>${escapeHtml(source.url)}</strong><span>${escapeHtml(source.error || 'Error')}</span>`;
    sourceSummary.appendChild(item);
  }
}

function renderResult() {
  textViewBtn.classList.toggle('active', currentView === 'text');
  payloadViewBtn.classList.toggle('active', currentView === 'payload');
  if (!lastTestPayload) {
    resultOutput.textContent = 'No extraction has been run yet.';
    return;
  }
  resultOutput.textContent = currentView === 'text' ? lastTestPayload.context : JSON.stringify(lastTestPayload, null, 2);
}

async function testContext() {
  const urls = getUrls();
  if (!urls.length) return setMessage('Add at least one URL.', 'error');
  setBusy(true); setMessage('Fetching and normalizing sources…');
  try {
    const payload = await apiRequest('/api/context/test', { method: 'POST', body: JSON.stringify({ urls }) });
    lastTestPayload = payload; currentView = 'text'; renderSources(payload); renderResult();
    setMessage(`Extraction complete: ${payload.successfulUrls}/${payload.totalUrls} usable sources, ${payload.totalCharacters.toLocaleString()} characters.`, 'ok');
  } catch (error) {
    lastTestPayload = error.payload || null; renderSources(lastTestPayload); renderResult(); setMessage(error.message, 'error');
  } finally { setBusy(false); }
}

async function loadContext() {
  const urls = getUrls();
  if (!urls.length) return setMessage('Add at least one URL.', 'error');
  setBusy(true); setMessage('Building and loading context into memory…');
  try {
    const payload = await apiRequest('/api/context/load', { method: 'POST', body: JSON.stringify({ urls }) });
    saveRecentConfig(); await refreshStatus();
    setMessage(`Active context: ${payload.sourceCount} sources, ${payload.characters.toLocaleString()} characters.`, 'ok');
  } catch (error) { setMessage(error.message, 'error'); }
  finally { setBusy(false); }
}

async function refreshStatus() {
  try {
    const status = await apiRequest('/api/status');
    if (status.loaded) {
      statusBadge.className = 'status-badge ready';
      const time = status.updatedAt ? new Date(status.updatedAt).toLocaleTimeString() : '';
      statusBadge.textContent = `${status.sourceCount} sources · ${status.characters.toLocaleString()} chars · ${time}`;
    } else {
      statusBadge.className = 'status-badge idle'; statusBadge.textContent = 'No active context';
    }
    setMessage('API key accepted.', 'ok');
  } catch (error) {
    statusBadge.className = 'status-badge error'; statusBadge.textContent = 'API unauthorized'; setMessage(error.message, 'error');
  }
}

addUrlBtn.addEventListener('click', () => addUrlRow());
testBtn.addEventListener('click', testContext);
loadBtn.addEventListener('click', loadContext);
checkStatusBtn.addEventListener('click', refreshStatus);
textViewBtn.addEventListener('click', () => { currentView = 'text'; renderResult(); });
payloadViewBtn.addEventListener('click', () => { currentView = 'payload'; renderResult(); });
apiKeyInput.addEventListener('change', persistApiKeyForTab);

apiKeyInput.value = sessionStorage.getItem('webContextApiKey') || '';
addUrlRow('https://example.com/');
renderRecentConfigs();
if (apiKeyInput.value) refreshStatus();
