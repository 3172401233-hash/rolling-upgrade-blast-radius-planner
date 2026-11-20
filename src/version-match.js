/**
 * 轻量版本匹配器，避免引入外部 semver 依赖。
 * 支持的模式：
 *   "*"                 任意版本
 *   "1.2.3"             精确匹配
 *   "1.2.x" / "1.*"     前缀通配
 *   "^1.2.0"            同主版本且 >= 基线（主版本为 0 时要求同次版本）
 *   "~1.2.0"            同主次版本且 >= 基线
 *   ">=1.0 <2.0"        空格分隔的比较器组合（> >= < <= =）
 */
export function parseVersion(input) {
  const text = String(input).trim().replace(/^v/, '');
  const match = text.match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const toNum = (part) => (part === undefined || part === 'x' || part === '*' ? null : Number(part));
  return [Number(match[1]), toNum(match[2]), toNum(match[3])];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function matchesWildcard(version, patternParts) {
  for (let i = 0; i < 3; i += 1) {
    if (patternParts[i] === null) return true;
    if (patternParts[i] !== version[i]) return false;
  }
  return true;
}

function matchesComparator(version, token) {
  const match = token.match(/^(>=|<=|>|<|=)?(.+)$/);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const target = parseVersion(match[2]);
  if (!target) return false;
  if (operator === '=' && target.includes(null)) {
    return matchesWildcard(version, target);
  }
  const cmp = compareVersions(version, target);
  switch (operator) {
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '=': return cmp === 0;
    default: return false;
  }
}

export function matchesVersion(version, pattern) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const text = String(pattern).trim();
  if (text === '' || text === '*') return true;

  if (text.startsWith('^')) {
    const base = parseVersion(text.slice(1));
    if (!base) return false;
    if (compareVersions(parsed, base) < 0) return false;
    if (base[0] > 0) return parsed[0] === base[0];
    return parsed[0] === 0 && parsed[1] === base[1];
  }
  if (text.startsWith('~')) {
    const base = parseVersion(text.slice(1));
    if (!base) return false;
    return compareVersions(parsed, base) >= 0
      && parsed[0] === base[0]
      && parsed[1] === base[1];
  }
  if (/^(>=|<=|>|<|=)/.test(text) || text.includes(' ')) {
    return text.split(/\s+/).every((token) => matchesComparator(parsed, token));
  }
  const target = parseVersion(text);
  if (!target) return false;
  if (target.includes(null)) return matchesWildcard(parsed, target);
  return compareVersions(parsed, target) === 0;
}

export function matchesAnyPattern(version, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((pattern) => matchesVersion(version, pattern));
}
