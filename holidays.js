// Public-holiday integration: Nager.Date REST API (free, no key) with an offline fallback.
const db = require('./db');

const API = process.env.HOLIDAY_API_URL || 'https://date.nager.at/api/v3/PublicHolidays';
const COUNTRY = process.env.HOLIDAY_COUNTRY || 'PH';

// Only fixed-date Philippine holidays; used when the API cannot be reached.
const FALLBACK = [
  ['01-01', "New Year's Day"], ['04-09', 'Araw ng Kagitingan'], ['05-01', 'Labor Day'], ['06-12', 'Independence Day'],
  ['08-21', 'Ninoy Aquino Day'], ['11-01', "All Saints' Day"], ['11-30', 'Bonifacio Day'], ['12-08', 'Feast of the Immaculate Conception'],
  ['12-25', 'Christmas Day'], ['12-30', 'Rizal Day'],
];

const countFor = (year) => db.prepare("SELECT COUNT(*) c FROM holidays WHERE substr(date,1,4) = ?").get(String(year)).c;

/** Download a year's holidays from the API and store them (manual entries are kept). */
async function syncYear(year) {
  year = Number(year);
  try {
    const res = await fetch(`${API}/${year}/${COUNTRY}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) throw new Error('Empty response');
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM holidays WHERE source IN ('api','fallback') AND substr(date,1,4) = ?").run(String(year));
      const ins = db.prepare("INSERT OR IGNORE INTO holidays (date, name, source) VALUES (?,?,'api')");
      for (const h of list) if (/^\d{4}-\d{2}-\d{2}$/.test(h.date)) ins.run(h.date, h.name || h.localName);
    });
    tx();
    return { ok: true, source: 'api', count: countFor(year) };
  } catch (err) {
    if (countFor(year) === 0) {
      const ins = db.prepare("INSERT OR IGNORE INTO holidays (date, name, source) VALUES (?,?,'fallback')");
      FALLBACK.forEach(([md, name]) => ins.run(`${year}-${md}`, name));
      return { ok: true, source: 'fallback', count: countFor(year), warning: `Holiday API unreachable (${err.message}); loaded built-in fixed-date holidays instead.` };
    }
    return { ok: false, error: `Holiday API unreachable (${err.message}). Existing holidays were kept.` };
  }
}

/** Called at start-up: make sure this year and next year have holidays (never blocks or throws). */
function ensureYears() {
  const y = new Date().getFullYear();
  [y, y + 1].forEach(yr => { if (countFor(yr) === 0) syncYear(yr).then(r => console.log(`[holidays] ${yr}: ${r.source || 'error'} (${r.count ?? 0})`)).catch(() => {}); });
}

module.exports = { syncYear, ensureYears, API, COUNTRY };
