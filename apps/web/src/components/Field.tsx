import { useId, type ReactNode } from 'react';

interface ControlProps {
  readonly id: string;
  readonly 'aria-describedby'?: string;
}

interface Props {
  readonly label: string;
  /** Help text: tied to the control with aria-describedby, so it is not part of the control's name. */
  readonly hint?: string;
  /** Renders the control; it must spread the props it is given. */
  readonly children: (control: ControlProps) => ReactNode;
}

/** A labelled control whose name is just its label, with an optional hint read after it. */
export function Field({ label, hint, children }: Props) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(hint === undefined ? {} : { 'aria-describedby': hintId }) })}
      {hint === undefined ? null : (
        <small id={hintId} className="hint">
          {hint}
        </small>
      )}
    </div>
  );
}
