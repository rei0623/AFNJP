export const STORAGE_KEY = "afnjp-reader-v1";
export function decodeState(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  const cleanMap = (v) =>
    Object.fromEntries(
      Object.entries(v && typeof v === "object" ? v : {})
        .filter(
          ([id, t]) => /^\d{5,25}$/.test(id) && Number.isFinite(t) && t > 0,
        )
        .slice(-1000),
    );
  return {
    saved: cleanMap(parsed?.saved),
    read: cleanMap(parsed?.read),
    lastVisit:
      Number.isFinite(parsed?.lastVisit) && parsed.lastVisit > 0
        ? parsed.lastVisit
        : 0,
  };
}
export function beginVisit(state, session, now = Date.now()) {
  if (
    session &&
    Number.isFinite(session.started) &&
    now - session.started >= 0 &&
    now - session.started < 30 * 60 * 1000
  )
    return { started: now, previousVisit: Number(session.previousVisit) || 0 };
  return { started: now, previousVisit: state.lastVisit || 0 };
}
