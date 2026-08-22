// Persistent queue of sessions that haven't yet been confirmed synced to Supabase.
// On flaky networks (cellular, screen-lock mid-save) the upsert can silently fail.
// We keep a copy in localStorage until Supabase confirms the write, then dequeue.
// On every load + visibility refetch the queue is merged into the sessions list and
// retried, so a finished session can never vanish just because the network blinked.

const STORAGE_KEY = 'barnboard_pending_session_sync';

function readQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.error('[pendingSessionSync] write failed:', err);
  }
}

export function getPendingSessions() {
  return readQueue();
}

export function getPendingSessionIds() {
  return Object.keys(readQueue());
}

// Add or replace an entry. Always resets attempts to 0 so the freshly-saved
// payload gets a clean retry budget.
export function enqueueSession(session) {
  if (!session || !session.id) return;
  const queue = readQueue();
  queue[session.id] = {
    session,
    attempts: 0,
    lastAttempt: null,
    lastError: null,
    enqueuedAt: queue[session.id]?.enqueuedAt || new Date().toISOString(),
  };
  writeQueue(queue);
}

export function dequeueSession(sessionId) {
  if (!sessionId) return;
  const queue = readQueue();
  if (queue[sessionId]) {
    delete queue[sessionId];
    writeQueue(queue);
  }
}

export function recordFailure(sessionId, error) {
  const queue = readQueue();
  if (!queue[sessionId]) return;
  queue[sessionId].attempts = (queue[sessionId].attempts || 0) + 1;
  queue[sessionId].lastAttempt = new Date().toISOString();
  queue[sessionId].lastError = error ? String(error.message || error) : 'unknown';
  writeQueue(queue);
}
