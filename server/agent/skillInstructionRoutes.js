export const SKILL_ROUTE_LIMITS = Object.freeze({ routeCount: 128, keywordCount: 64, keywordLength: 120 });

function instructionError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_AGENT_SKILL_INSTRUCTIONS' });
}

function validateReferences(references, limit = Infinity) {
  if (!Array.isArray(references) || references.length > limit) {
    throw instructionError('SKILL 参考清单必须显式声明文本文件');
  }
  for (const reference of references) {
    if (
      typeof reference !== 'string' || reference.length > 240 ||
      !/^references\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:md|txt)$/.test(reference)
    ) {
      throw instructionError('SKILL 只允许 references/ 内明确声明的 Markdown 或文本参考');
    }
  }
  if (new Set(references.map((reference) => reference.toLowerCase())).size !== references.length) {
    throw instructionError('SKILL 参考清单不能包含重复文件');
  }
  return references;
}

function uniqueReferences(references) {
  const seen = new Set();
  return references.filter((reference) => {
    const key = reference.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Routing is limited to explicit text files and literal keywords. No Markdown
// traversal, regular expressions, expressions, or executable route fields.
export function parseSkillInstructionConfiguration(text, limits = {}) {
  if (text === undefined || text === null) return { instructionReferences: [], instructionRoutes: [] };
  if (Buffer.byteLength(text, 'utf8') > (limits.manifestBytes ?? Infinity)) {
    throw instructionError('SKILL 参考清单超过大小限制');
  }
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw instructionError('SKILL 参考清单不是有效 JSON'); }
  const instructionReferences = validateReferences(manifest?.instructionReferences, limits.referenceCount);
  const instructionRoutes = manifest.instructionRoutes === undefined ? [] : manifest.instructionRoutes;
  if (!Array.isArray(instructionRoutes) || instructionRoutes.length > SKILL_ROUTE_LIMITS.routeCount) {
    throw instructionError('SKILL 指令路由必须是最多 128 项的数组');
  }
  for (const route of instructionRoutes) {
    if (
      !route || typeof route !== 'object' || Array.isArray(route) ||
      Object.keys(route).some((key) => !['keywords', 'references', 'fallback'].includes(key))
    ) {
      throw instructionError('SKILL 指令路由只允许 keywords、references 和 fallback');
    }
    if (
      !Array.isArray(route.keywords) || !route.keywords.length || route.keywords.length > SKILL_ROUTE_LIMITS.keywordCount ||
      route.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim() || keyword.length > SKILL_ROUTE_LIMITS.keywordLength)
    ) {
      throw instructionError('SKILL 路由关键词必须是 1 至 64 个非空字符串，每项不超过 120 字符');
    }
    validateReferences(route.references, limits.referenceCount);
    if (Object.hasOwn(route, 'fallback') && typeof route.fallback !== 'boolean') {
      throw instructionError('SKILL 路由 fallback 必须是布尔值');
    }
  }
  return { instructionReferences, instructionRoutes };
}

// Import validation must check the union, including routes not used by this task.
export function parseSkillInstructionManifest(text, limits) {
  const configuration = parseSkillInstructionConfiguration(text, limits);
  return uniqueReferences([
    ...configuration.instructionReferences,
    ...configuration.instructionRoutes.flatMap((route) => route.references),
  ]);
}

function containsLiteralKeyword(context, keyword) {
  const normalizedKeyword = keyword.normalize('NFKC').toLowerCase().trim();
  if (!/\p{Nd}$/u.test(normalizedKeyword)) return context.includes(normalizedKeyword);
  let matchAt = context.indexOf(normalizedKeyword);
  while (matchAt !== -1) {
    // Numbered references such as 样例1 must not select 样例10. Continue
    // searching in case a later occurrence has a valid boundary.
    if (!/^\p{Nd}/u.test(context.slice(matchAt + normalizedKeyword.length))) return true;
    matchAt = context.indexOf(normalizedKeyword, matchAt + 1);
  }
  return false;
}

export function selectSkillInstructionReferences(configuration, context) {
  const normalizedContext = typeof context === 'string' ? context.normalize('NFKC').toLowerCase() : '';
  const matched = configuration.instructionRoutes.filter((route) => !route.fallback && route.keywords.some((keyword) => (
    containsLiteralKeyword(normalizedContext, keyword)
  )));
  const selectedRoutes = matched.length ? matched : configuration.instructionRoutes.filter((route) => route.fallback);
  return uniqueReferences([
    ...configuration.instructionReferences,
    ...selectedRoutes.flatMap((route) => route.references),
  ]);
}
