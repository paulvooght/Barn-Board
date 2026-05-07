// Persistent queue of routes that haven't yet been confirmed synced to Supabase.
// On flaky networks (cellular, screen-lock mid-save) the upsert can silently fail.
// We keep a copy in localStorage until Supabase confirms the write, then dequeue.
// On every load + visibility refetch the queue is merged into the routes list and
// retried, so a created route can never vanish just because the network blinked.

const STORAGE_KEY = 'barnboard_pending_route_sync';

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
    console.error('[pendingRouteSync] write failed:', err);
  }
}

export function getPendingRoutes() {
  return readQueue();
}

export function getPendingRouteIds() {
  return Object.keys(readQueue());
}

// Add or replace an entry. Always resets attempts to 0 so the freshly-saved
// payload gets a clean retry budget.
export function enqueueRoute(route) {
  if (!route || !route.id) return;
  const queue = readQueue();
  queue[route.id] = {
    route,
    attempts: 0,
    lastAttempt: null,
    lastError: null,
    enqueuedAt: queue[route.id]?.enqueuedAt || new Date().toISOString(),
  };
  writeQueue(queue);
}

export function dequeueRoute(routeId) {
  if (!routeId) return;
  const queue = readQueue();
  if (queue[routeId]) {
    delete queue[routeId];
    writeQueue(queue);
  }
}

export function recordFailure(routeId, error) {
  const queue = readQueue();
  if (!queue[routeId]) return;
  queue[routeId].attempts = (queue[routeId].attempts || 0) + 1;
  queue[routeId].lastAttempt = new Date().toISOString();
  queue[routeId].lastError = error ? String(error.message || error) : 'unknown';
  writeQueue(queue);
}
