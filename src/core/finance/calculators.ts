/** Deterministic finance models. The AI calls these instead of doing arithmetic itself. */
import { UserInputError } from '../errors.js';
import { round } from '../text/format.js';

const MONTHS_PER_YEAR = 12;
const PERCENT = 100;
const MAX_YEARS = 100;
const MAX_CAGR_YEARS = 200;
const MIN_RATE_PCT = -99;
const MAX_RATE_PCT = 1_000;
const BUDGET_SPLIT = { needs: 0.5, wants: 0.3, savings: 0.2 } as const;

interface Range {
  min?: number;
  max?: number;
  positive?: boolean;
}

function requireNumber(
  name: string,
  value: unknown,
  { min = 0, max = Infinity, positive = false }: Range = {},
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UserInputError(`${name} must be a number`);
  if (n < min || n > max || (positive && n <= 0)) {
    const lower = positive ? `> ${min}` : `>= ${min}`;
    const upper = max < Infinity ? `, <= ${max}` : '';
    throw new UserInputError(`${name} is out of range (${lower}${upper})`);
  }
  return n;
}

const monthlyRate = (annualRatePct: unknown): number =>
  requireNumber('annual rate', annualRatePct, { min: MIN_RATE_PCT, max: MAX_RATE_PCT }) / PERCENT / MONTHS_PER_YEAR;

const monthsFor = (years: unknown): number =>
  Math.round(requireNumber('years', years, { max: MAX_YEARS, positive: true }) * MONTHS_PER_YEAR);

export interface CompoundGrowthInput {
  principal?: number;
  annualRatePct: number;
  years: number;
  monthlyContribution?: number;
  inflationPct?: number | null;
}

export interface CompoundGrowthResult {
  months: number;
  finalValue: number | null;
  totalContributed: number | null;
  totalGrowth: number | null;
  finalValueInTodaysMoney?: number | null;
}

/** Future value with monthly compounding and an optional deposit at the end of each month. */
export function compoundGrowth(input: CompoundGrowthInput): CompoundGrowthResult {
  const principal = requireNumber('principal', input.principal ?? 0);
  const deposit = requireNumber('monthly contribution', input.monthlyContribution ?? 0);
  const r = monthlyRate(input.annualRatePct);
  const n = monthsFor(input.years);
  const growth = (1 + r) ** n;
  const finalValue = principal * growth + (r === 0 ? deposit * n : (deposit * (growth - 1)) / r);
  const totalContributed = principal + deposit * n;
  const result: CompoundGrowthResult = {
    months: n,
    finalValue: round(finalValue),
    totalContributed: round(totalContributed),
    totalGrowth: round(finalValue - totalContributed),
  };
  if (input.inflationPct != null) {
    const inflation = requireNumber('inflation', input.inflationPct, { min: -50, max: MAX_RATE_PCT }) / PERCENT;
    result.finalValueInTodaysMoney = round(finalValue / (1 + inflation) ** (n / MONTHS_PER_YEAR));
  }
  return result;
}

/** Fixed-rate amortizing loan or mortgage (Shpitzer). */
export function loanPayment(input: { principal: number; annualRatePct: number; years: number }) {
  const principal = requireNumber('loan amount', input.principal, { positive: true });
  const r = monthlyRate(input.annualRatePct);
  const n = monthsFor(input.years);
  const payment = r === 0 ? principal / n : (principal * r) / (1 - (1 + r) ** -n);
  return {
    months: n,
    monthlyPayment: round(payment),
    totalPaid: round(payment * n),
    totalInterest: round(payment * n - principal),
  };
}

/** Monthly saving needed to reach a target, given what is already saved. */
export function savingsGoal(input: { target: number; annualRatePct: number; years: number; currentSavings?: number }) {
  const target = requireNumber('target', input.target, { positive: true });
  const current = requireNumber('current savings', input.currentSavings ?? 0);
  const r = monthlyRate(input.annualRatePct);
  const n = monthsFor(input.years);
  const growth = (1 + r) ** n;
  const fromCurrent = current * growth;
  const gap = target - fromCurrent;
  let monthly = 0;
  if (gap > 0) monthly = r === 0 ? gap / n : (gap * r) / (growth - 1);
  return {
    months: n,
    monthlyNeeded: round(monthly),
    currentSavingsGrowsTo: round(fromCurrent),
    alreadyOnTrack: gap <= 0,
  };
}

/** Compound annual growth rate between two values. */
export function cagr(input: { startValue: number; endValue: number; years: number }) {
  const start = requireNumber('start value', input.startValue, { positive: true });
  const end = requireNumber('end value', input.endValue);
  const years = requireNumber('years', input.years, { positive: true, max: MAX_CAGR_YEARS });
  return {
    cagrPct: round(((end / start) ** (1 / years) - 1) * PERCENT),
    totalReturnPct: round((end / start - 1) * PERCENT),
  };
}

/** The 50/30/20 budgeting rule. */
export function budget503020(input: { monthlyIncome: number }) {
  const income = requireNumber('monthly income', input.monthlyIncome, { positive: true });
  return {
    needs50: round(income * BUDGET_SPLIT.needs),
    wants30: round(income * BUDGET_SPLIT.wants),
    savings20: round(income * BUDGET_SPLIT.savings),
  };
}
