// Optional real-browser smoke test. Start a dedicated Chromium profile with
// --remote-debugging-port=9228 --load-extension=<absolute path>/dist/chromium.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const endpoint = process.env.CDP_URL ?? 'http://127.0.0.1:9228';
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const waiting = new Map();
  const errors = [];
  ws.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    if (response.method === 'Runtime.exceptionThrown') errors.push(response.params.exceptionDetails);
    if (!response.id) return;
    const item = waiting.get(response.id);
    if (!item) return;
    waiting.delete(response.id);
    clearTimeout(item.timeout);
    if (response.error) item.reject(new Error(response.error.message)); else item.resolve(response.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const seq = ++id;
    const timeout = setTimeout(() => { waiting.delete(seq); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    waiting.set(seq, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  return { send, evaluate, errors, close: () => ws.close() };
}
let extensionId;
if (process.env.LOAD_EXTENSION === '1') {
  const info = await (await fetch(`${endpoint}/json/version`)).json();
  const browser = await connect(info.webSocketDebuggerUrl);
  try {
    const loaded = await browser.send('Extensions.loadUnpacked', { path: `${process.cwd()}/dist/chromium` });
    extensionId = loaded.id;
  } finally { browser.close(); }
}
for (const target of await (await fetch(`${endpoint}/json/list`)).json()) {
  if (extensionId) break;
  if (target.type !== 'service_worker' || !target.url.endsWith('/background.js')) continue;
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    const name = await client.evaluate('(globalThis.browser ?? globalThis.chrome)?.runtime?.getManifest().name');
    if (name === 'ゆるり — おくすりリマインダー') extensionId = new URL(target.url).host;
  } finally { client.close(); }
}
assert.ok(extensionId, 'ゆるり extension service worker must be loaded');
const target = await (await fetch(`${endpoint}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/app.html?popup`)}`, { method: 'PUT' })).json();
let client = await connect(target.webSocketDebuggerUrl);
const waitFor = async expression => {
  for (let i = 0; i < 50; i++) {
    if (await client.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition failed: ${expression}\n${JSON.stringify(client.errors)}\n${await client.evaluate('document.body.innerText')}`);
};
try {
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 600, deviceScaleFactor: 1, mobile: false });
  await waitFor('document.querySelector("[data-action=add]") !== null');
  await client.evaluate('document.querySelector("[data-action=add]").click()');
  let editor;
  for (let i = 0; i < 50; i++) {
    const pages = await (await fetch(`${endpoint}/json/list`)).json();
    editor = pages.find(page => page.type === 'page' && page.url.startsWith(`chrome-extension://${extensionId}/app.html?`) && new URL(page.url).searchParams.get('edit') === 'new');
    if (editor) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(editor, 'popup add must open a normal editor tab for IME input');
  client.close();
  client = await connect(editor.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await waitFor('document.querySelector("dialog").open');
  assert.equal(await client.evaluate('document.activeElement.name'), 'name');
  await client.evaluate(`document.querySelector('[name=note]').value='食後に1錠'; document.querySelector('[value=morning]').checked=true; document.querySelector('[value=evening]').checked=true;`);
  // Drive Chromium's composition pipeline rather than assigning a Japanese value.
  await client.send('Input.imeSetComposition', { text: 'かぜぐすり', selectionStart: 5, selectionEnd: 5 });
  await client.evaluate(`document.querySelector('#med-form').requestSubmit(document.querySelector('#med-form [type=submit]'));`);
  assert.equal(await client.evaluate('document.querySelector("dialog").open'), true, 'composing must not submit');
  assert.equal(Object.keys(await client.evaluate('(globalThis.browser ?? globalThis.chrome).storage.sync.get(null)')).filter(key => key.startsWith('med:')).length, 0);
  await client.send('Input.insertText', { text: '風邪薬' });
  assert.equal(await client.evaluate('document.querySelector("[name=name]").value'), '風邪薬');
  await client.evaluate(`document.querySelector('#med-form').requestSubmit(document.querySelector('#med-form [type=submit]'));`);
  await waitFor('!document.querySelector("dialog").open');
  await client.evaluate('document.querySelector("[data-view=today]").click()');
  await waitFor('document.querySelectorAll("[data-action=record]").length === 2');
  await client.evaluate('document.querySelector("[data-action=record]").click()');
  await waitFor('document.querySelectorAll(".record-button.done").length === 1');
  await mkdir('artifacts', { recursive: true });
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/today.png', Buffer.from(screenshot.data, 'base64'));
  await client.evaluate('document.querySelector("[data-view=history]").click()');
  await waitFor('document.querySelectorAll(".history-row").length === 1');
  await client.evaluate('document.querySelector("[data-view=settings]").click()');
  await waitFor('document.querySelector("#settings-form") !== null');
  await client.evaluate(`document.querySelector('#enabled').click(); document.querySelector('#settings-form').requestSubmit(document.querySelector('#settings-form [type=submit]'));`);
  await waitFor('document.querySelector("#status").textContent.includes("設定を同期領域に保存")');
  const stored = await client.evaluate('(globalThis.browser ?? globalThis.chrome).storage.sync.get(null)');
  assert.equal(stored.settings.enabled, false);
  const medKey = Object.keys(stored).find(key => stored[key]?.name === '風邪薬');
  assert.ok(medKey);
  const records = await client.evaluate('(globalThis.browser ?? globalThis.chrome).storage.local.get(null)');
  assert.ok(Object.keys(records).some(key => key.startsWith('record:')));
  const settingsScreenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/settings.png', Buffer.from(settingsScreenshot.data, 'base64'));
  await client.evaluate('document.querySelector("[data-action=edit]").click()');
  await waitFor('document.querySelector("dialog").open');
  assert.equal(await client.evaluate('document.querySelector("[name=name]").value'), '風邪薬');
  await client.evaluate('document.querySelector("#cancel-dialog").click(); document.querySelector("[data-action=ask-delete]").click(); document.querySelector("[data-action=delete]").click()');
  await waitFor('document.querySelectorAll("[data-action=edit]").length === 0');
  assert.equal(client.errors.length, 0, JSON.stringify(client.errors));
  console.log('Chromium real-extension smoke test passed: popup-to-tab editor, IME composition/commit, add, record, history, settings, sync/local storage, edit, delete.');
  console.log('Screenshots: artifacts/today.png, artifacts/settings.png');
} finally { client.close(); }
