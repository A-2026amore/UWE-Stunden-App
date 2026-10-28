import { useState } from "preact/hooks";
import type { Employee, TenantRole } from "../../../core/types";
import { Alert, Button, Card, Dialog, InputField, SelectField, StatusPill, Table, useDialogs, useToast } from "../../../design";
import { errorText, useAsync } from "../../shared/hooks";
import { ROLE_LABEL, dateTimeDE } from "../../shared/format";
import type { InvitationChannel, InvitationInfo, InvitedEmployee } from "../../../data/repository";
import { useChef } from "../context";
import { InvitationShareDialog, invitationText } from "../InvitationShare";

interface FormState { displayName: string; personnelNumber: string; email: string; role: TenantRole; channel: InvitationChannel }
const EMPTY: FormState = { displayName: "", personnelNumber: "", email: "", role: "employee", channel: "email" };

export function EmployeesPage() {
  const { repo, tenant, me, version, changed } = useChef();
  const toast = useToast();
  const dialogs = useDialogs();
  const q = useAsync(() => repo.listEmployees(tenant.id), [version]);
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "invited" | "locked" | "deactivated">("all");
  const [sent, setSent] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
  const [sharing, setSharing] = useState<{ employee: Employee; initial: InvitationInfo | null } | null>(null);

  const open = (e: Employee | "new") => {
    setEditing(e);
    setError(null);
    setForm(e === "new" ? EMPTY : { displayName: e.displayName, personnelNumber: e.personnelNumber, email: e.email ?? "", role: e.role, channel: "email" });
  };

  const save = async (ev: Event) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing === "new") {
        const email = form.email.trim() || null;
        const emp: InvitedEmployee = await repo.inviteEmployee(tenant.id, {
          displayName: form.displayName, personnelNumber: form.personnelNumber, email, role: form.role, invitation: form.channel,
        });
        toast(`${emp.displayName} wurde angelegt.`);
        if (emp.email && emp.invitation?.link) {
          setSent(null);
          setSharing({ employee: emp, initial: emp.invitation });
        } else {
          setSent(emp.email && emp.invitation
            ? invitationText(emp.displayName, emp.email, emp.invitation)
            : { tone: "warning", text: `${emp.displayName} hat keine E-Mail-Adresse – es wurde keine Einladung erstellt. Trage eine E-Mail-Adresse ein (sie ist der Anmeldename) und nutze dann „Zugang senden“.` });
        }
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

  type StatusAction = "lock" | "unlock" | "deactivate" | "activate";
  const ACTIONS: Record<StatusAction, { status: "active" | "locked" | "deactivated"; title: string; message: string; confirm: string; done: string; danger: boolean }> = {
    lock: {
      status: "locked", title: "sperren?", confirm: "Sperren", done: "Zugang gesperrt.", danger: true,
      message: "Vorübergehende Sperre: Die Anmeldung ist sofort nicht mehr möglich, alle Daten bleiben erhalten. Die Sperre kann jederzeit aufgehoben werden. Für den laufenden Monat wird die Person noch berechnet, ab dem Folgemonat nicht mehr.",
    },
    unlock: { status: "active", title: "entsperren?", confirm: "Entsperren", done: "Zugang entsperrt.", danger: false, message: "Die Anmeldung ist wieder möglich." },
    deactivate: {
      status: "deactivated", title: "deaktivieren?", confirm: "Deaktivieren", done: "Zugang deaktiviert.", danger: true,
      message: "Für ausgeschiedene Mitarbeitende: Der Zugang wird sofort gesperrt. Bereits erfasste Zeiten bleiben vollständig erhalten. Ab dem Folgemonat wird die Person nicht mehr berechnet.",
    },
    activate: { status: "active", title: "wieder aktivieren?", confirm: "Aktivieren", done: "Zugang aktiviert.", danger: false, message: "Der Zugang wird wieder freigeschaltet." },
  };

  const changeStatus = async (e: Employee, action: StatusAction) => {
    const a = ACTIONS[action];
    const reason = await dialogs.askReason({
      title: `${e.displayName} ${a.title}`, message: a.message, confirmLabel: a.confirm, danger: a.danger, reasonLabel: "Grund",
    });
    if (!reason) return;
    try {
      await repo.setEmployeeStatus(e.id, a.status, reason);
      toast(a.done);
      changed();
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  const statusButtons = (e: Employee) => {
    const actions: StatusAction[] = e.status === "active" ? ["lock", "deactivate"]
      : e.status === "locked" ? ["unlock", "deactivate"]
      : e.status === "deactivated" ? ["activate"] : ["deactivate"];
    return actions.map((act) => (
      <Button key={act} size="sm" variant={act === "unlock" || act === "activate" ? "secondary" : "ghost"} onClick={() => changeStatus(e, act)}
        aria-label={`${e.displayName} ${ACTIONS[act].confirm.toLowerCase()}`}>
        {ACTIONS[act].confirm}
      </Button>
    ));
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
      {sent && <Alert tone={sent.tone} live title="Einladung"><p data-testid="invitation-status">{sent.text}</p></Alert>}
      <Card>
        <div class="toolbar">
          <SelectField label="Anzeigen" value={filter} onValue={(v) => setFilter(v as typeof filter)} options={[
            { value: "all", label: "Alle" }, { value: "active", label: "Aktiv" }, { value: "invited", label: "Eingeladen" }, { value: "locked", label: "Gesperrt" }, { value: "deactivated", label: "Deaktiviert" },
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
                  {e.status === "invited" && (
                    <Button size="sm" variant="primary" icon="send" onClick={() => setSharing({ employee: e, initial: null })} aria-label={`Zugang an ${e.displayName} senden`}>Zugang senden</Button>
                  )}
                  {e.id !== me.id && statusButtons(e)}
                </div>
              ),
            },
          ]}
        />
      </Card>

      <InvitationShareDialog employee={sharing?.employee ?? null} initial={sharing?.initial ?? null} onClose={() => setSharing(null)} />

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
          <InputField label="E-Mail-Adresse" type="email" optional value={form.email} onValue={set("email")} hint="Anmeldename für die App. Ohne E-Mail-Adresse wird keine Einladung erstellt." />
          {editing === "new" && (
            <SelectField label="Zugang senden" value={form.channel} onValue={(v) => setForm({ ...form, channel: v as InvitationChannel })}
              disabled={!form.email.trim()}
              hint="Einmaliger Einladungslink, 7 Tage gültig. Die Person legt ihr Passwort selbst fest – es wird kein Passwort verschickt."
              options={[{ value: "email", label: "Per E-Mail senden" }, { value: "link", label: "Link selbst teilen (WhatsApp oder kopieren)" }]} />
          )}
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
