/* Shared pure logic: no browser API or clock dependencies. */
(() => {
  const PERIODS = Object.freeze([
    { id: 'morning', label: '朝', symbol: '☀', start: 4, end: 12, hour: 10 },
    { id: 'noon', label: '昼', symbol: '◒', start: 12, end: 18, hour: 15 },
    { id: 'evening', label: '晩', symbol: '☾', start: 18, end: 28, hour: 21 },
  ]);
  const DEFAULTS = Object.freeze({ enabled: true, privateNotifications: true, hours: { morning: 10, noon: 15, evening: 21 } });
  const pad = n => String(n).padStart(2, '0');
  const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  function context(now = new Date()) {
    const day = new Date(now);
    if (now.getHours() < 4) day.setDate(day.getDate() - 1);
    const hour = now.getHours() < 4 ? now.getHours() + 24 : now.getHours();
    return { date: dateKey(day), hour, period: PERIODS.find(p => hour >= p.start && hour < p.end).id };
  }
  function previousDays(now, count) {
    const ctx = context(now);
    const day = new Date(`${ctx.date}T12:00:00`);
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(day);
      d.setDate(d.getDate() - i);
      return dateKey(d);
    });
  }
  function config(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const result = { enabled: value.enabled !== false, privateNotifications: value.privateNotifications !== false, hours: {} };
    for (const p of PERIODS) {
      const h = value.hours?.[p.id];
      result.hours[p.id] = Number.isInteger(h) && h >= p.start && h < p.end ? h : p.hour;
    }
    return result;
  }
  function medication(value) {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 60) throw new Error('薬の名前を1〜60文字で入力してください。');
    const periods = PERIODS.filter(p => value.periods?.includes(p.id)).map(p => p.id);
    if (!periods.length) throw new Error('朝・昼・晩のいずれかを選んでください。');
    const note = typeof value.note === 'string' ? value.note.trim() : '';
    if (note.length > 120) throw new Error('メモは120文字以内で入力してください。');
    return { name: value.name.trim(), note, periods, active: value.active !== false };
  }
  const recordKey = (date, id, period) => `record:${date}:${id}:${period}`;
  const noticeKey = (date, period) => `notice:${date}:${period}`;
  function pending(meds, records, date, period) {
    return meds.filter(m => m.active && m.periods.includes(period) && !records[recordKey(date, m.id, period)]);
  }
  function reminder(meds, records, settings, now) {
    const ctx = context(now);
    if (!settings.enabled || ctx.hour < settings.hours[ctx.period]) return null;
    const missing = pending(meds, records, ctx.date, ctx.period);
    return missing.length ? { ...ctx, missing, key: noticeKey(ctx.date, ctx.period) } : null;
  }
  function expiredKeys(local, now) {
    const cutoff = previousDays(now, 90).at(-1);
    return Object.keys(local).filter(key => /^(record|notice|snooze):/.test(key) && key.split(':')[1] < cutoff);
  }
  globalThis.ReminderCore = { PERIODS, DEFAULTS, dateKey, context, previousDays, config, medication, recordKey, noticeKey, pending, reminder, expiredKeys };
})();
