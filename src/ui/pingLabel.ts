/** «42 ms»; без замера — пусто. */
export function pingLabel(pingMs: number | null | undefined): string {
  return typeof pingMs === 'number' && Number.isFinite(pingMs) && pingMs >= 0 ? `${Math.round(pingMs)} ms` : ''
}
