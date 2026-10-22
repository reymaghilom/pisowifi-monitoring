"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

/** DOM id for a field. Cache Components keeps recently visited routes mounted (hidden) in the
 *  document, so two instances of a page can coexist; a fixed id would then be duplicated and the
 *  visible field's <label for> could point at the hidden copy. By default the id gets a unique
 *  suffix; `stable` keeps it as given (single-instance UI such as dialogs that focus fields by id). */
export function useFieldId(id: string, stable?: boolean) {
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return stable ? id : id + "-" + uid;
}

interface FieldShellProps {
  id: string;
  label: React.ReactNode;
  error?: string;
  ok?: boolean;
  help?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/** `pw-field`: label, control, then an error (with icon) or helper line. */
export function Field({ id, label, error, ok, help, className, children }: FieldShellProps) {
  return (
    <div className={cn("pw-field", error ? "err" : ok ? "ok" : "", className)}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <div id={id + "-m"} className="pw-msg-err">
          <Icon name="alert" size={14} />
          {error}
        </div>
      ) : help ? (
        <div id={id + "-m"} className="pw-help">
          {help}
        </div>
      ) : null}
    </div>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  id: string;
  label: React.ReactNode;
  value: string;
  onValue?: (v: string) => void;
  error?: string;
  ok?: boolean;
  help?: React.ReactNode;
  mono?: boolean;
  fieldClassName?: string;
  /** keep `id` as the DOM id (see useFieldId) */
  stableId?: boolean;
};

export const TextField = React.forwardRef<HTMLInputElement, InputProps>(function TextField(
  { id: idProp, label, value, onValue, error, ok, help, mono, fieldClassName, className, type = "text", stableId, ...props },
  ref,
) {
  const id = useFieldId(idProp, stableId);
  return (
    <Field id={id} label={label} error={error} ok={ok} help={help} className={fieldClassName}>
      <input
        ref={ref}
        id={id}
        className={cn("pw-input", mono && "pw-mono", className)}
        type={type}
        value={value}
        onChange={(e) => onValue?.(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || help ? id + "-m" : undefined}
        {...props}
      />
    </Field>
  );
});

export const PasswordField = React.forwardRef<HTMLInputElement, Omit<InputProps, "type">>(function PasswordField(
  { id: idProp, label, value, onValue, error, help, stableId, ...props },
  ref,
) {
  const id = useFieldId(idProp, stableId);
  const [show, setShow] = React.useState(false);
  return (
    <Field id={id} label={label} error={error} help={help}>
      <div className="pw-input-wrap">
        <input
          ref={ref}
          id={id}
          className="pw-input"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onValue?.(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || help ? id + "-m" : undefined}
          {...props}
        />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={(show ? "Hide" : "Show") + " password"} aria-pressed={show}>
          <Icon name={show ? "eyeoff" : "eye"} />
        </button>
      </div>
    </Field>
  );
});

export function SelectField<T extends string>({
  id: idProp,
  stableId,
  label,
  value,
  options,
  onValue,
  help,
  error,
  className,
}: {
  id: string;
  label: React.ReactNode;
  value: T;
  /** [value, label, disabled?]: a disabled option can show a stored value without letting anyone pick it. */
  options: readonly (readonly [T, string, boolean?])[];
  onValue: (v: T) => void;
  help?: React.ReactNode;
  error?: string;
  className?: string;
  stableId?: boolean;
}) {
  const id = useFieldId(idProp, stableId);
  return (
    <Field id={id} label={label} help={help} error={error} className={className}>
      <select id={id} className="pw-select" value={value} onChange={(e) => onValue(e.target.value as T)}>
        {options.map(([v, l, disabled]) => (
          <option key={v} value={v} disabled={disabled}>
            {l}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextareaField({
  id: idProp,
  stableId,
  label,
  value,
  onValue,
  placeholder,
}: {
  id: string;
  stableId?: boolean;
  label: React.ReactNode;
  value: string;
  onValue: (v: string) => void;
  placeholder?: string;
}) {
  const id = useFieldId(idProp, stableId);
  return (
    <div className="pw-field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} className="pw-textarea" value={value} placeholder={placeholder} onChange={(e) => onValue(e.target.value)} />
    </div>
  );
}
