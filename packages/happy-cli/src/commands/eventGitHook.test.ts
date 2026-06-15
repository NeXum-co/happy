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
    expect(script).toContain(`"matchKey":"${repoRoot}"`)
  })

  it('uses the commit sha as the idempotencyKey', () => {
    // sha is captured at runtime via git rev-parse HEAD and referenced as $sha
    expect(script).toContain('rev-parse HEAD')
    expect(script).toContain('"idempotencyKey":"\'"$sha"\'"')
  })

  it('emits the git.commit eventType', () => {
    expect(script).toContain('"eventType":"git.commit"')
  })

  it('never fails the commit (contains || true and exit 0)', () => {
    expect(script).toContain('|| true')
    expect(script).toContain('exit 0')
  })
})
