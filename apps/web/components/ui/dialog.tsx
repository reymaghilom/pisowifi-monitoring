"use client";

import * as React from "react";
import { Dialog as D } from "radix-ui";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/* Radix Dialog (focus trap, Esc, scrim click, focus return) styled with the prototype's
   .overlay / .dialog classes. Becomes a bottom sheet at ≤700px via styles/pw.css. */

const keepOpen = (e: Event) => e.preventDefault();

export function Dialog({
  open,
  onClose,
  small,
  alert,
  dismissible = true,
  labelledBy,
  describedBy,
  initialFocus,
  as = "div",
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  small?: boolean;
  alert?: boolean;
  /** false: Escape and clicks/focus outside do nothing; only the dialog's own buttons (X, Cancel) close it. */
  dismissible?: boolean;
  labelledBy: string;
  describedBy?: string;
  /** id of the element to focus when the dialog opens */
  initialFocus?: string;
  as?: "div" | "form";
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
}) {
  // Radix returns focus to a Dialog.Trigger, which these dialogs don't use: remember what had focus when the dialog
  // opened (the button that opened it) and give focus back to it on close, when it is still on the page.
  const opener = React.useRef<HTMLElement | null>(null);
  const body =
    as === "form" ? (
      <form noValidate onSubmit={onSubmit} style={{ display: "contents" }}>
        {children}
      </form>
    ) : (
      children
    );
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="overlay">
          <D.Content
            className={cn("dialog", small && "sm")}
            role={alert ? "alertdialog" : "dialog"}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            onEscapeKeyDown={dismissible ? undefined : keepOpen}
            onPointerDownOutside={dismissible ? undefined : keepOpen}
            onInteractOutside={dismissible ? undefined : keepOpen}
            onCloseAutoFocus={(e) => {
              const el = opener.current;
              opener.current = null;
              if (el?.isConnected) {
                e.preventDefault();
                el.focus();
              }
            }}
            onOpenAutoFocus={(e) => {
              opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
              if (!initialFocus) return;
              const el = document.getElementById(initialFocus);
              if (el) {
                e.preventDefault();
                el.focus();
              }
            }}
          >
            {body}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}

export function DialogHeader({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn("dialog-h", className)} style={style}>
      {children}
    </div>
  );
}

export function DialogTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <D.Title asChild>
      <h2 className="pw-h2" id={id}>
        {children}
      </h2>
    </D.Title>
  );
}

export function DialogBody({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="dialog-b" style={style}>
      {children}
    </div>
  );
}

export function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="dialog-f">{children}</div>;
}

/** For non-dismissible form dialogs: `requestClose` closes at once when nothing changed, otherwise it asks first.
 *  Render `confirm` next to the form dialog. Keep editing (also Escape or a click outside the question) returns to
 *  the form with every value intact; Discard changes closes it. Focus goes back to the button that asked. */
export function useDiscardGuard(dirty: boolean, onClose: () => void) {
  const [asking, setAsking] = React.useState(false);
  const keep = () => setAsking(false);
  const requestClose = () => (dirty ? setAsking(true) : onClose());
  const confirm = (
    <Dialog open={asking} onClose={keep} small alert labelledBy="discard-t" describedBy="discard-d" initialFocus="discard-keep">
      <DialogHeader>
        <DialogTitle id="discard-t">Discard unsaved changes?</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="pw-muted" id="discard-d">
          You have changes in this form that haven’t been saved.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" id="discard-keep" onClick={keep}>
          Keep editing
        </Button>
        <Button variant="danger" onClick={() => (setAsking(false), onClose())}>
          Discard changes
        </Button>
      </DialogFooter>
    </Dialog>
  );
  return { requestClose, confirm };
}
