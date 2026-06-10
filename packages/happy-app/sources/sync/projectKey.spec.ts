import { describe, expect, it } from 'vitest';
import { projectKeyFromPath } from './projectKey';

describe('projectKeyFromPath', () => {
    it('returns the repo name for a path directly under ~/code', () => {
        expect(projectKeyFromPath('/home/joshuam/code/nexum', '/home/joshuam')).toBe('nexum');
    });

    it('returns the repo name for a deep path under ~/code', () => {
        expect(projectKeyFromPath('/home/joshuam/code/nexum/packages/app', '/home/joshuam')).toBe('nexum');
    });

    it('strips a worktree --suffix from the repo name', () => {
        expect(projectKeyFromPath('/home/joshuam/code/control-plane--e02/happy', '/home/joshuam')).toBe('control-plane');
    });

    it('falls back to the last two segments for paths outside ~/code', () => {
        expect(projectKeyFromPath('/var/www/proxuma-api', '/home/joshuam')).toBe('www/proxuma-api');
    });

    it('handles tilde-prefixed paths under ~/code', () => {
        expect(projectKeyFromPath('~/code/proxuma--spike/api', '/home/joshuam')).toBe('proxuma');
    });

    it('falls back to the last two segments when homeDir is unknown', () => {
        expect(projectKeyFromPath('/home/joshuam/code/nexum')).toBe('code/nexum');
    });
});
