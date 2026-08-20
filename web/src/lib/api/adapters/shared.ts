// Utilidades compartilhadas pelos adaptadores da API real (Fase 1).
// Funções puras, sem dependências externas — precisam rodar standalone (smoke test com tsx).
// Dias úteis (SP) portados de hub/frontend/src/utils/businessDays.js (lógica validada).

/** Number(...) defensivo — o payload real pode trazer null/None/undefined/strings. */
export function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Nomes do banco vêm com espaços à direita ("VENDEDOR             ") — sempre trim. */
export function clean(x: unknown): string {
  return String(x ?? "").trim();
}

/** 'YYYY-MM-DD…' (com ou sem hora) → 'YYYY-MM-DD'. */
export function isoDate(x: unknown): string {
  return String(x ?? "").slice(0, 10);
}

/** 'YYYY-MM-DD' → dia do mês (número); inválido → 0. */
export function dayOfMonth(x: unknown): number {
  return num(isoDate(x).slice(8, 10));
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Mês de referência por runtime, ex.: "Agosto 2026". */
export function mesReferenciaAtual(agora: Date = new Date()): string {
  const nome = agora.toLocaleDateString("pt-BR", { month: "long" });
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} ${agora.getFullYear()}`;
}

// ── Dias úteis (São Paulo) — porte fiel de businessDays.js ────────────────────

function toStr(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function getEaster(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

export function getHolidaysSP(year: number): Set<string> {
  const easter = getEaster(year);
  const fixed = [
    `${year}-01-01`,
    `${year}-01-25`,
    `${year}-04-21`,
    `${year}-05-01`,
    `${year}-07-09`,
    `${year}-09-07`,
    `${year}-10-12`,
    `${year}-11-02`,
    `${year}-11-15`,
    `${year}-11-20`,
    `${year}-12-25`,
  ];
  const moveable = [
    toStr(addDays(easter, -48)),
    toStr(addDays(easter, -47)),
    toStr(addDays(easter, -2)),
    toStr(addDays(easter, 60)),
  ];
  return new Set([...fixed, ...moveable]);
}

/** Total de dias úteis (seg–sex, sem feriados SP) do mês. `month` é 1-12. */
export function countBusinessDaysSP(year: number, month: number): number {
  const holidays = getHolidaysSP(year);
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow >= 1 && dow <= 5) {
      const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
      if (!holidays.has(dateStr)) count++;
    }
  }
  return Math.max(1, count);
}

/** Dias úteis restantes do mês (incluindo hoje). `month` é 1-12. Mínimo 1. */
export function remainingBusinessDaysSP(year: number, month: number): number {
  const holidays = getHolidaysSP(year);
  const todayStr = toStr(new Date());
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow >= 1 && dow <= 5) {
      const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
      if (!holidays.has(dateStr) && dateStr >= todayStr) count++;
    }
  }
  return Math.max(1, count);
}

/** Verdadeiro se 'YYYY-MM-DD' é dia útil (seg–sex e não feriado SP). */
export function isBusinessDaySP(dateStr: string, holidays: Set<string>): boolean {
  const y = num(dateStr.slice(0, 4));
  const m = num(dateStr.slice(5, 7));
  const d = num(dateStr.slice(8, 10));
  if (!y || !m || !d) return false;
  const dow = new Date(y, m - 1, d).getDay();
  return dow >= 1 && dow <= 5 && !holidays.has(dateStr);
}

/**
 * Ano/mês de referência de uma série diária `[{dia: 'YYYY-MM-DD', …}]`.
 * Usa o ÚLTIMO registro (dia mais recente) — em produção é sempre o mês corrente,
 * e com fixtures antigas mantém a série coerente. Fallback: data de hoje.
 */
export function mesDaSerie(dias: unknown[]): { ano: number; mes: number } {
  const ultimo = dias.length ? isoDate((dias[dias.length - 1] as { dia?: unknown })?.dia) : "";
  const ano = num(ultimo.slice(0, 4));
  const mes = num(ultimo.slice(5, 7));
  if (ano >= 2000 && mes >= 1 && mes <= 12) return { ano, mes };
  const agora = new Date();
  return { ano: agora.getFullYear(), mes: agora.getMonth() + 1 };
}
