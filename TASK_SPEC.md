# TASK_SPEC.md — Template for Sending Work to Builder Thread

Copy this template, fill it in, and paste it into the Sonnet Builder thread.

---

## Task: [Short title]

### Goal
[1-2 sentences: what should be different when this is done]

### Why
[1 sentence: why this matters to the user/product]

### Files to Modify
- `src/path/to/file.jsx` — [what changes here]
- `src/path/to/other.js` — [what changes here]

### Relevant Context
[Any architecture details, data shapes, or patterns the builder needs to know. Reference CLAUDE.md sections if applicable.]

### Desired Behaviour
1. [Step-by-step description of what should happen]
2. [Be specific about UI, data flow, edge cases]

### Constraints
- [ ] Must work on both phone and laptop
- [ ] Must not break [specific existing feature]
- [ ] Must follow existing patterns for [touch handling / SVG overlay / etc.]

### What NOT to Change
- [List files or patterns that should not be touched]

### Edge Cases
- [What happens when X is empty?]
- [What happens on slow connection?]

### Acceptance Criteria
- [ ] [Observable result 1]
- [ ] [Observable result 2]
- [ ] [Build passes: `npm run build`]

### Test Notes
[How to verify this works — what to tap, what to look for, what devices to test on]

---

## Builder Rules (always apply)
1. Read CLAUDE.md before starting any work
2. Do not broaden scope — implement exactly what's specified
3. Do not refactor unrelated code
4. Do not change architecture unless the task explicitly requires it
5. Preserve existing working behaviour
6. Flag uncertainty instead of guessing — ask rather than assume
7. Keep edits surgical — prefer minimal diffs
8. Explain any risky change before making it
9. Test build passes before considering task complete
10. Commit only when explicitly asked
