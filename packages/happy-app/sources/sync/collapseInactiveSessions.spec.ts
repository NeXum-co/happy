import { describe, expect, it } from 'vitest';
import { collapseInactiveSessions } from './collapseInactiveSessions';
import type { SessionListViewItem } from './storage';

type RowData = Extract<SessionListViewItem, { type: 'session' }>['session'];
const row = (id: string, active: boolean): SessionListViewItem =>
    ({ type: 'session', session: { id, active } as unknown as RowData });
const header = (title: string): SessionListViewItem => ({ type: 'header', title });
const group = (displayPath: string, count: number): SessionListViewItem => ({ type: 'project-group', displayPath, count });
const needsYou = (): SessionListViewItem => ({ type: 'needs-you', sessions: [] });

describe('collapseInactiveSessions', () => {
    it('keeps the fleet section (needs-you, project groups, active sessions) verbatim', () => {
        const data = [needsYou(), group('alpha', 1), row('a', true)];
        expect(collapseInactiveSessions(data, true)).toEqual(data);
    });

    it('emits no archive-toggle when there are no inactive sessions', () => {
        const result = collapseInactiveSessions([row('a', true)], false);
        expect(result.some(i => i.type === 'archive-toggle')).toBe(false);
    });

    it('collapses inactive sessions into one archive-toggle carrying the count and hidden flag', () => {
        const data = [row('a', true), header('Today'), row('b', false), row('c', false)];
        const result = collapseInactiveSessions(data, true);
        expect(result).toEqual([
            row('a', true),
            { type: 'archive-toggle', hidden: true, count: 2 },
        ]);
    });

    it('appends the day headers and inactive sessions when expanded', () => {
        const data = [row('a', true), header('Today'), row('b', false), header('Yesterday'), row('c', false)];
        const result = collapseInactiveSessions(data, false);
        expect(result).toEqual([
            row('a', true),
            { type: 'archive-toggle', hidden: false, count: 2 },
            header('Today'),
            row('b', false),
            header('Yesterday'),
            row('c', false),
        ]);
    });

    it('drops day headers entirely when collapsed (no empty Today/Yesterday rows)', () => {
        const data = [header('Today'), row('b', false)];
        const result = collapseInactiveSessions(data, true);
        expect(result.some(i => i.type === 'header')).toBe(false);
    });
});
