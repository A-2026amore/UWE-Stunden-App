import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Employee, Tenant } from "../../core/types";
import type { Session } from "../../data/repository";
import type { DemoRepository } from "../../data/demo";

export interface EmployeeCtx {
  repo: DemoRepository;
  session: Session;
  tenant: Tenant;
  me: Employee;
  /** Month shown on Monat / Konto ("YYYY-MM"). */
  month: string;
  setMonth: (m: string) => void;
  /** Increments after every data change so pages reload. */
  version: number;
  changed: () => void;
  signOut: () => void;
}

export const Ctx = createContext<EmployeeCtx | null>(null);

export function useEmployee(): EmployeeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("EmployeeCtx fehlt");
  return c;
}
