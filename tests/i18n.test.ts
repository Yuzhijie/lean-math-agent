/**
 * Tests for i18n translations
 */
import { describe, it, expect } from 'vitest';
import zhCN from '../lib/i18n/zh-CN';
import enUS from '../lib/i18n/en-US';

describe('i18n translations', () => {
  it('should have matching keys between zh-CN and en-US', () => {
    const zhKeys = getKeys(zhCN);
    const enKeys = getKeys(enUS);

    expect(enKeys.sort()).toEqual(zhKeys.sort());
  });

  it('should have non-empty values in zh-CN', () => {
    const emptyKeys = findEmptyValues(zhCN);
    expect(emptyKeys).toEqual([]);
  });

  it('should have non-empty values in en-US', () => {
    const emptyKeys = findEmptyValues(enUS);
    expect(emptyKeys).toEqual([]);
  });

  it('should have correct common keys', () => {
    expect(zhCN.common.loading).toBe('加载中...');
    expect(enUS.common.loading).toBe('Loading...');
    expect(zhCN.common.error).toBe('错误');
    expect(enUS.common.error).toBe('Error');
  });

  it('should have correct auth keys', () => {
    expect(zhCN.auth.signIn).toBe('登录');
    expect(enUS.auth.signIn).toBe('Sign In');
  });

  it('should have correct proof keys', () => {
    expect(zhCN.proof.verified).toBe('已验证');
    expect(enUS.proof.verified).toBe('Verified');
  });
});

function getKeys(obj: Record<string, any>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) {
      keys.push(...getKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function findEmptyValues(obj: Record<string, any>, prefix = ''): string[] {
  const empty: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) {
      empty.push(...findEmptyValues(value, fullKey));
    } else if (value === '' || value === null || value === undefined) {
      empty.push(fullKey);
    }
  }
  return empty;
}
