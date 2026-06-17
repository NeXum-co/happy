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

    // Outside the code root we key on the FULL normalized path, not the last two
    // segments — otherwise two unrelated repos that share a suffix collapse into
    // one mislabelled group (F3).
    it('keys on the full path for paths outside the code root', () => {
        expect(projectKeyFromPath('/var/www/beta-api', '/home/user')).toBe('/var/www/beta-api');
    });

    it('keys on the full path when homeDir is unknown', () => {
        expect(projectKeyFromPath('/home/user/code/alpha')).toBe('/home/user/code/alpha');
    });

    // F3: two distinct out-of-code projects that share their last two segments
    // must NOT collide into a single project group.
    it('does not collide distinct out-of-code paths that share a suffix', () => {
        const a = projectKeyFromPath('/opt/app/src', '/home/user');
        const b = projectKeyFromPath('/var/app/src', '/home/user');
        expect(a).not.toBe(b);
    });

    // Session paths are always absolute (QUAL-004) — tilde paths get no
    // special treatment and take the generic (full-path) fallback.
    it('does not treat tilde-prefixed paths as a code root', () => {
        expect(projectKeyFromPath('~/code/alpha--spike/api', '/home/user')).toBe('~/code/alpha--spike/api');
    });

    // F3: a missing/empty path must never produce a blank group title.
    it('returns a non-blank fallback for an empty path', () => {
        expect(projectKeyFromPath('')).toBe('—');
        expect(projectKeyFromPath('   ')).toBe('—');
    });
});
