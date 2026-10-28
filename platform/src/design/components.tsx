/** Preact component library of the design system. German labels, accessible defaults. */
import { createContext, type ComponentChildren, type JSX } from "preact";
import { useCallback, useContext, useEffect, useId, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ------------------------------------------------------------ Button

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "icon" | "size" | "type"> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "sm";
  icon?: IconName;
  block?: boolean;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  busy?: boolean;
}

export function Button({ variant = "primary", size = "md", icon, block, type = "button", busy, disabled, class: cls, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy ? "true" : undefined}
      class={cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", block && "btn-block", !children && "btn-icon", cls as string)}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 20} />}
      {children}
    </button>
  );
}

export interface LinkButtonProps extends Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "size" | "icon"> {
  variant?: ButtonProps["variant"];
  size?: "md" | "sm";
  icon?: IconName;
  href: string;
}

export function LinkButton({ variant = "secondary", size = "md", icon, class: cls, children, ...rest }: LinkButtonProps) {
  return (
    <a {...rest} class={cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", cls as string)}>
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 20} />}
      {children}
    </a>
  );
}

// ------------------------------------------------------------ Card

export function Card({ title, actions, accent, muted, children, class: cls, headingLevel = 2, id }: {
  title?: ComponentChildren; actions?: ComponentChildren; accent?: boolean; muted?: boolean;
  children?: ComponentChildren; class?: string; headingLevel?: 2 | 3; id?: string;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section class={cx("card", accent && "card-accent", muted && "card-muted", cls)} id={id} aria-labelledby={title && id ? `${id}-title` : undefined}>
      {(title || actions) && (
        <div class="card-header">
          {title && <H id={id ? `${id}-title` : undefined}>{title}</H>}
          {actions && <div class="btn-row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

// ------------------------------------------------------------ StatTile

export function StatTile({ label, value, hint, tone, class: cls }: {
  label: ComponentChildren; value: ComponentChildren; hint?: ComponentChildren;
  tone?: "default" | "brand" | "warning" | "hero"; class?: string;
}) {
  return (
    <div class={cx("stat", tone && tone !== "default" && `stat-${tone}`, cls)}>
      <span class="stat-label">{label}</span>
      <strong class="stat-value">{value}</strong>
      {hint && <span class="stat-hint">{hint}</span>}
    </div>
  );
}

// ------------------------------------------------------------ Fields

export interface FieldProps {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string | null;
  optional?: boolean;
  class?: string;
  /** Render function receives the ids/aria props for the control. */
  children: (control: { id: string; "aria-invalid"?: "true"; "aria-describedby"?: string }) => ComponentChildren;
}

export function Field({ label, hint, error, optional, class: cls, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div class={cx("field", cls)}>
      <label class="field-label" for={id}>
        {label}
        {optional && <span class="field-optional"> (optional)</span>}
      </label>
      {children({ id, "aria-invalid": error ? "true" : undefined, "aria-describedby": describedBy })}
      {error && (
        <p class="field-error" id={errorId!} role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </p>
      )}
      {hint && <p class="field-hint" id={hintId!}>{hint}</p>}
    </div>
  );
}

type InputAttrs = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "onInput" | "value" | "label" | "size">;

export interface InputFieldProps extends InputAttrs {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string | null;
  optional?: boolean;
  value: string;
  onValue: (value: string) => void;
  large?: boolean;
  suffix?: string;
  fieldClass?: string;
}

export function InputField({ label, hint, error, optional, value, onValue, large, suffix, fieldClass, class: cls, ...rest }: InputFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} optional={optional} class={fieldClass}>
      {(ctl) => {
        const input = (
          <input
            {...rest}
            {...ctl}
            class={cx("input", large && "input-lg", cls as string)}
            value={value}
            onInput={(e) => onValue((e.currentTarget as HTMLInputElement).value)}
          />
        );
        return suffix ? <div class="input-affix">{input}<span>{suffix}</span></div> : input;
      }}
    </Field>
  );
}

export interface SelectFieldProps extends Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, "onInput" | "value" | "label"> {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string | null;
  value: string;
  onValue: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  fieldClass?: string;
}

export function SelectField({ label, hint, error, value, onValue, options, fieldClass, class: cls, ...rest }: SelectFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} class={fieldClass}>
      {(ctl) => (
        <select {...rest} {...ctl} class={cx("select", cls as string)} value={value} onChange={(e) => onValue((e.currentTarget as HTMLSelectElement).value)}>
          {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        </select>
      )}
    </Field>
  );
}

export interface TextareaFieldProps extends Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "onInput" | "value" | "label"> {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string | null;
  optional?: boolean;
  value: string;
  onValue: (value: string) => void;
  fieldClass?: string;
}

export function TextareaField({ label, hint, error, optional, value, onValue, fieldClass, class: cls, ...rest }: TextareaFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} optional={optional} class={fieldClass}>
      {(ctl) => (
        <textarea {...rest} {...ctl} class={cx("textarea", cls as string)} value={value} onInput={(e) => onValue((e.currentTarget as HTMLTextAreaElement).value)} />
      )}
    </Field>
  );
}

export function Checkbox({ label, hint, checked, onChange, disabled }: {
  label: ComponentChildren; hint?: ComponentChildren; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label class="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span>
        <span>{label}</span>
        {hint && <span class="field-hint" style={{ display: "block" }}>{hint}</span>}
      </span>
    </label>
  );
}

// ------------------------------------------------------------ Table

export interface Column<T> {
  key: string;
  header: ComponentChildren;
  /** Label used on mobile card view (defaults to header if string). */
  label?: string;
  render: (row: T) => ComponentChildren;
  align?: "left" | "right";
  actions?: boolean;
}

export function Table<T>({ columns, rows, rowKey, caption, empty, rowClass }: {
  columns: Array<Column<T>>; rows: T[]; rowKey: (row: T) => string; caption?: string;
  empty?: ComponentChildren; rowClass?: (row: T) => string | undefined;
}) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div class="table-wrap">
      <table class="table table-responsive">
        {caption && <caption class="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" class={c.align === "right" ? "th-right" : undefined}>
                {c.actions ? <span class="sr-only">{c.header}</span> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} class={rowClass?.(row)}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  data-label={c.actions ? "" : (c.label ?? (typeof c.header === "string" ? c.header : ""))}
                  class={cx(c.align === "right" && "td-right", c.actions && "td-actions")}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------ Badge / StatusPill

export function Badge({ tone = "neutral", dot, children }: { tone?: Tone; dot?: boolean; children: ComponentChildren }) {
  return <span class={cx("badge", `badge-${tone}`, dot && "badge-dot")}>{children}</span>;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Entwurf", tone: "neutral" },
  submitted: { label: "Eingereicht", tone: "info" },
  approved: { label: "Freigegeben", tone: "success" },
  returned: { label: "Zurückgegeben", tone: "danger" },
  proposed: { label: "Zur Prüfung", tone: "warning" },
  rejected: { label: "Abgelehnt", tone: "danger" },
  active: { label: "Aktiv", tone: "success" },
  invited: { label: "Eingeladen", tone: "info" },
  deactivated: { label: "Deaktiviert", tone: "neutral" },
  suspended: { label: "Gesperrt", tone: "danger" },
  pending: { label: "In Vorbereitung", tone: "warning" },
  expired: { label: "Abgelaufen", tone: "neutral" },
  none: { label: "Nicht erstellt", tone: "neutral" },
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return <Badge tone={s.tone} dot>{label ?? s.label}</Badge>;
}

// ------------------------------------------------------------ Alert

const ALERT_ICON: Record<string, IconName> = { info: "info", success: "checkCircle", warning: "alert", danger: "alert" };

export function Alert({ tone = "info", title, children, live }: {
  tone?: "info" | "success" | "warning" | "danger"; title?: ComponentChildren; children?: ComponentChildren; live?: boolean;
}) {
  const role = live ? (tone === "danger" ? "alert" : "status") : undefined;
  return (
    <div class={`alert alert-${tone}`} role={role}>
      <Icon name={ALERT_ICON[tone] ?? "info"} />
      <div>
        {title && <strong class="alert-title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ Dialog

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({ open, title, onClose, children, footer, describedBy }: {
  open: boolean; title: ComponentChildren; onClose: () => void; children?: ComponentChildren;
  footer?: ComponentChildren; describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      returnFocus.current = document.activeElement;
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
      const auto = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
      auto?.focus();
    } else if (!open && el.open) {
      el.close();
      (returnFocus.current as HTMLElement | null)?.focus?.();
    }
  }, [open]);

  // Explicit focus trap (in addition to the native modal inertness).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={onKeyDown}
    >
      {open && (
        <div class="dialog-inner">
          <div class="dialog-header">
            <h2 id={titleId}>{title}</h2>
            <Button variant="ghost" icon="x" aria-label="Dialog schließen" onClick={onClose} />
          </div>
          <div class="dialog-body">{children}</div>
          {footer && <div class="dialog-footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ------------------------------------------------------------ Confirm / reason dialogs (replace window.confirm)

interface ConfirmOptions {
  title: string;
  message: ComponentChildren;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
interface ReasonOptions extends ConfirmOptions {
  reasonLabel?: string;
  reasonHint?: string;
}
interface DialogApi {
  confirm(o: ConfirmOptions): Promise<boolean>;
  /** Resolves with the trimmed reason or null when cancelled. Reason is mandatory. */
  askReason(o: ReasonOptions): Promise<string | null>;
  alert(o: { title: string; message: ComponentChildren }): Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

type Pending =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "reason"; opts: ReasonOptions; resolve: (v: string | null) => void }
  | { kind: "alert"; opts: { title: string; message: ComponentChildren }; resolve: () => void };

export function DialogProvider({ children }: { children: ComponentChildren }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const msgId = useId();

  const api = useRef<DialogApi>({
    confirm: (opts) => new Promise((resolve) => setPending({ kind: "confirm", opts, resolve })),
    askReason: (opts) => new Promise((resolve) => { setReason(""); setError(null); setPending({ kind: "reason", opts, resolve }); }),
    alert: (opts) => new Promise((resolve) => setPending({ kind: "alert", opts, resolve })),
  }).current;

  const close = (ok: boolean) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(ok);
    else if (pending.kind === "alert") pending.resolve();
    else {
      if (ok && !reason.trim()) { setError("Bitte eine Begründung angeben."); return; }
      pending.resolve(ok ? reason.trim() : null);
    }
    setPending(null);
  };

  const opts = pending?.opts as ReasonOptions | undefined;
  return (
    <DialogContext.Provider value={api}>
      {children}
      <Dialog
        open={!!pending}
        title={opts?.title ?? ""}
        onClose={() => close(false)}
        describedBy={msgId}
        footer={pending && (
          pending.kind === "alert"
            ? <Button onClick={() => close(true)} data-autofocus>OK</Button>
            : <>
                <Button variant="secondary" onClick={() => close(false)}>{opts?.cancelLabel ?? "Abbrechen"}</Button>
                <Button variant={opts?.danger ? "danger" : "primary"} onClick={() => close(true)}>{opts?.confirmLabel ?? "Bestätigen"}</Button>
              </>
        )}
      >
        <div id={msgId} class="stack-sm">{typeof opts?.message === "string" ? <p>{opts.message}</p> : opts?.message}</div>
        {pending?.kind === "reason" && (
          <form onSubmit={(e) => { e.preventDefault(); close(true); }} style={{ marginTop: "var(--space-4)" }}>
            <TextareaField
              label={opts?.reasonLabel ?? "Begründung"}
              hint={opts?.reasonHint ?? "Pflichtangabe – wird im Änderungsprotokoll gespeichert."}
              value={reason}
              onValue={(v) => { setReason(v); setError(null); }}
              error={error}
              maxLength={500}
              data-autofocus
              required
            />
          </form>
        )}
      </Dialog>
    </DialogContext.Provider>
  );
}

export function useDialogs(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("DialogProvider fehlt.");
  return ctx;
}

// ------------------------------------------------------------ Tabs

export function Tabs<K extends string>({ tabs, value, onChange, label }: {
  tabs: Array<{ key: K; label: string }>; value: K; onChange: (k: K) => void; label: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + tabs.length) % tabs.length;
    onChange(tabs[next]!.key);
    refs.current[next]?.focus();
  };
  return (
    <div class="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.key}
          ref={(el) => { refs.current[i] = el; }}
          role="tab"
          class="tab"
          type="button"
          aria-selected={t.key === value ? "true" : "false"}
          tabIndex={t.key === value ? 0 : -1}
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<K extends string>({ options, value, onChange, label }: {
  options: Array<{ key: K; label: string }>; value: K; onChange: (k: K) => void; label: string;
}) {
  return (
    <div class="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={o.key === value ? "true" : "false"} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ Navigation

export interface NavItem { href: string; label: string; icon: IconName; count?: number; match?: string }

export function BottomNav({ items, current }: { items: NavItem[]; current: string }) {
  return (
    <nav class="bottom-nav" aria-label="Hauptnavigation">
      <ul>
        {items.map((it) => (
          <li key={it.href}>
            <a href={it.href} aria-current={current === (it.match ?? it.href) ? "page" : undefined}>
              <span class="bn-icon"><Icon name={it.icon} size={22} /></span>
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Sidebar({ items, current, brand, footer, open, onNavigate }: {
  items: NavItem[]; current: string; brand: ComponentChildren; footer?: ComponentChildren; open: boolean; onNavigate: () => void;
}) {
  return (
    <>
      {open && <div class="sidebar-scrim" onClick={onNavigate} aria-hidden="true" />}
      <aside class={cx("sidebar", open && "is-open")} id="sidebar">
        <div class="sidebar-brand">{brand}</div>
        <nav aria-label="Hauptnavigation">
          <ul>
            {items.map((it) => (
              <li key={it.href}>
                <a class="sidebar-link" href={it.href} onClick={onNavigate} aria-current={current === (it.match ?? it.href) ? "page" : undefined}>
                  <Icon name={it.icon} />
                  <span>{it.label}</span>
                  {it.count ? <span class="count"><Badge tone="warning">{it.count}</Badge></span> : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {footer && <div class="sidebar-footer">{footer}</div>}
      </aside>
    </>
  );
}

// ------------------------------------------------------------ Progress

export function Progress({ value, max = 100, label, valueText }: { value: number; max?: number; label: string; valueText?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div>
      <div class="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={valueText}>
        <div class="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ EmptyState

export function EmptyState({ icon = "info", title, children, action }: {
  icon?: IconName; title: ComponentChildren; children?: ComponentChildren; action?: ComponentChildren;
}) {
  return (
    <div class="empty">
      <Icon name={icon} size={40} />
      <p class="empty-title">{title}</p>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// ------------------------------------------------------------ Toast

interface ToastItem { id: number; message: string; tone: "info" | "success" | "error" }
const ToastContext = createContext<((message: string, tone?: ToastItem["tone"]) => void) | null>(null);

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback((message: string, tone: ToastItem["tone"] = "success") => {
    const id = ++seq.current;
    setItems((list) => [...list.slice(-2), { id, message, tone }]);
    setTimeout(() => dismiss(id), tone === "error" ? 10000 : 7000);
  }, [dismiss]);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div class="toast-region" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} class={`toast toast-${t.tone}`}>
            <Icon name={t.tone === "error" ? "alert" : t.tone === "success" ? "checkCircle" : "info"} />
            <span>{t.message}</span>
            <button type="button" aria-label="Meldung schließen" onClick={() => dismiss(t.id)}><Icon name="x" size={16} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("ToastProvider fehlt.");
  return ctx;
}
