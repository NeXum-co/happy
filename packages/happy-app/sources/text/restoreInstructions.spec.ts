import { describe, expect, it } from 'vitest';
import { en as defaultTranslations } from './_default';
import { en } from './translations/en';
import { ca } from './translations/ca';
import { es } from './translations/es';
import { it as itTranslations } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

const bundles: Record<string, { connect: { restoreInstructions?: unknown; qrLinkInstructions?: unknown; restoreWithSecretKey?: unknown } }> = {
    _default: defaultTranslations,
    en,
    ca,
    es,
    it: itTranslations,
    ja,
    pl,
    pt,
    ru,
    'zh-Hans': zhHans,
    'zh-Hant': zhHant,
};

describe('connect.restoreInstructions completeness', () => {
    for (const [name, bundle] of Object.entries(bundles)) {
        it(`${name} has a non-empty connect.restoreInstructions`, () => {
            const value = bundle.connect.restoreInstructions;
            expect(typeof value).toBe('string');
            expect((value as string).trim().length).toBeGreaterThan(0);
        });
    }
});

describe('connect.qrLinkInstructions completeness', () => {
    for (const [name, bundle] of Object.entries(bundles)) {
        it(`${name} has a non-empty connect.qrLinkInstructions`, () => {
            const value = bundle.connect.qrLinkInstructions;
            expect(typeof value).toBe('string');
            expect((value as string).trim().length).toBeGreaterThan(0);
        });
    }
});

describe('connect.restoreWithSecretKey completeness', () => {
    for (const [name, bundle] of Object.entries(bundles)) {
        it(`${name} has a non-empty connect.restoreWithSecretKey`, () => {
            const value = bundle.connect.restoreWithSecretKey;
            expect(typeof value).toBe('string');
            expect((value as string).trim().length).toBeGreaterThan(0);
        });
    }
});
