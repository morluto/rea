"use client";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import type { JobStatus } from "@rea-studio/core/types";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { statusLabel, useLocale } from "./Locale";
export const buttonClass = (
  variant: "primary" | "ghost" | "danger" | "quiet" = "primary",
  extra = "",
) => `button button-${variant} ${extra}`;
export const Button = ({
  variant = "primary",
  className = "",
  busy = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "quiet";
  busy?: boolean;
}) => (
  <button
    {...props}
    disabled={props.disabled || busy}
    className={buttonClass(variant, className)}
  >
    {busy && <LoaderCircle size={16} className="spin" />}
    {children}
  </button>
);
export const Input = ({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={`field-input ${className}`} />
);
export const Textarea = ({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={`field-input field-textarea ${className}`} />
);
export const Select = ({
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={`field-input field-select ${className}`} />
);
export const Field = ({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) => (
  <div className="field">
    <label htmlFor={htmlFor}>{label}</label>
    {children}
    {hint && <p className="field-hint">{hint}</p>}
  </div>
);
export const Card = ({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) => <section className={`card ${className}`}>{children}</section>;
export const PageTitle = ({
  title,
  children,
  actions,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) => (
  <header className="page-heading">
    <div>
      <h1>{title}</h1>
      {children && <p className="page-description">{children}</p>}
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>
);
export const StatusPill = ({ status }: { status: JobStatus }) => {
  const { locale } = useLocale();
  return (
    <span className={`status status-${status}`}>
      <span />
      {statusLabel(status, locale)}
    </span>
  );
};
export const Tag = ({ children }: { children: ReactNode }) => (
  <span className="tag">{children}</span>
);
export const ErrorNotice = ({ message }: { message?: string }) => {
  const { t } = useLocale();
  return message ? (
    <div className="notice notice-error" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>
          {t(
            "No se pudo completar la operación",
            "Could not complete this action",
          )}
        </strong>
        <p>{message}</p>
      </div>
    </div>
  ) : null;
};
export const EmptyState = ({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) => (
  <div className="empty-state">
    <span className="empty-icon">{icon}</span>
    <h3>{title}</h3>
    <p>{children}</p>
    {action}
  </div>
);
