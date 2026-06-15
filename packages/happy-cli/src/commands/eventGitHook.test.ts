import { describe, it, expect } from 'vitest'
import { renderPostCommitHook } from './eventGitHook'

describe('renderPostCommitHook', () => {
  const repoRoot = '/tmp/x'
  const statePath = '/home/u/.happy/daemon.state.json'
  const script = renderPostCommitHook({ repoRoot, statePath })

  it('reads the control port from the daemon.state.json path', () => {
    expect(script).toContain(statePath)
    // The script must extract the httpPort field from that state file
    expect(script).toContain('httpPort')
  })

  it('targets the control server trigger-event endpoint on localhost', () => {
    expect(script).toContain('/trigger-event')
    expect(script).toContain('127.0.0.1')
  })

  it('sets matchKey to the embedded repoRoot', () => {
    expect(script).toContain(`\\"matchKey\\":\\"${repoRoot}\\"`)
  })

  it('uses the commit sha as the idempotencyKey', () => {
    // sha is captured at runtime via git rev-parse HEAD
    expect(script).toContain('rev-parse HEAD')
    // idempotencyKey references the escaped sha shell var inside the payload
    expect(script).toContain('\\"idempotencyKey\\":\\"$sha_e\\"')
  })

  it('emits the git.commit eventType', () => {
    expect(script).toContain('"eventType\\":\\"git.commit\\"')
  })

  it('never fails the commit (contains || true and exit 0)', () => {
    expect(script).toContain('|| true')
    expect(script).toContain('exit 0')
  })

  // SEC-1: the close/reopen single-quote trick is the shell-injection vector.
  it('does NOT build the JSON body via the close/reopen single-quote trick', () => {
    // Old pattern: ...'"$message"'... / ...'"$branch"'... / ...'"$sha"'...
    expect(script).not.toMatch(/'"\$message"'/)
    expect(script).not.toMatch(/'"\$branch"'/)
    expect(script).not.toMatch(/'"\$sha"'/)
  })

  it('defines a json_escape helper and escapes each runtime value', () => {
    expect(script).toContain('json_escape()')
    expect(script).toContain('sha_e=$(json_escape "$sha")')
    expect(script).toContain('branch_e=$(json_escape "$branch")')
    expect(script).toContain('msg_e=$(json_escape "$message")')
  })

  it('builds the payload in a double-quoted shell var and curls it double-quoted', () => {
    expect(script).toContain('payload="{')
    expect(script).toContain('-d "$payload"')
  })

  it('escapes backslash before double-quote in json_escape (order matters)', () => {
    const idxBackslash = script.indexOf("s/\\\\/\\\\\\\\/g")
    const idxQuote = script.indexOf('s/"/\\\\"/g')
    expect(idxBackslash).toBeGreaterThanOrEqual(0)
    expect(idxQuote).toBeGreaterThanOrEqual(0)
    expect(idxBackslash).toBeLessThan(idxQuote)
  })

  // SEC-2: repoRoot is embedded at render time; a single quote in the path must
  // not break any single-quoted shell region, and must be JSON-escaped.
  it('handles a repoRoot containing a single quote without breaking shell quoting', () => {
    const trickyRoot = "/home/u/my'repo"
    const trickyScript = renderPostCommitHook({ repoRoot: trickyRoot, statePath })
    // The repoRoot is embedded inside the double-quoted payload as the matchKey,
    // so it lives in a double-quoted context — a bare ' is harmless there.
    expect(trickyScript).toContain("my'repo")
    // It must not have introduced the old single-quoted -d body that the raw '
    // would break out of.
    expect(trickyScript).not.toMatch(/-d '\{/)
    expect(trickyScript).toContain('-d "$payload"')
    // The non-tricky structural assertions must still hold.
    expect(trickyScript).toContain('json_escape()')
    expect(trickyScript).toContain('"eventType\\":\\"git.commit\\"')
  })

  it('JSON-escapes a backslash in repoRoot at render time', () => {
    const backslashRoot = 'C:\\Users\\me\\repo'
    const winScript = renderPostCommitHook({ repoRoot: backslashRoot, statePath })
    // Each backslash must be doubled for valid JSON inside the double-quoted payload.
    expect(winScript).toContain('C:\\\\Users\\\\me\\\\repo')
  })
})
