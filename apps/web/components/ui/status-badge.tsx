import { NO_RESULT, NO_RESULT_LABEL, STATUS } from "@/lib/constants";
import type { MachineStatus, StatusKey } from "@/lib/types";
import { Icon } from "@/components/ui/icon";

/** Word + icon + colour for every state, so colour is never the only signal. */
export function StatusBadge({ status, label }: { status: StatusKey; label?: string }) {
  const [tone, icon, word] = STATUS[status] ?? STATUS.nodata;
  return (
    <span className={"pw-badge " + tone}>
      <Icon name={icon} size={14} />
      {label ?? word}
    </span>
  );
}

/** A machine's connectivity: Online (green) or Offline (red). Before the first valid check there is no
 *  status to show: a neutral dash, never a third status. */
export function ConnectivityBadge({ status }: { status: MachineStatus | null }) {
  if (!status)
    return (
      <span className="pw-muted no-result" title={NO_RESULT_LABEL}>
        {NO_RESULT}
      </span>
    );
  return <StatusBadge status={status} />;
}
