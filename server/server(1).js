const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { classify } = require("../14_qdrant/scripts/route-question");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "backend-config.json");
const HOST = "0.0.0.0";
const PORT = 3011;
const REPO_ROOT = path.resolve(ROOT, "..");
const POLICY_DIR = path.join(REPO_ROOT, "01_政策规则");
const MAJOR_DIR = path.join(REPO_ROOT, "04_专业库");
const PROVINCE_DIR = path.join(REPO_ROOT, "02_省份数据");
const SCHOOL_DIR = path.join(REPO_ROOT, "03_院校库");
const SCORE_DB_PATH = path.join(REPO_ROOT, "07_录取数据", "gaokao_2025.db");
const SCORE_DB_MODULE_PATH = path.join(REPO_ROOT, "07_录取数据", "node_modules", "better-sqlite3");

const defaultConfig = {
  provider: "openai-compatible",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  workspaceSlug: "z-ai/glm5",
  apiKey: "[REDACTED]",
  maxConcurrency: 5,
  queueStepMs: 2400,
  queueVisualSeconds: 12,
  qdrantUrl: "http://127.0.0.1:6333",
  embeddingsUrl: "http://127.0.0.1:1234/v1/embeddings",
  embeddingModel: "text-embedding-qwen3-embedding-4b",
  topKPerCollection: 3,
  systemPrompt: "你是一个高考志愿填报分析助手。\n回答时优先使用我提供的检索片段。\n如果检索片段不足，可以结合通用经验继续分析，但必须自然说明这部分属于经验判断，不是当前知识库里的精确数据。\n不允许编造分数、位次、投档线、专业组、就业率、保研率、排名、学科评估。\n如果问题涉及历史录取数据，要提醒用户历史数据仅供参考，最终要以阳光高考、各省教育考试院、学校本科招生网为准。\n回答必须带有张雪峰式分析逻辑：先给结论，直接说现实，再讲原因、风险、代价和替代方案。\n说话要像一个见过很多案例、愿意讲真话的老师，不要写成表格汇报，不要官话，不要空话。\n回答风格和模板优先参考 05_张雪峰风格库 与 06_案例库，但事实判断必须服从检索到的数据。",
  adEnabled: true,
  adMode: "local-timer",
  adDebugBypass: false,
  adDurationSeconds: 30,
  adRewardQuestions: 5,
  adApiBaseUrl: "",
  adRewardPath: "/reward",
  adVerifyPath: "/verify",
  adAppId: "",
  adSlotId: "",
};

let activeRequests = 0;
let scoreDb = null;
let scoreDbInitError = null;

function getScoreDb() {
  if (scoreDb) return scoreDb;
  if (scoreDbInitError) return null;
  try {
    if (!fs.existsSync(SCORE_DB_PATH)) throw new Error("score_db_missing");
    const Database = require(SCORE_DB_MODULE_PATH);
    scoreDb = new Database(SCORE_DB_PATH, { readonly: true, fileMustExist: true });
    return scoreDb;
  } catch (error) {
    scoreDbInitError = error;
    return null;
  }
}

function loadMajorNames() {
  try {
    return fs.readdirSync(MAJOR_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/i, ""))
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

const MAJOR_NAMES = loadMajorNames();
const PROVINCE_NAMES = loadProvinceNames();

function walkMarkdownFiles(dir, result = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkMarkdownFiles(full, result);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push(full);
      }
    }
  } catch {
    return result;
  }
  return result;
}

function buildIndex(dir, filterFn = () => true) {
  const index = new Map();
  for (const filePath of walkMarkdownFiles(dir)) {
    const baseName = path.basename(filePath, ".md");
    if (!filterFn(baseName, filePath)) continue;
    if (!index.has(baseName)) index.set(baseName, []);
    index.get(baseName).push(filePath);
  }
  return index;
}

function buildProvinceIndex() {
  const index = new Map();
  for (const province of PROVINCE_NAMES) {
    const files = [];
    const policyPath = path.join(POLICY_DIR, `${province}_2026_普通高考政策框架.md`);
    const dataPath = path.join(PROVINCE_DIR, province, `${province}_录取数据总览.md`);
    if (fs.existsSync(policyPath)) files.push(policyPath);
    if (fs.existsSync(dataPath)) files.push(dataPath);
    if (files.length) index.set(province, files);
  }
  return index;
}

function readDocSnippet(filePath, maxLength = 1600) {
  try {
    let text = fs.readFileSync(filePath, "utf8");
    text = text.replace(/^---[\s\S]*?---\s*/m, "");
    text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");
    text = text.replace(/\r/g, "");
    text = text.trim();
    return text.slice(0, maxLength);
  } catch {
    return "";
  }
}

const SCHOOL_INDEX = buildIndex(SCHOOL_DIR, (baseName, filePath) => {
  return !/README|总表|索引|总说明/.test(baseName) && !/全国[\\/]/.test(filePath);
});
const SCHOOL_NAMES = Array.from(SCHOOL_INDEX.keys()).sort((a, b) => b.length - a.length);
const MAJOR_INDEX = buildIndex(MAJOR_DIR, (baseName) => !/README|索引|总说明/.test(baseName));
const PROVINCE_FILE_INDEX = buildProvinceIndex();

function readConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...defaultConfig, ...data };
  } catch {
    return { ...defaultConfig };
  }
}

function escapeLike(text) {
  return String(text || "").replace(/[\\%_]/g, "\\$&");
}

function parseFirstNumber(prompt) {
  const matches = String(prompt || "").match(/(?<!\d)(\d{3})(?!\d)|(?<!\d)(\d{4})(?!\d)/g);
  if (!matches) return null;
  const values = matches.map((item) => Number(item)).filter((n) => Number.isFinite(n) && n >= 100 && n <= 900);
  return values.length ? values[0] : null;
}

function parseRank(prompt) {
  const match = String(prompt || "").match(/(?:位次|排名|名次)\s*(?:是|大概|约|在)?\s*(\d{1,7})/);
  return match ? Number(match[1]) : null;
}

function getSubjectHints(prompt, major = "") {
  const text = String(prompt || "");
  if (/(物化|物理|理科|理工|工科|物化生|物生地|物地生)/.test(text)) {
    return ["物理类", "理科", "综合改革", "综合"];
  }
  if (/(历史|文科|史地政|政史地|文史)/.test(text)) {
    return ["历史类", "文科", "综合改革", "综合"];
  }
  const majorText = String(major || "");
  if (/(工程|计算机|软件|电子|通信|电气|自动化|人工智能|数据|网络安全|医学|临床|口腔|护理|药学|数学|物理|化学|生物|机械|材料|土木|建筑|集成电路|信息)/.test(majorText)) {
    return ["物理类", "理科", "综合改革", "综合"];
  }
  if (/(新闻|传播|法学|会计|金融|经济|教育|汉语言|外语|历史|哲学|社会学|政治|广告|新媒体)/.test(majorText)) {
    return ["历史类", "文科", "综合改革", "综合"];
  }
  return [];
}

function subjectFilterClause(subjectHints, columnName = "subject") {
  if (!subjectHints.length) return { clause: "", params: [] };
  return {
    clause: ` AND ${columnName} IN (${subjectHints.map(() => "?").join(",")})`,
    params: subjectHints,
  };
}

function pickRepresentativeRow(rows) {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => {
    if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
    const aIsBen = /本科|常规批/.test(a.batch || "") ? 0 : 1;
    const bIsBen = /本科|常规批/.test(b.batch || "") ? 0 : 1;
    if (aIsBen !== bIsBen) return aIsBen - bIsBen;
    const aRank = Number.isFinite(a.min_rank) ? a.min_rank : Number.MAX_SAFE_INTEGER;
    const bRank = Number.isFinite(b.min_rank) ? b.min_rank : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    const aScore = Number.isFinite(a.min_score) ? a.min_score : -1;
    const bScore = Number.isFinite(b.min_score) ? b.min_score : -1;
    return bScore - aScore;
  })[0];
}

function inferScoreBand(userScore, targetScore) {
  if (!Number.isFinite(userScore) || !Number.isFinite(targetScore)) return null;
  const gap = userScore - targetScore;
  if (gap >= 20) return { label: "偏稳", gap };
  if (gap >= 10) return { label: "可稳", gap };
  if (gap >= 3) return { label: "可搏", gap };
  if (gap >= -8) return { label: "冲", gap };
  return { label: "高风险", gap };
}

function inferRankBand(userRank, targetRank) {
  if (!Number.isFinite(userRank) || !Number.isFinite(targetRank) || userRank <= 0 || targetRank <= 0) return null;
  const gap = targetRank - userRank;
  if (gap >= 5000) return { label: "偏稳", gap };
  if (gap >= 1500) return { label: "可稳", gap };
  if (gap >= 0) return { label: "可搏", gap };
  if (gap >= -3000) return { label: "冲", gap };
  return { label: "高风险", gap };
}

function queryProvinceLines(db, province, subjectHints = []) {
  if (!province) return [];
  const subjectSql = subjectFilterClause(subjectHints);
  const sql = `
    SELECT province, year, batch, subject, score_line, source
    FROM province_lines
    WHERE province = ?
      ${subjectSql.clause}
    ORDER BY year DESC,
      CASE
        WHEN batch LIKE '%本科%' THEN 0
        WHEN batch LIKE '%特殊类型%' THEN 1
        ELSE 9
      END
  `;
  return db.prepare(sql).all(province, ...subjectSql.params);
}

function pickProvinceLine(lines, representative = null) {
  if (!lines.length) return null;
  if (representative) {
    const matched = lines.find((row) => (row.batch || "") === (representative.batch || "") && (!representative.subject || !row.subject || row.subject === representative.subject));
    if (matched) return matched;
  }
  return [...lines].sort((a, b) => {
    const weight = (row) => {
      const batch = row.batch || "";
      if (/本科批$/.test(batch) || /本科一批/.test(batch) || /普通类一段/.test(batch)) return 0;
      if (/本科/.test(batch)) return 1;
      if (/特殊类型/.test(batch)) return 2;
      return 9;
    };
    return weight(a) - weight(b);
  })[0];
}

function querySchoolScores(db, province, school, subjectHints = []) {
  if (!province || !school) return [];
  const subjectSql = subjectFilterClause(subjectHints);
  const sql = `
    SELECT school, province, year, batch, subject, min_score, min_rank, plan_count, score_line, source, note
    FROM school_scores
    WHERE province = ?
      AND school = ?
      AND batch NOT LIKE '%专科%'
      ${subjectSql.clause}
    ORDER BY year DESC,
      CASE WHEN batch LIKE '%本科%' OR batch LIKE '%常规批%' THEN 0 ELSE 9 END,
      min_rank ASC,
      min_score DESC
    LIMIT 8
  `;
  return db.prepare(sql).all(province, school, ...subjectSql.params);
}

function queryMajorScores(db, province, school, major, subjectHints = []) {
  if (!province || !major) return [];
  const subjectSql = subjectFilterClause(subjectHints);
  const majorLike = `%${escapeLike(major)}%`;
  let sql = `
    SELECT school, province, year, batch, subject, major_group, major, min_score, min_rank, plan_count, source, note
    FROM major_scores
    WHERE province = ?
      AND major LIKE ? ESCAPE '\\'
      AND batch NOT LIKE '%专科%'
      ${subjectSql.clause}
  `;
  const params = [province, majorLike, ...subjectSql.params];
  if (school) {
    sql += ` AND school = ?`;
    params.push(school);
  }
  sql += `
    ORDER BY year DESC,
      CASE WHEN batch LIKE '%本科%' OR batch LIKE '%常规批%' THEN 0 ELSE 9 END,
      min_rank ASC,
      min_score DESC
    LIMIT 12
  `;
  return db.prepare(sql).all(...params);
}

function buildScoreInference(prompt, routeResult) {
  if (routeResult.route !== "score_tendency" && !/(多少分|位次|录取|能不能上|能不能报|稳不稳|冲稳保)/.test(String(prompt || ""))) {
    return { context: "", hits: [], meta: null };
  }

  const db = getScoreDb();
  if (!db) {
    return {
      context: "07_录取数据 当前不可用，本轮先按知识库文档和通用经验做分析。",
      hits: [],
      meta: { dbUnavailable: true },
    };
  }

  const province = extractNamedEntities(prompt, PROVINCE_NAMES)[0] || "";
  const school = extractSchoolNames(prompt)[0] || "";
  const major = extractNamedEntities(prompt, MAJOR_NAMES)[0] || "";
  const score = parseFirstNumber(prompt);
  const rank = parseRank(prompt);
  const subjectHints = getSubjectHints(prompt, major);
  const lines = queryProvinceLines(db, province, subjectHints);
  const schoolRows = school ? querySchoolScores(db, province, school, subjectHints) : [];
  const majorRows = major ? queryMajorScores(db, province, school, major, subjectHints) : [];
  const representative = pickRepresentativeRow(majorRows.length ? majorRows : schoolRows);
  const lineRow = pickProvinceLine(lines, representative);

  if (!province && !school && !major) {
    return { context: "", hits: [], meta: null };
  }

  const scoreBand = representative && Number.isFinite(score) ? inferScoreBand(score, representative.min_score) : null;
  const rankBand = representative && Number.isFinite(rank) ? inferRankBand(rank, representative.min_rank) : null;
  const tendency = rankBand?.label || scoreBand?.label || "";
  const linesText = [];
  linesText.push(`07数据库命中情况：${province || "未识别省份"}${school ? `，学校 ${school}` : ""}${major ? `，专业 ${major}` : ""}。`);
  if (lineRow) {
    linesText.push(`省控线参考：${lineRow.year} 年 ${lineRow.province}${lineRow.batch}${lineRow.subject ? `（${lineRow.subject}）` : ""} 控制线约 ${lineRow.score_line} 分。`);
  }
  if (representative) {
    linesText.push(`历史录取参考：${representative.year} 年${representative.province}${representative.school}${representative.major ? ` ${representative.major}` : ""}${representative.batch ? ` ${representative.batch}` : ""}${representative.subject ? ` ${representative.subject}` : ""}，最低分约 ${representative.min_score ?? "待补"}，最低位次约 ${representative.min_rank ?? "待补"}。`);
  }
  if (Number.isFinite(rank) && representative && Number.isFinite(representative.min_rank)) {
    linesText.push(`当前用户给了位次，这一轮优先按位次判断；按历史最低位次对比，目前更像“${rankBand?.label || "待判断"}”区间。`);
  } else if (Number.isFinite(score) && representative && Number.isFinite(representative.min_score)) {
    linesText.push(`当前用户只给了分数，没有给位次，所以这一轮只能按历史分数做粗判断；按你提供的 ${score} 分和历史最低分对比，目前更像“${scoreBand?.label || "待判断"}”区间。`);
  } else if (Number.isFinite(score) && lineRow && Number.isFinite(lineRow.score_line)) {
    const lineGap = score - lineRow.score_line;
    linesText.push(`如果只看本科控制线，你目前比这条线高约 ${lineGap} 分，这只能说明有本科层面的机会，不等于具体学校和专业一定稳。`);
  }
  if (Number.isFinite(score) && !Number.isFinite(rank)) {
    linesText.push("如果后面你能补充本省位次，这类判断会比只看分数更稳得多。");
  }
  linesText.push("注意：以上都是基于 2024/2025 已入库历史数据做的简单倾向判断，只能看趋势，不能等同于你今年最终录取结果。");

  const hits = [];
  if (lineRow) {
    hits.push({
      collection: "gaokao_score_rules",
      score: 130,
      title: `07_录取数据/${lineRow.province}_控制线_${lineRow.year}`,
      path: `07_录取数据/gaokao_2025.db#province_lines`,
      summary: `${lineRow.province} ${lineRow.year} ${lineRow.batch} ${lineRow.subject} 控制线 ${lineRow.score_line}，来源：${lineRow.source || "待补"}`,
    });
  }
  if (representative) {
    hits.push({
      collection: "gaokao_score_rules",
      score: 129,
      title: `07_录取数据/${representative.school}${representative.major ? `_${representative.major}` : ""}_${representative.province}_${representative.year}`,
      path: `07_录取数据/gaokao_2025.db#${representative.major ? "major_scores" : "school_scores"}`,
      summary: `${representative.province} ${representative.year} ${representative.school}${representative.major ? ` ${representative.major}` : ""}${representative.batch ? ` ${representative.batch}` : ""}${representative.subject ? ` ${representative.subject}` : ""}，最低分 ${representative.min_score ?? "待补"}，最低位次 ${representative.min_rank ?? "待补"}，来源：${representative.source || "待补"}`,
    });
  }

  return {
    context: linesText.join("\n"),
    hits,
    meta: {
      province,
      school,
      major,
      score,
      rank,
      preferRank: true,
      scoreOnlyRoughEstimate: Number.isFinite(score) && !Number.isFinite(rank),
      tendency,
      lineRow,
      representative,
    },
  };
}

function writeConfig(next) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...defaultConfig, ...next }, null, 2), "utf8");
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": map[ext] || "text/plain; charset=utf-8" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function createEmbedding(text, config) {
  let response;
  try {
    response = await fetch(config.embeddingsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: text,
      }),
    });
  } catch (error) {
    throw new Error(`embeddings_unreachable:${config.embeddingsUrl}`);
  }
  if (!response.ok) {
    throw new Error(`embedding_failed_${response.status}`);
  }
  const data = await response.json();
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("embedding_vector_missing");
  return vector;
}

async function queryCollection(collection, vector, limit, config) {
  const endpoint = `${config.qdrantUrl.replace(/\/+$/, "")}/collections/${collection}/points/query`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: vector,
        limit,
        with_payload: true,
        with_vector: false,
      }),
    });
  } catch {
    throw new Error(`qdrant_unreachable:${config.qdrantUrl}`);
  }
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return data?.result?.points || data?.result || [];
}

function normalizeHit(collection, point) {
  const payload = point.payload || {};
  return {
    collection,
    score: point.score || 0,
    title: payload.title || payload.path || payload.source || payload.file || collection,
    path: payload.path || payload.source || "",
    summary: payload.summary || payload.text || payload.chunk || "",
  };
}

function buildDirectHits(prompt, routeResult) {
  const schoolNames = extractSchoolNames(prompt);
  const majorNames = extractNamedEntities(prompt, MAJOR_NAMES);
  const provinceNames = extractNamedEntities(prompt, PROVINCE_NAMES);
  const directHits = [];
  const pushDirect = (collection, filePath, score = 99) => {
    if (!filePath || !fs.existsSync(filePath)) return;
    const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
    directHits.push({
      collection,
      score,
      title: relativePath,
      path: relativePath,
      summary: readDocSnippet(filePath),
    });
  };

  if (routeResult.route === "school_consult") {
    for (const name of schoolNames) {
      const files = SCHOOL_INDEX.get(name) || [];
      for (const file of files) pushDirect("gaokao_schools", file, 120);
    }
  }

  if (routeResult.route === "major_consult" || routeResult.route === "score_tendency" || routeResult.route === "family_emotion") {
    for (const name of majorNames) {
      const files = MAJOR_INDEX.get(name) || [];
      for (const file of files) pushDirect("gaokao_majors", file, 118);
    }
  }

  if (routeResult.route === "policy_consult" || routeResult.route === "score_tendency") {
    for (const province of provinceNames) {
      const files = PROVINCE_FILE_INDEX.get(province) || [];
      for (const file of files) {
        const collection = file.includes(`${path.sep}01_政策规则${path.sep}`) ? "gaokao_policies_rules" : "gaokao_province_data";
        pushDirect(collection, file, 116);
      }
    }
  }

  return directHits;
}

function ensureStyleCollection(routeResult) {
  const priorityCollections = [...(routeResult.priorityCollections || [])];
  const fallbackCollections = [...(routeResult.fallbackCollections || [])];
  if (!priorityCollections.includes("gaokao_style_cases") && !fallbackCollections.includes("gaokao_style_cases")) {
    fallbackCollections.unshift("gaokao_style_cases");
  }
  return {
    ...routeResult,
    priorityCollections,
    fallbackCollections,
  };
}

function normalizeSchoolCandidate(text) {
  return String(text || "")
    .replace(/^(你帮我|帮我|请你|请问|你觉得|给我|麻烦你|我想了解|我想问|介绍一下|介绍|说说|聊聊|分析一下|分析|看看|评价一下|评价)+/, "")
    .replace(/^(关于|一下|下|这个|这所)/, "")
    .trim();
}

function extractNamedEntities(text, candidates) {
  const normalized = String(text || "")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）");
  return candidates.filter((candidate) => normalized.includes(candidate));
}

function extractSchoolNames(prompt) {
  const exactMatches = extractNamedEntities(prompt, SCHOOL_NAMES);
  if (exactMatches.length) return exactMatches;
  const patterns = [
    /([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,30}(?:大学|学院))/g,
  ];
  const names = new Set();
  for (const pattern of patterns) {
    const matches = prompt.matchAll(pattern);
    for (const match of matches) {
      const raw = (match[1] || "").trim();
      if (!raw) continue;
      const normalizedRaw = raw.replace(/\(/g, "（").replace(/\)/g, "）");
      const parts = normalizedRaw
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
  }
  return Array.from(names);
}

function containsNamedSchool(hit, schoolNames) {
  if (!schoolNames.length) return false;
  const haystack = `${hit.title}\n${hit.path}\n${hit.summary}`.replace(/\(/g, "（").replace(/\)/g, "）");
  return schoolNames.some((name) => haystack.includes(name));
}

function containsNamedEntity(hit, names) {
  if (!names.length) return false;
  const haystack = `${hit.title}\n${hit.path}\n${hit.summary}`.replace(/\(/g, "（").replace(/\)/g, "）");
  return names.some((name) => haystack.includes(name));
}

function isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames) {
  const text = `${hit.title}\n${hit.path}\n${hit.summary}`.replace(/\(/g, "（").replace(/\)/g, "）");
  if (containsNamedEntity(hit, schoolNames) || containsNamedEntity(hit, majorNames) || containsNamedEntity(hit, provinceNames)) {
    return true;
  }
  if (provinceNames.includes("北京") && /北京/.test(text)) return true;
  if (/(捡漏|低分|冷门|波动|大小年|冲稳保|可搏|保底)/.test(prompt) && /(捡漏|低分|冷门|波动|大小年|冲稳保|可搏|保底|谨慎搏)/.test(text)) {
    return true;
  }
  if (/(名字|名气|听起来|校名)/.test(prompt) && /被名字耽误/.test(text)) {
    return true;
  }
  if (/(普通家庭|没钱|低学费|尽早赚钱|考编|考公|就业)/.test(prompt) && /(普通家庭|低学费|尽早就业|考编|考公|就业)/.test(text)) {
    return true;
  }
  return false;
}

function rerankAndDenoiseHits(hits, routeResult, schoolNames, prompt = "") {
  const majorNames = extractNamedEntities(prompt, MAJOR_NAMES);
  const provinceNames = extractNamedEntities(prompt, PROVINCE_NAMES);
  const route = routeResult.route;
  const hasExplicitSchools = schoolNames.length > 0;
  const hasExplicitMajorIntent = /(专业|学什么|什么方向|什么专业|转专业|就业|前景|值不值得学)/.test(String(prompt || ""));
  const hasScoreIntent = /(多少分|能不能上|稳不稳|冲稳保|录取概率|位次|投档线|分数线|专业组)/.test(String(prompt || ""));
  const hasPolicyIntent = /(政策|赋分|提前批|专项|特招|公费|定向|军警|志愿规则|调剂|选科)/.test(String(prompt || ""));
  const isPlainSchoolIntro = hasExplicitSchools && !hasExplicitMajorIntent && !hasScoreIntent && !hasPolicyIntent;
  let next = hits.map((hit) => {
    let scoreBoost = 0;
    if (hit.collection === "gaokao_schools" && containsNamedSchool(hit, schoolNames)) {
      scoreBoost += 5;
    }
    if (hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames)) {
      scoreBoost += 5;
    }
    if ((hit.collection === "gaokao_policies_rules" || hit.collection === "gaokao_province_data" || hit.collection === "gaokao_score_rules") && containsNamedEntity(hit, provinceNames)) {
      scoreBoost += 3;
    }
    if (hit.collection === "gaokao_style_cases") {
      scoreBoost += 0.15;
    }
    return { ...hit, score: hit.score + scoreBoost };
  });

  if (route === "school_consult") {
    if (hasExplicitSchools) {
      const namedSchoolHits = next.filter((hit) => hit.collection === "gaokao_schools" && containsNamedSchool(hit, schoolNames));
      const styleHits = isPlainSchoolIntro
        ? []
        : next.filter((hit) => hit.collection === "gaokao_style_cases" && isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames));
      const majorHits = hasExplicitMajorIntent
        ? next.filter((hit) => hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames))
        : [];
      next = [...namedSchoolHits, ...styleHits, ...majorHits];
      if (!next.length) {
        next = hits.filter((hit) => hit.collection === "gaokao_schools");
      }
    }
  } else if (route === "major_consult") {
    const namedMajorHits = majorNames.length
      ? next.filter((hit) => hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames))
      : next.filter((hit) => hit.collection === "gaokao_majors");
    const styleHits = next.filter((hit) => hit.collection === "gaokao_style_cases" && isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames));
    const schoolHits = /(哪个学校|什么学校|院校|大学推荐|学校推荐|适合哪些学校)/.test(prompt)
      ? next.filter((hit) => hit.collection === "gaokao_schools" && (schoolNames.length === 0 || containsNamedSchool(hit, schoolNames)))
      : [];
    next = [...namedMajorHits, ...styleHits, ...schoolHits];
    if (!next.length) {
      next = hits.filter((hit) => hit.collection === "gaokao_majors" || hit.collection === "gaokao_style_cases");
    }
  } else if (route === "policy_consult") {
    const policyHits = next.filter((hit) => hit.collection === "gaokao_policies_rules" && (provinceNames.length === 0 || containsNamedEntity(hit, provinceNames)));
    const provinceHits = next.filter((hit) => hit.collection === "gaokao_province_data" && (provinceNames.length === 0 || containsNamedEntity(hit, provinceNames)));
    const styleHits = next.filter((hit) => hit.collection === "gaokao_style_cases" && isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames));
    next = [...policyHits, ...provinceHits, ...styleHits];
    if (!next.length) {
      next = hits.filter((hit) => hit.collection === "gaokao_policies_rules" || hit.collection === "gaokao_province_data");
    }
  } else if (route === "score_tendency") {
    const scoreHits = next.filter((hit) => hit.collection === "gaokao_score_rules" && (provinceNames.length === 0 || containsNamedEntity(hit, provinceNames)));
    const provinceHits = next.filter((hit) => hit.collection === "gaokao_province_data" && (provinceNames.length === 0 || containsNamedEntity(hit, provinceNames)));
    const schoolHits = schoolNames.length
      ? next.filter((hit) => hit.collection === "gaokao_schools" && containsNamedSchool(hit, schoolNames))
      : [];
    const majorHits = majorNames.length
      ? next.filter((hit) => hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames))
      : [];
    const styleHits = next.filter((hit) => hit.collection === "gaokao_style_cases" && isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames));
    next = [...scoreHits, ...provinceHits, ...schoolHits, ...majorHits, ...styleHits];
    if (!next.length) {
      next = hits.filter((hit) => ["gaokao_score_rules", "gaokao_province_data", "gaokao_schools", "gaokao_majors"].includes(hit.collection));
    }
  } else if (route === "family_emotion") {
    const styleHits = next.filter((hit) => hit.collection === "gaokao_style_cases");
    const majorHits = majorNames.length
      ? next.filter((hit) => hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames))
      : next.filter((hit) => hit.collection === "gaokao_majors");
    next = [...styleHits, ...majorHits];
  }

  const seen = new Set();
  return next
    .sort((a, b) => b.score - a.score)
    .filter((hit) => {
      const key = `${hit.collection}::${hit.path || hit.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, hasExplicitSchools ? 8 : 10);
}

async function retrieveContext(prompt, routeResult, config) {
  routeResult = ensureStyleCollection(routeResult);
  const vector = await createEmbedding(prompt, config);
  const collections = [...routeResult.priorityCollections, ...routeResult.fallbackCollections];
  const all = [...buildDirectHits(prompt, routeResult)];
  const schoolNames = extractSchoolNames(prompt);
  const majorNames = extractNamedEntities(prompt, MAJOR_NAMES);
  const provinceNames = extractNamedEntities(prompt, PROVINCE_NAMES);

  for (const collection of collections) {
    let limit = config.topKPerCollection;
    if (routeResult.route === "school_consult" && collection === "gaokao_schools" && schoolNames.length) {
      limit = Math.max(config.topKPerCollection * 12, 30);
    } else if (routeResult.route === "major_consult" && collection === "gaokao_majors" && majorNames.length) {
      limit = Math.max(config.topKPerCollection * 12, 30);
    } else if ((routeResult.route === "policy_consult" || routeResult.route === "score_tendency") && provinceNames.length && ["gaokao_policies_rules", "gaokao_province_data", "gaokao_score_rules"].includes(collection)) {
      limit = Math.max(config.topKPerCollection * 12, 30);
    } else if (routeResult.route === "score_tendency" && collection === "gaokao_schools" && schoolNames.length) {
      limit = Math.max(config.topKPerCollection * 8, 24);
    } else if (routeResult.route === "score_tendency" && collection === "gaokao_majors" && majorNames.length) {
      limit = Math.max(config.topKPerCollection * 8, 24);
    }
    const hits = await queryCollection(collection, vector, limit, config);
    hits.map((hit) => normalizeHit(collection, hit)).forEach((hit) => all.push(hit));
  }
  return rerankAndDenoiseHits(all, routeResult, schoolNames, prompt);
}

function buildSystemPrompt(config) {
  const base = config.systemPrompt || defaultConfig.systemPrompt;
  const hardStyle = [
    "额外硬性要求：",
    "1. 不管什么问题，都必须带有张雪峰式表达框架：先说结论，再说现实，再说风险，再给选择。",
    "2. 不要端着，不要百科腔，不要空泛安慰。",
    "3. 如果数据库里有 05_张雪峰风格库 或 06_案例库 的相关片段，优先吸收它们的表达方式。",
    "4. 风格可以直接，但事实必须贴着数据走；没有数据时要明确提醒用户自行查询官方信息。",
    "5. 涉及录取可能性判断时，位次优先于分数；如果用户只给分数没有位次，要明确提醒：这轮只能粗判断，真正想判断得更准，需要补充位次。"
  ].join("\n");
  return `${base}\n\n${hardStyle}`;
}

function buildUserPrompt(prompt, routeResult, hits, extraContext = "") {
  const context = hits.map((hit, index) => {
    return [
      `来源${index + 1}：${hit.title}`,
      hit.path ? `路径：${hit.path}` : "",
      `内容：${hit.summary}`.trim(),
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    `问题路由：${routeResult.route}`,
    extraContext ? `07数据简要判断：\n${extraContext}` : "",
    "请先基于下面这些检索片段回答：",
    context || "当前没有命中片段。",
    "",
    "用户问题：",
    prompt,
  ].join("\n");
}

async function callOpenAICompatible(prompt, routeResult, hits, config, extraContext = "") {
  let response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.workspaceSlug,
        temperature: 0.45,
        messages: [
          { role: "system", content: buildSystemPrompt(config) },
          { role: "user", content: buildUserPrompt(prompt, routeResult, hits, extraContext) },
        ],
      }),
    });
  } catch {
    throw new Error(`llm_unreachable:${config.baseUrl}`);
  }
  if (!response.ok) {
    throw new Error(`llm_failed_${response.status}`);
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "模型没有返回内容。";
}

async function callAnythingLLM(prompt, routeResult, hits, config, extraContext = "") {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/workspace/${config.workspaceSlug}/chat`;
  const message = `${buildSystemPrompt(config)}\n\n${buildUserPrompt(prompt, routeResult, hits, extraContext)}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ message, mode: "chat" }),
    });
  } catch {
    throw new Error(`anythingllm_unreachable:${config.baseUrl}`);
  }
  if (!response.ok) throw new Error(`anythingllm_failed_${response.status}`);
  const data = await response.json();
  return data?.textResponse || data?.response || data?.message || "模型没有返回内容。";
}

async function callAnthropicCompatible(prompt, routeResult, hits, config, extraContext = "") {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.workspaceSlug,
        max_tokens: 2048,
        temperature: 0.45,
        system: buildSystemPrompt(config),
        messages: [
          {
            role: "user",
            content: buildUserPrompt(prompt, routeResult, hits, extraContext),
          },
        ],
      }),
    });
  } catch {
    throw new Error(`anthropic_unreachable:${config.baseUrl}`);
  }
  if (!response.ok) {
    throw new Error(`anthropic_failed_${response.status}`);
  }
  const data = await response.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((item) => item?.type === "text")
        .map((item) => item?.text || "")
        .join("\n")
        .trim()
    : "";
  return text || "模型没有返回内容。";
}

async function answerQuestion(prompt, config) {
  const routeResult = classify(prompt);
  const scoreInference = buildScoreInference(prompt, routeResult);
  const hits = [
    ...(scoreInference.hits || []),
    ...(await retrieveContext(prompt, routeResult, config)),
  ];
  const answer = config.provider === "anythingllm"
    ? await callAnythingLLM(prompt, routeResult, hits, config, scoreInference.context)
    : config.provider === "anthropic-compatible"
      ? await callAnthropicCompatible(prompt, routeResult, hits, config, scoreInference.context)
      : await callOpenAICompatible(prompt, routeResult, hits, config, scoreInference.context);

  const sources = [];
  const seenSource = new Set();
  for (const hit of hits) {
    const label = hit.title || hit.path || "";
    const key = String(label).replace(/\\/g, "/").toLowerCase();
    if (!key || seenSource.has(key)) continue;
    seenSource.add(key);
    sources.push(label);
  }

  return {
    answer,
    route: routeResult.route,
    sources: sources.slice(0, 6),
    scoreInference: scoreInference.meta,
  };
}

async function handleAdReward(config) {
  if (!config.adEnabled || config.adDebugBypass) {
    return {
      mode: config.adEnabled ? "debug-bypass" : "disabled-bypass",
      granted: config.adRewardQuestions || 5,
    };
  }

  if (config.adMode === "api") {
    if (!config.adApiBaseUrl) throw new Error("ad_api_base_url_missing");
    const endpoint = `${config.adApiBaseUrl.replace(/\/+$/, "")}${config.adRewardPath || "/reward"}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: config.adAppId || "",
        slotId: config.adSlotId || "",
        rewardQuestions: config.adRewardQuestions || 5,
      }),
    });
    if (!response.ok) throw new Error(`ad_api_failed_${response.status}`);
    const data = await response.json().catch(() => ({}));
    return {
      mode: "api",
      granted: Number(data.granted || config.adRewardQuestions || 5),
      providerResponse: data,
    };
  }

  return {
    mode: "local-timer",
    granted: config.adRewardQuestions || 5,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === "/chat" || reqUrl.pathname === "/chat/" || reqUrl.pathname === "/chat.html") {
    return sendFile(res, path.join(ROOT, "chat.html"));
  }

  if (reqUrl.pathname === "/api/config" && req.method === "GET") {
    return json(res, 200, readConfig());
  }

  if (reqUrl.pathname === "/api/config" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { error: "invalid_json" });
    writeConfig(body);
    return json(res, 200, { ok: true, config: readConfig() });
  }

  if (reqUrl.pathname === "/api/status" && req.method === "GET") {
    const config = readConfig();
    return json(res, 200, {
      activeRequests,
      maxConcurrency: config.maxConcurrency,
      queueStepMs: config.queueStepMs,
      queueVisualSeconds: config.queueVisualSeconds,
      provider: config.provider,
      adEnabled: config.adEnabled,
      adMode: config.adMode,
      adRewardQuestions: config.adRewardQuestions,
    });
  }

  if (reqUrl.pathname === "/api/ad/reward" && req.method === "POST") {
    const config = readConfig();
    try {
      const result = await handleAdReward(config);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 500, { error: error.message || "ad_reward_failed" });
    }
  }

  if (reqUrl.pathname === "/api/chat" && req.method === "POST") {
    const config = readConfig();
    if (activeRequests >= config.maxConcurrency) {
      return json(res, 429, {
        error: "concurrency_limit",
        activeRequests,
        maxConcurrency: config.maxConcurrency,
      });
    }

    const body = await readBody(req).catch(() => null);
    if (!body?.prompt) return json(res, 400, { error: "prompt_required" });

    activeRequests += 1;
    try {
      const result = await answerQuestion(String(body.prompt), config);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 500, { error: error.message || "chat_failed" });
    } finally {
      activeRequests = Math.max(0, activeRequests - 1);
    }
  }

  const filePath = reqUrl.pathname === "/"
    ? path.join(ROOT, "index.html")
    : path.join(ROOT, reqUrl.pathname.replace(/^\/+/, ""));
  return sendFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`志愿镜像后端已启动: http://127.0.0.1:${PORT}`);
  console.log(`局域网访问地址: http://<你的局域网IP>:${PORT}`);
});

