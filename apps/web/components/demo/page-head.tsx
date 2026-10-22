"use client";

import type { ReactNode } from "react";

/** Page head row (`pw-page-head`): page actions on the right.
 *  Always rendered, even when empty, like the prototype's head(): its slot in the page's flex
 *  column provides the spacing above the first content block. The empty left slot keeps the actions right-aligned. */
export function PageHead({ actions }: { actions?: ReactNode }) {
  return (
    <div className="pw-page-head">
      <div className="pw-row pw-wrap" />
      <div className="pw-row pw-wrap">{actions}</div>
    </div>
  );
}
