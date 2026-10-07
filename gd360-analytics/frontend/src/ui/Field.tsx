import { createContext, useContext, useId, type LabelHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";
import { WarningIcon } from "./Icons";

// Label (12 caps, muted, 0.04em), FieldHint (12 below) and the Field
// wrapper that wires label -> control -> hint/error with real ids and
// aria-describedby/aria-invalid. Inputs read FieldContext so a bare
// <Field label="X"><Input/></Field> is enough.

type FieldCtx = { id: string; describedBy?: string; invalid: boolean };
const FieldContext = createContext<FieldCtx | null>(null);
export function useFieldContext() { return useContext(FieldContext); }

export function Label({ className, children, required, ...rest }: LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label className={cn("block text-caption font-medium uppercase tracking-caps text-muted", className)} {...rest}>
      {children}
      {required && <span className="text-danger ml-0.5" aria-hidden="true">*</span>}
    </label>
  );
}

export function FieldHint({ className, children, tone = "muted", id }: { className?: string; children: ReactNode; tone?: "muted" | "danger"; id?: string }) {
  return (
    <div id={id} className={cn("text-caption flex items-center gap-1.5", tone === "danger" ? "text-danger" : "text-muted", className)}>
      {tone === "danger" && <WarningIcon size={13} className="shrink-0" />}
      <span>{children}</span>
    </div>
  );
}

export type FieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
  // Inline layout: label to the left of the control (parameter bars).
  inline?: boolean;
};

export function Field({ label, hint, error, required, id: idProp, className, children, inline = false }: FieldProps) {
  const auto = useId();
  const id = idProp || `field-${auto}`;
  const hintId = hint || error ? `${id}-hint` : undefined;
  const invalid = !!error;
  return (
    <FieldContext.Provider value={{ id, describedBy: hintId, invalid }}>
      <div className={cn(inline ? "flex items-center gap-2" : "flex flex-col gap-1.5", className)}>
        {label && (
          <Label htmlFor={id} required={required} className={cn(invalid && "text-danger", inline && "normal-case tracking-normal text-secondary font-mono")}>
            {label}
          </Label>
        )}
        {children}
        {error ? (
          <FieldHint id={hintId} tone="danger">{error}</FieldHint>
        ) : hint ? (
          <FieldHint id={hintId}>{hint}</FieldHint>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
