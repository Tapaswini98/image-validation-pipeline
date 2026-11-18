import type { Env } from './env';

type Role = Env['PROCESS_ROLE'];

/** Read at import time (load-env runs first), so modules can decide which consumers to register. */
export function currentRole(): Role {
  return (process.env.PROCESS_ROLE ?? 'all') as Role;
}

export function runsRole(role: Exclude<Role, 'all'>): boolean {
  const current = currentRole();
  return current === role || current === 'all';
}
