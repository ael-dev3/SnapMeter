import { useId, useState } from "react";

export function InfoTip({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip">
      <button
        type="button"
        className="info-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      <span id={id} role="tooltip" className="tooltip" data-open={open || undefined}>
        {children}
      </span>
    </span>
  );
}
