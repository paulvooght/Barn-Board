import { useState, useEffect, useCallback } from 'react';
import * as db from '../lib/db';

/**
 * WallsSettings — the consolidated "Walls" area in Settings (multi-wall 2b-iv).
 * Replaces the old header wall-switcher. Three jobs:
 *   1. Your walls — switch the active wall.
 *   2. Join a wall — public walls (Join button) + private walls (by code).
 *   3. Manage this wall (admin only) — public/private toggle, members list,
 *      promote/demote (last-admin guarded server-side), and Leave.
 *
 * All mutations go through db.js (SECURITY DEFINER RPCs from migration 007 for
 * the privileged ones). App owns membership re-resolution via the callbacks:
 *   onSwitchBoard(id)  — switch active wall (nav to board)
 *   onWallJoined(id)   — re-resolve myBoards then switch to the joined wall
 *   onWallLeft()       — re-resolve myBoards then land on a remaining wall
 *   onRolesChanged()   — silent re-resolve (role/visibility change; stay in Settings)
 */
export default function WallsSettings({
  user, myBoards = [], activeBoardId, isAdmin,
  onSwitchBoard, onWallJoined, onWallLeft, onRolesChanged,
}) {
  const activeBoard = myBoards.find(b => b.id === activeBoardId) || null;

  const [publicBoards, setPublicBoards] = useState([]);
  const [code, setCode] = useState('');
  const [members, setMembers] = useState([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');   // info / success
  const [err, setErr] = useState('');   // error

  const loadPublic = useCallback(async () => {
    const { data } = await db.fetchBoards();
    const mine = new Set(myBoards.map(b => b.id));
    setPublicBoards((data || []).filter(b => b.visibility === 'public' && !mine.has(b.id)));
  }, [myBoards]);

  const loadMembers = useCallback(async () => {
    if (!activeBoardId) return;
    setLoadingMembers(true);
    const { members: m, error } = await db.fetchBoardMembers(activeBoardId);
    if (!error) setMembers(m);
    setLoadingMembers(false);
  }, [activeBoardId]);

  useEffect(() => { loadPublic(); }, [loadPublic]);
  useEffect(() => { if (isAdmin) loadMembers(); else setMembers([]); }, [isAdmin, loadMembers]);

  const adminCount = members.filter(m => m.role === 'admin').length;

  // ── actions ──────────────────────────────────────────────────────────────
  const joinPublic = async (b) => {
    if (busy) return; setBusy(true); setErr(''); setMsg('');
    const { error } = await db.joinBoard(b.id, user.id);
    setBusy(false);
    if (error) { setErr(`Couldn't join ${b.name}.`); return; }
    await onWallJoined?.(b.id);
  };

  const joinByCode = async () => {
    const c = code.trim();
    if (!c || busy) return; setBusy(true); setErr(''); setMsg('');
    const { board, error } = await db.joinBoardByCode(c);
    setBusy(false);
    if (error || !board) { setErr(error?.message || 'No wall found for that code.'); return; }
    setCode('');
    await onWallJoined?.(board.id);
  };

  const changeRole = async (m, role) => {
    if (busy) return; setBusy(true); setErr(''); setMsg('');
    const { error } = await db.setMemberRole(activeBoardId, m.user_id, role);
    setBusy(false);
    if (error) { setErr(error.message || 'Could not change role.'); return; }
    setMsg(`${m.display_name} is now ${role === 'admin' ? 'an admin' : 'a member'}.`);
    await loadMembers();
    await onRolesChanged?.();
  };

  const toggleVisibility = async () => {
    if (busy || !activeBoard) return; setBusy(true); setErr(''); setMsg('');
    const next = activeBoard.visibility === 'public' ? 'private' : 'public';
    const { error } = await db.setBoardVisibility(activeBoardId, next);
    setBusy(false);
    if (error) { setErr(error.message || 'Could not change visibility.'); return; }
    setMsg(`${activeBoard.name} is now ${next}.`);
    await onRolesChanged?.();
    await loadPublic();
  };

  const leave = async () => {
    if (busy || !activeBoard) return;
    const codeNote = activeBoard.visibility === 'public' ? '' : ' with a code';
    if (!window.confirm(`Leave "${activeBoard.name}"? You can re-join later${codeNote}. Your routes and sends stay with the wall.`)) return;
    setBusy(true); setErr(''); setMsg('');
    const { error } = await db.leaveBoard(activeBoardId);
    setBusy(false);
    if (error) { setErr(error.message || 'Could not leave.'); return; }
    await onWallLeft?.();
  };

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ marginBottom: '16px' }}>
      {(msg || err) && (
        <div style={{
          ...card, marginBottom: '10px', padding: '10px 12px', fontSize: '12px', fontWeight: 600,
          color: err ? '#9B2A2A' : 'var(--accent)',
          background: err ? 'rgba(155,42,42,0.08)' : 'var(--accent-dim)',
        }}>{err || msg}</div>
      )}

      {/* 1. Your walls */}
      <div style={card}>
        <div style={title}>Your walls</div>
        {myBoards.map(b => {
          const active = b.id === activeBoardId;
          return (
            <div key={b.id} style={row}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: active ? 800 : 600, color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
                {b.name}
                {b.role === 'admin' && <span style={{ ...pill, background: 'var(--accent-dim)', color: 'var(--accent)' }}>ADMIN</span>}
                <span style={{ ...pill, background: 'rgba(26,10,0,0.06)', color: 'var(--text-dim)' }}>{b.visibility}</span>
              </span>
              {active
                ? <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)' }}>current</span>
                : <button style={btnGhost} disabled={busy} onClick={() => onSwitchBoard?.(b.id)}>Switch</button>}
            </div>
          );
        })}
      </div>

      {/* 2. Join a wall */}
      <div style={card}>
        <div style={title}>Join a wall</div>
        {publicBoards.length === 0
          ? <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '12px' }}>No other public walls to join right now.</div>
          : publicBoards.map(b => (
            <div key={b.id} style={row}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>{b.name}</span>
              <button style={btnPrimary} disabled={busy} onClick={() => joinPublic(b)}>Join</button>
            </div>
          ))}
        <div style={{ marginTop: '12px' }}>
          <label style={label}>Have a code? (private walls)</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              style={input} value={code} placeholder="Enter join code"
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') joinByCode(); }}
            />
            <button style={btnPrimary} disabled={busy || !code.trim()} onClick={joinByCode}>Join</button>
          </div>
        </div>
      </div>

      {/* 3. Manage this wall (admin only) */}
      {isAdmin && activeBoard && (
        <div style={card}>
          <div style={title}>Manage {activeBoard.name}</div>

          {/* visibility */}
          <div style={{ ...row, borderBottom: 'none' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Visibility: <b style={{ color: 'var(--accent)' }}>{activeBoard.visibility}</b>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '2px' }}>
                {activeBoard.visibility === 'public' ? 'Anyone can find + join this wall.' : 'Only people with the code can join.'}
              </div>
            </span>
            <button style={btnGhost} disabled={busy} onClick={toggleVisibility}>
              Make {activeBoard.visibility === 'public' ? 'private' : 'public'}
            </button>
          </div>

          {/* members */}
          <div style={{ ...label, marginTop: '14px' }}>Members</div>
          {loadingMembers
            ? <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>Loading…</div>
            : members.map(m => {
              const isSelf = m.user_id === user?.id;
              const isLastAdmin = m.role === 'admin' && adminCount <= 1;
              return (
                <div key={m.user_id} style={row}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {m.display_name}{isSelf && <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>(you)</span>}
                    {m.role === 'admin' && <span style={{ ...pill, background: 'var(--accent-dim)', color: 'var(--accent)' }}>ADMIN</span>}
                  </span>
                  {m.role === 'admin'
                    ? <button style={{ ...btnGhost, opacity: isLastAdmin ? 0.4 : 1 }} disabled={busy || isLastAdmin}
                        title={isLastAdmin ? 'A wall must keep at least one admin' : ''}
                        onClick={() => changeRole(m, 'member')}>Make member</button>
                    : <button style={btnGhost} disabled={busy} onClick={() => changeRole(m, 'admin')}>Make admin</button>}
                </div>
              );
            })}
        </div>
      )}

      {/* 4. Leave the active wall */}
      {activeBoard && (
        <div style={card}>
          <button style={btnDanger} disabled={busy} onClick={leave}>Leave {activeBoard.name}</button>
        </div>
      )}
    </div>
  );
}

// ── styles (match Settings.jsx conventions) ─────────────────────────────────
const card = { background: 'var(--bg-card)', borderRadius: '12px', padding: '16px', border: '1px solid var(--border)', boxShadow: '0 2px 8px rgba(26,10,0,0.06)', marginBottom: '16px' };
const title = { fontSize: '11px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '10px', borderLeft: '3px solid var(--yellow)', paddingLeft: '8px' };
const label = { fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', display: 'block', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' };
const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 0', borderBottom: '1px solid rgba(26,10,0,0.06)' };
const pill = { fontSize: '9px', fontWeight: 800, letterSpacing: '0.5px', padding: '2px 6px', borderRadius: '6px' };
const btnPrimary = { padding: '7px 12px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };
const btnGhost = { padding: '7px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };
const btnDanger = { width: '100%', padding: '11px', borderRadius: '10px', border: '1px solid rgba(155,42,42,0.3)', background: 'rgba(155,42,42,0.06)', color: '#9B2A2A', fontSize: '13px', fontWeight: 700, cursor: 'pointer' };
const input = { flex: 1, padding: '9px 12px', borderRadius: '8px', border: '1.5px solid rgba(26,10,0,0.15)', background: 'rgba(255,255,255,0.7)', fontSize: '14px', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' };
