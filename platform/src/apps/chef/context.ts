import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Employee, MonthAllocation, Tenant, TimeEntry } from "../../core/types";
import type { Session } from "../../data/repository";
import type { AreaRepository } from "../shared/repo";
import { activeShifts } from "../../core/time";
import { summarizeMonth, type WorkAccountMonthSummary } from "../../core/workAccount";

export interface ChefCtx {
  repo: AreaRepository;
  session: Session;
  tenant: Tenant;
  me: Employee;
  version: number;
  changed: () => void;
  setTenant: (t: Tenant) => void;
  signOut: () => void;
}

export const Ctx = createContext<ChefCtx | null>(null);

export function useChef(): ChefCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("ChefCtx fehlt");
  return c;
}

export function monthRange(month: string): [string, string] {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
}

export interface TenantMonth {
  employees: Employee[];
  entries: TimeEntry[];
  allocations: Map<string, MonthAllocation[]>;
  summaries: Map<string, WorkAccountMonthSummary>;
}

/** Loads all data of a tenant needed for monthly overviews. */
export async function loadTenantMonth(repo: AreaRepository, tenant: Tenant, month: string): Promise<TenantMonth> {
  const [from, to] = monthRange(month);
  const [employees, entries] = await Promise.all([repo.listEmployees(tenant.id), repo.listTenantTimeEntries(tenant.id, from, to)]);
  const allocLists = await Promise.all(employees.map((e) => repo.listAllocations(e.id)));
  const allocations = new Map(employees.map((e, i) => [e.id, allocLists[i]!]));
  const summaries = new Map<string, WorkAccountMonthSummary>();
  for (const e of employees) {
    summaries.set(e.id, summarizeMonth({
      entries: activeShifts(entries.filter((x) => x.employeeId === e.id)),
      allocations: allocations.get(e.id) ?? [], month, policy: tenant.settings.workAccount,
    }));
  }
  return { employees, entries, allocations, summaries };
}
