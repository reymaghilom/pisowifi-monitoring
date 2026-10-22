export type StatusKey = 'reachable'|'unreachable'|'recent'|'stale'|'unknown'|'error'|'inet'|'soon'|'notconn'|'demo'|'sample'|'proto'|'enabled'|'paused'|'failed'|'nodata';
export interface StatusBadgeProps { key: StatusKey; label?: string }
export interface AppShellProps { active: 'dash'|'machines'|'detail'|'remote'|'history'|'reports'|'auto'|'settings'; title: string; subtitle?: string; content: string; actions?: string }
export interface LineChartProps { w?: number; h?: number; labels: string[]; min: number; max: number; ticks?: number; unit?: string; series: { v: number[]; cls: 'l1'|'l2'; area?: boolean }[]; alt?: string }
