// FSRS-4.5 core for Avulsas.
// This file is the single source of truth used by the PC app and GitPages Android.

export const FSRS_CORE_VERSION = 'fsrs-4.5-avulsas-core-2026-05-13';

const W = [
  0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01,
  1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61
];
const TARGET_RETENTION = 0.9;
const LAPSE_DELAY_MINUTES = 15;
const FACTOR = Math.pow(TARGET_RETENTION, -1 / 0.5) - 1;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function addDaysIso(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Math.round(days));
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function diffDaysIso(fromIso, toIso) {
  const [y1, m1, d1] = fromIso.split('-').map(Number);
  const [y2, m2, d2] = toIso.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

function recall(elapsedDays, stability) {
  if (stability <= 0) return 0;
  return Math.pow(1 + FACTOR * elapsedDays / stability, -0.5);
}

function intervaloAlvo(stability) {
  return stability;
}

function novaStabilityNew(rating) {
  return Math.max(0.1, W[rating - 1]);
}

function novaDifficultyNew(rating) {
  return clamp(W[4] - (rating - 3) * W[5], 1, 10);
}

function novaDifficulty(D, rating) {
  const dPrime = D - W[6] * (rating - 3);
  return clamp(W[7] * W[4] + (1 - W[7]) * dPrime, 1, 10);
}

function novaStabilityAcerto(D, S, R, rating) {
  const hardPenalty = (rating === 2) ? W[15] : 1;
  const easyBonus = (rating === 4) ? W[16] : 1;
  return S * (1 + Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9])
                * (Math.exp((1 - R) * W[10]) - 1) * hardPenalty * easyBonus);
}

function novaStabilityLapso(D, S, R) {
  return W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R));
}

function addMinutesIso(baseIso, minutes) {
  const dt = new Date(baseIso);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setMinutes(dt.getMinutes() + Math.max(0, Number(minutes) || 0));
  return dt.toISOString();
}

export function updateState(rs, rating, hojeIso, dataObjetivoIso = null, agoraIso = null) {
  if (![1, 2, 3, 4].includes(rating)) {
    throw new Error(`rating invalido: ${rating}`);
  }
  const out = { ...rs };

  if (out.state === 'new') {
    out.stability = novaStabilityNew(rating);
    out.difficulty = novaDifficultyNew(rating);
  } else {
    const elapsed = out.lastReviewedAt
      ? Math.max(0, diffDaysIso(out.lastReviewedAt.slice(0, 10), hojeIso))
      : 0;
    const R = recall(elapsed, out.stability);
    if (rating === 1) {
      out.stability = Math.max(0.1, novaStabilityLapso(out.difficulty, out.stability, R));
      out.difficulty = novaDifficulty(out.difficulty, 1);
      out.lapses += 1;
    } else {
      out.stability = Math.max(0.1, novaStabilityAcerto(out.difficulty, out.stability, R, rating));
      out.difficulty = novaDifficulty(out.difficulty, rating);
    }
  }

  out.reps += 1;
  out.lastReviewedAt = new Date(hojeIso + 'T12:00:00').toISOString();

  let intervaloFinal;
  const alvo = intervaloAlvo(out.stability);
  let clamped = false;
  if (dataObjetivoIso) {
    const diasAteObjetivo = diffDaysIso(hojeIso, dataObjetivoIso);
    if (diasAteObjetivo <= 0) {
      intervaloFinal = 1;
      clamped = true;
    } else if (alvo > diasAteObjetivo) {
      intervaloFinal = diasAteObjetivo;
      clamped = true;
    } else {
      intervaloFinal = alvo;
    }
  } else {
    intervaloFinal = alvo;
  }

  if (rating === 1) intervaloFinal = 0;
  else intervaloFinal = Math.max(1, Math.round(intervaloFinal));

  out.dueDate = addDaysIso(hojeIso, intervaloFinal);
  out.nextDueAt = null;
  if (rating === 1) {
    const baseAgoraIso = (typeof agoraIso === 'string' && agoraIso.trim()) ? agoraIso : new Date().toISOString();
    out.nextDueAt = addMinutesIso(baseAgoraIso, LAPSE_DELAY_MINUTES);
  }
  out.clamped = clamped;
  out.state = (rating === 1) ? 'learning' : 'review';

  if (clamped) {
    if (out.difficulty <= 4 && out.reps >= 3 && out.lapses === 0 && rating >= 3) {
      out.state = 'mastered';
    }
  } else if (out.reps >= 4 && out.difficulty <= 3.5 && out.lapses === 0 && rating >= 3) {
    out.state = 'mastered';
  }

  return { newState: out, intervaloFinal, intervaloAlvoCalculado: alvo };
}
