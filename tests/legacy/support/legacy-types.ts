/** Hand-written type descriptions of the legacy window APIs (only what the tests use). */

export interface Shift {
  id?: string;
  date: string;
  start: string;
  end: string;
  pause: number;
  note?: string;
}

export interface DayEvaluation {
  valid: boolean;
  date: string;
  reason?: string;
  tooLong?: boolean;
  overlap?: boolean;
  required?: number;
  qualifying?: number;
  entered?: number;
  recognized?: number;
  gaps?: number;
  missing?: number;
  gross?: number;
  net?: number;
  shiftCount?: number;
}

export interface BreakRulesApi {
  gross(shift: Partial<Shift> | null | undefined): number;
  necessary(grossMinutes: number): number;
  evaluateDay(items: Shift[], date: string): DayEvaluation;
  suggestedPause(candidate: Partial<Shift> | null, saved: Shift[]): number | null;
  issueForDay(day: DayEvaluation): string;
  errorsForMonth(shifts: Shift[], month: string): { date: string; message: string }[];
}

export interface WorkAccountState {
  version: number;
  eid: string;
  openingMinutes: number;
  startMonth: string;
  allocations: Record<string, number>;
}

export interface SchoolCycle {
  year: number;
  id: string;
  label: string;
  start: string;
  lastSchoolDay: string;
  summerStart: string;
  summerEnd: string;
  afterSummerStart: string;
  source: string;
}

export interface MonthCalendar extends Omit<Partial<SchoolCycle>, "year"> {
  status: "active" | "vacation" | "before" | "unknown";
  year: number | null;
  label: string;
  previous?: SchoolCycle | null;
  next?: SchoolCycle | null;
}

export interface WorkSummary {
  month: string;
  schoolYear: MonthCalendar;
  eligible: boolean;
  total: number;
  eligibleWorked: number;
  allocated: number;
  available: number;
  balance: number;
  overallBalance: number;
  invalid: { month: string; allocated: number; worked: number }[];
  remainingToZero: number;
  progressPct: number;
}

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export interface WorkAccountApi {
  VERSION: number;
  START_MONTH: string;
  START_MINUTES: number;
  OFFICIAL: Record<number, { start: string; end: string }>;
  initial(eid: string): WorkAccountState;
  validate(data: unknown, eid: string): WorkAccountState;
  load(eid: string, store?: Store): WorkAccountState;
  persist(state: WorkAccountState, store?: Store): WorkAccountState;
  parseHours(raw: unknown): number;
  hours(minutes: number): string;
  worked(records: Shift[], month: string): number;
  eligibleWorked(records: Shift[], month: string, store?: Store): number;
  allocation(state: WorkAccountState, month: string): number;
  summary(state: WorkAccountState, records: Shift[], month: string, store?: Store): WorkSummary;
  update(state: WorkAccountState, records: Shift[], month: string, minutes: number, store?: Store): WorkAccountState;
  invalidAllocations(state: WorkAccountState, records: Shift[], endMonth?: string | null, store?: Store): WorkSummary["invalid"];
  calendarForMonth(month: string, store?: Store): MonthCalendar;
  schoolYearForDate(date: string, store?: Store): SchoolCycle | null;
  cycle(year: number, store?: Store): SchoolCycle | null;
  balanceForCycle(state: WorkAccountState, year: number, store?: Store, throughMonth?: string | null): number;
  cyclesWithBalances(state: WorkAccountState, store?: Store): { cycle: SchoolCycle; balance: number }[];
  formatDate(value: string): string;
  daysUntil(value: string, reference?: Date): number;
  holiday(year: number, store?: Store): { year: number; start: string; end: string; source: string } | null;
  nextSummer(reference?: Date, store?: Store): { year: number; start: string; end: string } | null;
  findHolidayOnline(year: number, store?: Store): Promise<{ year: number; start: string; end: string; source: string } | null>;
}

export interface PdfAccount {
  test: boolean;
  schoolYear: string;
  schoolStart: string;
  schoolEnd: string;
  summerStart: string;
  workedMinutes: number;
  eligibleMinutes: number;
  allocatedMinutes: number;
  billingMinutes: number;
  balanceMinutes: number;
  initialMinutes: number;
}

export interface PdfArgs {
  employee: { name: string; eid: string };
  month: string;
  records: Shift[];
  test?: boolean;
  account?: PdfAccount | null;
}

export interface PdfApi {
  createBlob(args: PdfArgs): Blob;
  fileFor(args: PdfArgs): File;
  download(file: File): void;
}
