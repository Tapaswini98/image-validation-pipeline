const KEY = 'photo-collection-id';

/**
 * The photo set this browser is building. Stand-in for a logged-in user: with auth, the
 * server would derive it from the session instead of trusting the client.
 */
export function getCollectionId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID(); // storage blocked (private mode): session-only set
  }
}

export function startNewCollection(): string {
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}
