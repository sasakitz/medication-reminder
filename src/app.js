const api = globalThis.browser ?? globalThis.chrome;
const C = globalThis.ReminderCore;
const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#med-dialog');
const medForm = $('#med-form');
const params = new URLSearchParams(location.search);
const isPopup = params.has('popup');
let initialEditor = params.get('edit');
let state;
let view = params.get('view') === 'settings' ? 'settings' : 'today';
let editingId = null;
let deletingId = null;
let draftSettings = null;
let busy = false;
let toastTimer;
let composing = false;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const prettyDate = date => new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${date}T12:00:00`));
const prettyTime = at => new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(at));
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const el = $('#status');
  el.textContent = message;
  el.className = `toast${error ? ' error-toast' : ''}`;
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 9000 : 3500);
}
async function request(type, data = {}) {
  const response = await api.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || 'バックグラウンドに接続できません。拡張機能を再読み込みしてください。');
  return response.data;
}
function today() {
  const ctx = C.context(new Date());
  const active = state.meds.filter(m => m.active);
  const total = active.reduce((n, med) => n + med.periods.length, 0);
  const done = active.reduce((n, med) => n + med.periods.filter(p => state.local[C.recordKey(ctx.date, med.id, p)]).length, 0);
  let html = `<div class="today-summary"><h1>${prettyDate(ctx.date)}${new Date().getHours() < 4 ? ' · 前日分' : ''}</h1>${total ? `<span class="record-count" aria-label="${total}回中${done}回記録済み">記録 ${done} / ${total}</span>` : ''}</div>`;
  if (!total) return html + `<div class="empty"><p>有効な薬が登録されていません。</p><button class="button primary" data-action="add">＋ 薬を追加</button></div>`;
  // Put the current period within reach without scrolling past earlier periods.
  const periods = [...C.PERIODS].sort((a, b) => Number(b.id === ctx.period) - Number(a.id === ctx.period));
  for (const period of periods) {
    const meds = active.filter(m => m.periods.includes(period.id));
    if (!meds.length) continue;
    html += `<section><div class="period-header"><h2>${period.label}</h2>${ctx.period === period.id ? '<span class="pill">現在</span>' : ''}<small>${period.id === 'evening' ? '18時〜翌4時' : `${period.start}時〜${period.end}時`}</small></div>`;
    for (const med of meds) {
      const record = state.local[C.recordKey(ctx.date, med.id, period.id)];
      const note = record ? `${prettyTime(record.at)} に記録` : med.note;
      html += `<div class="med-card${record ? ' done' : ''}"><div class="med-info"><p class="med-name">${escape(med.name)}</p>${note ? `<p class="med-note">${escape(note)}</p>` : ''}</div><button class="record-button${record ? ' done' : ''}" data-action="record" data-id="${escape(med.id)}" data-period="${period.id}" data-date="${ctx.date}" data-taken="${!record}" aria-label="${escape(med.name)}・${period.label}：${record ? '記録を取り消す' : '飲んだことを記録する'}" title="${record ? 'クリックで記録を取り消す' : '服薬を記録'}">${record ? '✓ 記録済み ↶' : '飲みました'}</button></div>`;
    }
    html += '</section>';
  }
  if (C.pending(state.meds, state.local, ctx.date, ctx.period).length && state.settings.enabled) {
    const until = state.local[`snooze:${ctx.date}:${ctx.period}`];
    html += until > Date.now() ? `<p class="fine">${prettyTime(until)} まで通知を延期中</p>` : '<button class="text-button" data-action="snooze">通知を1時間延期</button>';
  }
  if (!state.settings.enabled) html += '<p class="fine">通知は無効です。</p>';
  return html;
}
function renderHistory() {
  let html = '<h1>服薬履歴</h1><p class="muted">直近7日間 · この端末の記録（90日間保存）</p>';
  for (const day of C.previousDays(new Date(), 7)) {
    const records = Object.entries(state.local).filter(([key]) => key.startsWith(`record:${day}:`)).map(([, value]) => value).sort((a, b) => a.at.localeCompare(b.at));
    html += `<section class="history-day"><h2>${prettyDate(day)} <span class="pill">${records.length}件の記録</span></h2>`;
    html += records.length ? records.map(record => `<div class="history-row"><span class="pill">${escape(C.PERIODS.find(p => p.id === record.period)?.label ?? '')}</span><span class="history-name">${escape(record.name)}</span><time datetime="${escape(record.at)}">${prettyTime(record.at)}</time><span aria-label="記録済み">✓</span></div>`).join('') : '<p class="inline-empty">記録はありません</p>';
    html += '</section>';
  }
  return html;
}
function settings() {
  const prefs = draftSettings ?? state.settings;
  let html = '<div class="section-heading"><h1>薬</h1><button class="text-button" data-action="add">＋ 追加</button></div>';
  if (!state.meds.length) html += '<p class="inline-empty">薬が登録されていません。</p>';
  for (const med of state.meds) {
    html += `<div class="med-card${med.active ? '' : ' paused'}"><div class="med-info"><p class="med-name">${escape(med.name)}</p><p class="med-note">${med.active ? med.periods.map(id => C.PERIODS.find(p => p.id === id).label).join('・') : '無効'}${med.note ? ` · ${escape(med.note)}` : ''}</p></div><div class="med-actions"><button class="text-button" data-action="edit" data-id="${escape(med.id)}" aria-label="${escape(med.name)}を編集">編集</button><button class="text-button danger" data-action="ask-delete" data-id="${escape(med.id)}" aria-label="${escape(med.name)}を削除">削除</button></div></div>`;
    if (deletingId === med.id) html += `<div class="delete-confirm">「${escape(med.name)}」を削除しますか？<br>同期先のデバイスからも削除されます。過去の記録は残ります。<div class="settings-actions"><button class="button secondary" data-action="cancel-delete">やめる</button><button class="button primary" data-action="delete" data-id="${escape(med.id)}">削除する</button></div></div>`;
  }
  html += `<form id="settings-form" class="settings-section"><h2>通知</h2><div class="setting-row"><label for="enabled">未記録の通知<small>未記録の場合、時間帯ごとに1回通知。</small></label><input id="enabled" name="enabled" type="checkbox" ${prefs.enabled ? 'checked' : ''}></div><div class="setting-row"><label for="private-notifications">通知に薬の名前を表示しない<small>OS通知への薬名表示を省略します。</small></label><input id="private-notifications" name="privateNotifications" type="checkbox" ${prefs.privateNotifications ? 'checked' : ''}></div><div class="settings-section"><h2>通知の目安</h2><p class="fine">目安の時刻以降、未記録なら通知します。</p>`;
  for (const p of C.PERIODS) {
    html += `<div class="hour-row"><label for="hour-${p.id}">${p.label}<small>${p.id === 'evening' ? '18時〜翌4時' : `${p.start}時〜${p.end}時`}</small></label><select id="hour-${p.id}" name="${p.id}">${Array.from({ length: p.end - p.start }, (_, i) => p.start + i).map(h => `<option value="${h}"${h === prefs.hours[p.id] ? ' selected' : ''}>${h >= 24 ? '翌' : ''}${h % 24}時ごろ</option>`).join('')}</select></div>`;
  }
  html += '</div><div class="settings-actions"><button type="submit" class="button primary">設定を保存</button><button type="button" class="button secondary" data-action="test">通知をテスト</button></div><p class="save-hint">通知の変更は保存後に反映されます。</p></form><details class="help"><summary>同期・保存・通知について</summary><div class="sync-box"><strong>設定の同期</strong><p>薬の名前・メモ・飲む時間帯・通知の設定をブラウザ標準の同期領域に保存しています。同期を有効にした同じブラウザの同一アカウントで共有されます。ブラウザ間の共有はできません。<br>服薬記録・通知の履歴は、この端末だけに保存します。別の端末では記録に関係なく通知されます。</p></div><div class="note-box">ブラウザの終了中や端末のスリープ中は通知できません。再開時、現在の時間帯に未記録の薬があれば確認します。OSの通知設定や集中モードによっては表示されません。<br>同期には同じ拡張機能IDが必要です。開発版の条件はREADMEに記載しています。</div></details>';
  return html;
}
function render() {
  if (!state) return;
  const focused = document.activeElement;
  const focusData = focused?.dataset;
  content.innerHTML = view === 'settings' ? settings() : view === 'history' ? renderHistory() : today();
  content.setAttribute('aria-busy', 'false');
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.classList.toggle('active', tab.dataset.view === view);
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  if (focusData?.action === 'record') {
    [...content.querySelectorAll('[data-action="record"]')].find(el => el.dataset.id === focusData.id && el.dataset.period === focusData.period)?.focus();
  }
}
async function openEditor(id = null) {
  // Linux/Wayland IMEs may not attach to browser-action popup windows.
  // Keep quick recording in the popup and perform text entry in a normal tab.
  if (isPopup) {
    const query = new URLSearchParams({ view: 'settings', edit: id ?? 'new' });
    await api.tabs.create({ url: api.runtime.getURL(`app.html?${query}`) });
    return;
  }
  editingId = id;
  const med = state.meds.find(m => m.id === id);
  medForm.reset();
  $('#dialog-title').textContent = med ? '薬を編集' : '薬を追加';
  medForm.elements.name.value = med?.name ?? '';
  medForm.elements.note.value = med?.note ?? '';
  medForm.elements.active.checked = med?.active !== false;
  for (const input of medForm.querySelectorAll('[name="periods"]')) input.checked = med?.periods.includes(input.value) ?? false;
  $('#form-error').textContent = '';
  composing = false;
  dialog.showModal();
  medForm.elements.name.focus();
}
async function mutate(type, data, message) {
  state = await request(type, data);
  render();
  if (message) toast(message);
}
document.addEventListener('click', async event => {
  const tab = event.target.closest('[data-view]');
  if (tab && state && !busy) { view = tab.dataset.view; deletingId = null; render(); return; }
  const button = event.target.closest('[data-action]');
  if (!button || !state || busy) return;
  const { action, id, period, date, taken } = button.dataset;
  if (action === 'add' || action === 'edit') {
    busy = true;
    try { await openEditor(id); } catch (error) { toast(error.message, true); }
    finally { busy = false; }
    return;
  }
  if (action === 'ask-delete' || action === 'cancel-delete') { deletingId = action === 'ask-delete' ? id : null; render(); return; }
  busy = true;
  button.disabled = true;
  try {
    if (action === 'record') await mutate('record', { id, period, date, taken: taken === 'true' }, taken === 'true' ? '服薬を記録しました。' : '記録を取り消しました。');
    if (action === 'delete') { await mutate('delete-med', { id }, '薬を削除しました。'); deletingId = null; }
    if (action === 'snooze') await mutate('snooze', {}, '通知を1時間延期しました。');
    if (action === 'test') { await request('test-notification'); toast('テスト通知を送信しました。表示されない場合はOSの通知設定をご確認ください。'); }
  } catch (error) { toast(error.message, true); }
  finally { busy = false; button.disabled = false; }
});
document.addEventListener('change', event => {
  if (event.target.closest('#settings-form')) {
    const form = $('#settings-form');
    draftSettings = { enabled: form.elements.enabled.checked, privateNotifications: form.elements.privateNotifications.checked, hours: Object.fromEntries(C.PERIODS.map(p => [p.id, Number(form.elements[p.id].value)])) };
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'settings-form') return;
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = event.submitter;
  button.disabled = true;
  try {
    state = await request('save-settings', { settings: draftSettings ?? state.settings });
    draftSettings = null;
    render();
    toast('設定を同期領域に保存しました。');
  } catch (error) { toast(`保存できませんでした：${error.message}`, true); }
  finally { busy = false; button.disabled = false; }
});
medForm.addEventListener('compositionstart', () => { composing = true; });
medForm.addEventListener('compositionend', () => { composing = false; });
medForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || composing) return;
  const med = { name: medForm.elements.name.value, note: medForm.elements.note.value, active: medForm.elements.active.checked, periods: [...medForm.querySelectorAll('[name="periods"]:checked')].map(el => el.value) };
  busy = true;
  event.submitter.disabled = true;
  try {
    C.medication(med);
    state = await request('save-med', { id: editingId, med });
    dialog.close();
    render();
    toast('薬を保存しました。');
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { busy = false; event.submitter.disabled = false; }
});
$('#close-dialog').addEventListener('click', () => { if (!busy) dialog.close(); });
$('#cancel-dialog').addEventListener('click', () => { if (!busy) dialog.close(); });
dialog.addEventListener('cancel', event => { if (busy || composing) event.preventDefault(); });
$('#expand').addEventListener('click', () => api.tabs.create({ url: api.runtime.getURL(`app.html${view === 'settings' ? '?view=settings' : ''}`) }));
if (!isPopup) document.body.classList.add('fullpage');
async function refresh() {
  if (busy || dialog.open) return;
  try {
    state = await request('snapshot');
    render();
    if (initialEditor && !isPopup) {
      const edit = initialEditor;
      initialEditor = null;
      // Reloading a completed editor must not reopen it or create a duplicate.
      globalThis.history.replaceState(null, '', api.runtime.getURL('app.html?view=settings'));
      if (edit === 'new' || state.meds.some(m => m.id === edit)) await openEditor(edit === 'new' ? null : edit);
      else toast('この薬は削除されています。', true);
    }
  } catch (error) {
    if (!state) {
      content.innerHTML = '<div class="empty"><h2>記録を読み込めませんでした</h2><p>ブラウザの拡張機能管理画面で、ゆるりを再読み込みしてから開き直してください。</p></div>';
      content.setAttribute('aria-busy', 'false');
    }
    toast(error.message, true);
  }
}
let refreshTimer;
api.storage.onChanged.addListener(() => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); });
// Refresh date and current period even if this page stays open over midnight.
setInterval(() => { if (view !== 'settings') refresh(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
refresh();
