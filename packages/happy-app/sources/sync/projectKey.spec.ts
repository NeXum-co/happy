import { describe, expect, it } from 'vitest';
import { projectKeyFromPath } from './projectKey';

describe('projectKeyFromPath', () => {
    it('returns the repo name for a path directly under the code root', () => {
        expect(projectKeyFromPath('/home/user/code/alpha', '/home/user')).toBe('alpha');
    });

    it('returns the repo name for a deep path under the code root', () => {
        expect(projectKeyFromPath('/home/user/code/alpha/packages/app', '/home/user')).toBe('alpha');
    });

    it('strips a worktree --suffix from the repo name', () => {
        expect(projectKeyFromPath('/home/user/code/webshop--e02/checkout', '/home/user')).toBe('webshop');
    });

    it('falls back to the last two segments for paths outside the code root', () => {
        expect(projectKeyFromPath('/var/www/beta-api', '/home/user')).toBe('www/beta-api');
    });

    it('falls back to the last two segments when homeDir is unknown', () => {
        expect(projectKeyFromPath('/home/user/code/alpha')).toBe('code/alpha');
    });

    // Session paths are always absolute (QUAL-004) — tilde paths get no
    // special treatment and take the generic fallback.
    it('does not treat tilde-prefixed paths as a code root', () => {
        expect(projectKeyFromPath('~/code/alpha--spike/api', '/home/user')).toBe('alpha--spike/api');
    });
});
