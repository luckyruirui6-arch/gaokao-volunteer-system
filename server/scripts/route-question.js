const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config', 'routing-rules.json');
const REPO_ROOT = path.resolve(ROOT, '..');
const MAJOR_DIR = path.join(REPO_ROOT, '04_专业库');
const PROVINCE_DIR = path.join(REPO_ROOT, '02_省份数据');
const SCHOOL_DIR = path.join(REPO_ROOT, '03_院校库');

function loadMajorNames() {
  try {
    return fs.readdirSync(MAJOR_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/i, ''))
      .filter((name) => !/README|索引|总说明/.test(name))
      .sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

function loadProvinceNames() {
  try {
    return fs.readdirSync(PROVINCE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

function loadSchoolNames() {
  const names = [];
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const name = entry.name.replace(/\.md$/i, '');
          if (/README|总表|索引|总说明/.test(name)) continue;
          names.push(name);
        }
      }
    } catch {
      return;
    }
  }
  walk(SCHOOL_DIR);
  return Array.from(new Set(names)).sort((a, b) => b.length - a.length);
}

const MAJOR_NAMES = loadMajorNames();
const PROVINCE_NAMES = loadProvinceNames();
const SCHOOL_NAMES = loadSchoolNames();

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

function scoreRoute(question, route) {
  const q = question.toLowerCase();
  return route.trigger.reduce((sum, keyword) => {
    return sum + (q.includes(keyword.toLowerCase()) ? 1 : 0);
  }, 0);
}

function normalizeSchoolCandidate(text) {
  return String(text || "")
    .replace(/^(你帮我|帮我|请你|请问|你觉得|给我|麻烦你|我想了解|我想问|介绍一下|介绍|说说|聊聊|分析一下|分析|看看|评价一下|评价)+/, "")
    .replace(/^(关于|一下|下|这个|这所)/, "")
    .trim();
}

function extractNamedEntities(question, candidates) {
  const normalized = String(question || "")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）");
  return candidates.filter((candidate) => normalized.includes(candidate));
}

function extractSchoolNames(question) {
  const exactMatches = extractNamedEntities(question, SCHOOL_NAMES);
  if (exactMatches.length) return exactMatches;
  const names = new Set();
  const normalized = String(question || "")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）");
  const matches = normalized.matchAll(/([\u4e00-\u9fa5A-Za-z0-9（）·]{2,30}(?:大学|学院))/g);
  for (const match of matches) {
    const raw = (match[1] || "").trim();
    if (!raw) continue;
    const parts = raw
      .split(/还是|或者|或|和|与|跟|及|、|，|,/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const part of parts) {
      const candidate = normalizeSchoolCandidate(part);
      if (!/(大学|学院)$/.test(candidate)) continue;
      if (candidate.includes("什么大学") || candidate.includes("哪个大学") || candidate.includes("什么学校")) continue;
      names.add(candidate);
    }
  }
  return Array.from(names);
}

function classify(question) {
  const cfg = loadConfig();
  const schoolNames = extractSchoolNames(question);
  const majorNames = extractNamedEntities(question, MAJOR_NAMES);
  const provinceNames = extractNamedEntities(question, PROVINCE_NAMES);
  const policyHint = /(政策|赋分|提前批|专项|特招|公费|定向|军警|志愿规则|调剂|选科)/.test(question);
  const scoreHint = /(多少分|能不能上|能不能报|报不报得上|报得上|稳不稳|冲稳保|录取概率|位次|投档线|分数线|专业组|\d{3,4}分|录取)/.test(question);
  if (scoreHint && (provinceNames.length > 0 || schoolNames.length > 0 || majorNames.length > 0)) {
    const scoreRoute = cfg.routes.find((route) => route.id === 'score_tendency');
    if (scoreRoute) {
      return {
        route: scoreRoute.id,
        reason: `explicit_score_context_detected:${[...provinceNames.slice(0, 2), ...schoolNames.slice(0, 2), ...majorNames.slice(0, 2)].join('|')}`,
        priorityCollections: scoreRoute.priorityCollections,
        fallbackCollections: scoreRoute.fallbackCollections,
        avoidCollections: scoreRoute.avoidCollections
      };
    }
  }
  if (schoolNames.length > 0) {
    const schoolRoute = cfg.routes.find((route) => route.id === 'school_consult');
    if (schoolRoute) {
      return {
        route: schoolRoute.id,
        reason: `explicit_school_name_detected:${schoolNames.join('|')}`,
        priorityCollections: schoolRoute.priorityCollections,
        fallbackCollections: schoolRoute.fallbackCollections,
        avoidCollections: schoolRoute.avoidCollections
      };
    }
  }
  if (provinceNames.length > 0 && policyHint) {
    const policyRoute = cfg.routes.find((route) => route.id === 'policy_consult');
    if (policyRoute) {
      return {
        route: policyRoute.id,
        reason: `explicit_province_policy_detected:${provinceNames.slice(0, 3).join('|')}`,
        priorityCollections: policyRoute.priorityCollections,
        fallbackCollections: policyRoute.fallbackCollections,
        avoidCollections: policyRoute.avoidCollections
      };
    }
  }
  if (provinceNames.length > 0 && scoreHint) {
    const scoreRoute = cfg.routes.find((route) => route.id === 'score_tendency');
    if (scoreRoute) {
      return {
        route: scoreRoute.id,
        reason: `explicit_province_score_detected:${provinceNames.slice(0, 3).join('|')}`,
        priorityCollections: scoreRoute.priorityCollections,
        fallbackCollections: scoreRoute.fallbackCollections,
        avoidCollections: scoreRoute.avoidCollections
      };
    }
  }
  if (majorNames.length > 0) {
    const majorRoute = cfg.routes.find((route) => route.id === 'major_consult');
    if (majorRoute) {
      return {
        route: majorRoute.id,
        reason: `explicit_major_name_detected:${majorNames.slice(0, 3).join('|')}`,
        priorityCollections: majorRoute.priorityCollections,
        fallbackCollections: majorRoute.fallbackCollections,
        avoidCollections: majorRoute.avoidCollections
      };
    }
  }

  const ranked = cfg.routes
    .map((route) => ({
      route,
      score: scoreRoute(question, route)
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score === 0) {
    return {
      route: 'major_consult',
      reason: 'no_keyword_match_default_to_major_consult',
      priorityCollections: ['gaokao_majors', 'gaokao_style_cases'],
      fallbackCollections: ['gaokao_policies_rules', 'gaokao_province_data'],
      avoidCollections: ['gaokao_schools']
    };
  }

  return {
    route: best.route.id,
    reason: `matched_${best.score}_keywords`,
    priorityCollections: best.route.priorityCollections,
    fallbackCollections: best.route.fallbackCollections,
    avoidCollections: best.route.avoidCollections
  };
}

function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('usage: node route-question.js <question>');
    process.exit(1);
  }
  console.log(JSON.stringify(classify(question), null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { classify };
