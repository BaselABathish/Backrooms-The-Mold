// Timestamps for the burned-in overlay. They are kept in the story's own time zone, not the player's.
const p2 = v => String(v).padStart(2, '0');

// '2026-11-19T23:41:07-05:00' -> { ms: epoch milliseconds, tz: minutes east of UTC }
export function parseStamp(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)([+-])(\d\d):?(\d\d)$/.exec(s);
  if (!m) throw new Error(`bad timestamp '${s}' (expected e.g. 2026-11-19T23:41:07-05:00)`);
  const tz = (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]);
  return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - tz * 60000, tz };
}

// body camera style: '2026-11-19 T23:41:07 -0500'
export function formatStamp(ms, tz) {
  const d = new Date(ms + tz * 60000), a = Math.abs(tz);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${tz < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}${p2(a % 60)}`;
}
export const clockText = (ms, tz) => formatStamp(ms, tz).slice(12, 20);   // 'HH:MM:SS'
// a running time for the review player: '1:07' or '12:03:09' style
export function duration(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return h ? `${h}:${p2(m)}:${p2(ss)}` : `${m}:${p2(ss)}`;
}
