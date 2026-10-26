import { useState } from "preact/hooks";
import type { Employee, TenantRole } from "../../../core/types";
import { Alert, Button, Card, Dialog, InputField, SelectField, StatusPill, Table, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { ROLE_LABEL, dateTimeDE } from "../../shared/format";
import { useChef } from "../context";

interface FormState { displayName: string; personnelNumber: string; email: string; role: TenantRole }
const EMPTY: FormState = { displayName: "", personnelNumber: "", email: "", role: "employee" };

export function EmployeesPage() {
  const { repo, tenant, me, version, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const q = useAsync(() => repo.listEmployees(tenant.id), [version]);
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "invited" | "deactivated">("all");

  const open = (e: Employee | "new") => {
    setEditing(e);
    setError(null);
    setForm(e === "new" ? EMPTY : { displayName: e.displayName, personnelNumber: e.personnelNumber, email: e.email ?? "", role: e.role });
  };

  const save = async (ev: Event) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing === "new") {
        const emp = await repo.inviteEmployee(tenant.id, { displayName: form.displayName, personnelNumber: form.personnelNumber, email: form.email.trim() || null, role: form.role });
        toast(`${emp.displayName} wurde eingeladen.${emp.email ? " (Demo: keine E-Mail versendet, Passwort „demo“)" : ""}`);
      } else if (editing) {
        await repo.updateEmployee(editing.id, { displayName: form.displayName, personnelNumber: form.personnelNumber, email: form.email.trim() || null, ...(form.role !== editing.role ? { role: form.role } : {}) });
        toast("Änderungen gespeichert.");
      }
      setEditing(null);
      changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (e: Employee) => {
    const deactivate = e.status !== "deactivated";
    const reason = await dialogs.askReason({
      title: deactivate ? `${e.displayName} deaktivieren?` : `${e.displayName} wieder aktivieren?`,
      message: deactivate
        ? "Der Zugang wird sofort gesperrt. Bereits erfasste Zeiten bleiben vollständig erhalten."
        : "Der Zugang wird wieder freigeschaltet.",
      confirmLabel: deactivate ? "Deaktivieren" : "Aktivieren",
      danger: deactivate,
      reasonLabel: "Grund",
    });
    if (!reason) return;
    try {
      await repo.setEmployeeStatus(e.id, deactivate ? "deactivated" : "active", reason);
      toast(deactivate ? "Zugang deaktiviert." : "Zugang aktiviert.");
      changed();
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  const list = (q.data ?? []).filter((e) => filter === "all" || e.status === filter);
  const set = (k: keyof FormState) => (v: string) => setForm({ ...form, [k]: v });

  return (
    <div class="stack">
      <div class="row-between">
        <h1 class="page-title">Mitarbeiter</h1>
        <Button icon="plus" onClick={() => open("new")}>Mitarbeiter einladen</Button>
      </div>
      {q.error && <Alert tone="danger" live>{q.error}</Alert>}
      <Card>
        <div class="toolbar">
          <SelectField label="Anzeigen" value={filter} onValue={(v) => setFilter(v as typeof filter)} options={[
            { value: "all", label: "Alle" }, { value: "active", label: "Aktiv" }, { value: "invited", label: "Eingeladen" }, { value: "deactivated", label: "Deaktiviert" },
          ]} />
          <p class="muted small mb-0">{list.length} von {q.data?.length ?? 0} Einträgen</p>
        </div>
        <Table<Employee>
          caption="Mitarbeiterliste"
          rows={list}
          rowKey={(e) => e.id}
          empty={<p class="muted">Keine Einträge.</p>}
          columns={[
            { key: "n", header: "Name", render: (e) => <strong>{e.displayName}</strong> },
            { key: "p", header: "Personalnr.", render: (e) => e.personnelNumber },
            { key: "e", header: "E-Mail", render: (e) => e.email ?? "—" },
            { key: "r", header: "Rolle", render: (e) => ROLE_LABEL[e.role] },
            { key: "s", header: "Status", render: (e) => <StatusPill status={e.status} /> },
            { key: "c", header: "Angelegt", render: (e) => <span class="small muted">{dateTimeDE(e.createdAt).split(",")[0]}</span> },
            {
              key: "a", header: "Aktionen", actions: true, render: (e) => (
                <div class="btn-row" style={{ justifyContent: "flex-end" }}>
                  <Button size="sm" variant="secondary" icon="edit" onClick={() => open(e)} aria-label={`${e.displayName} bearbeiten`}>Bearbeiten</Button>
                  {e.id !== me.id && (
                    <Button size="sm" variant={e.status === "deactivated" ? "secondary" : "ghost"} onClick={() => toggle(e)} aria-label={`${e.displayName} ${e.status === "deactivated" ? "aktivieren" : "deaktivieren"}`}>
                      {e.status === "deactivated" ? "Aktivieren" : "Deaktivieren"}
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Dialog
        open={editing !== null}
        title={editing === "new" ? "Mitarbeiter einladen" : "Mitarbeiter bearbeiten"}
        onClose={() => setEditing(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Abbrechen</Button>
          <Button type="submit" form="employee-form" busy={busy}>{editing === "new" ? "Einladen" : "Speichern"}</Button>
        </>}
      >
        <form id="employee-form" class="stack" onSubmit={save} noValidate>
          <InputField label="Name" value={form.displayName} onValue={set("displayName")} required autoComplete="off" data-autofocus />
          <InputField label="Personalnummer" value={form.personnelNumber} onValue={set("personnelNumber")} required hint="Buchstaben, Ziffern, - und _ (max. 30 Zeichen)." />
          <InputField label="E-Mail-Adresse" type="email" optional value={form.email} onValue={set("email")} hint="An diese Adresse geht die Einladung zur Anmeldung." />
          <SelectField label="Rolle" value={form.role} onValue={(v) => setForm({ ...form, role: v as TenantRole })}
            disabled={me.role !== "owner" || (editing !== "new" && editing?.id === me.id)}
            hint={me.role !== "owner" ? "Rollen kann nur der Inhaber ändern." : undefined}
            options={[{ value: "employee", label: ROLE_LABEL.employee! }, { value: "manager", label: ROLE_LABEL.manager! }, { value: "owner", label: ROLE_LABEL.owner! }]} />
          {error && <Alert tone="danger" live>{error}</Alert>}
        </form>
      </Dialog>
    </div>
  );
}
