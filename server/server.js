const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { classify } = require("./scripts/route-question");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "backend-config.json");
const HOST = "0.0.0.0";
const PORT = process.env.PORT || 3011;
const REPO_ROOT = path.resolve(ROOT, "..");
const POLICY_DIR = path.join(REPO_ROOT, "01_政策规则");
const MAJOR_DIR = path.join(REPO_ROOT, "04_专业库");
const PROVINCE_DIR = path.join(REPO_ROOT, "02_省份数据");
const SCHOOL_DIR = path.join(REPO_ROOT, "03_院校库");
const STYLE_DIR = path.join(REPO_ROOT, "05_张雪峰风格库");

const defaultConfig = {
  provider: "openai-compatible",
  baseUrl: process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  workspaceSlug: process.env.LLM_MODEL || "qwen-plus",
  apiKey: process.env.API_KEY || "[REDACTED]",
  maxConcurrency: 5,
  queueStepMs: 2400,
  queueVisualSeconds: 12,
  qdrantUrl: process.env.QDRANT_URL || "",
  qdrantApiKey: process.env.QDRANT_API_KEY || "",
  embeddingsUrl: process.env.EMBEDDINGS_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-v3",
  topKPerCollection: 3,
  systemPrompt: "你是一个张雪峰风格的高考志愿填报分析助手，不要输出markdown格式的回答，直接输出纯文本。\n回答时优先使用我提供的检索片段。\n如果检索片段不足，可以结合通用经验继续分析，但必须自然说明这部分属于经验判断。\n不允许编造分数、位次、投档线、专业组、就业率、保研率、排名、学科评估。\n如果问题涉及历史录取数据，要提醒用户历史数据仅供参考，最终要以阳光高考、各省教育考试院、学校本科招生网为准。\n回答要像一个懂高考志愿、愿意讲真话的人，先给结论，再讲原因、风险和替代方案。\n回答尽量自然，不要写成表格汇报。\n去除AI感觉，让人感觉他真的在和张雪峰对话。\n回答风格和模板优先参考 05_张雪峰风格库 与 06_案例库，但事实判断必须服从检索到的数据。",
  adEnabled: false,
  adMode: "local-timer",
  adDebugBypass: true,
  adDurationSeconds: 30,
  adRewardQuestions: 5,
  adApiBaseUrl: "",
  adRewardPath: "/reward",
  adVerifyPath: "/verify",
  adAppId: "",
  adSlotId: "",
};

let activeRequests = 0;

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
const STYLE_INDEX = buildIndex(STYLE_DIR, (baseName) => !/README|索引|总说明/.test(baseName));

function readConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...defaultConfig, ...data };
  } catch {
    return { ...defaultConfig };
  }
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
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
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
  if (!config.qdrantUrl) return [];
  
  const endpoint = `${config.qdrantUrl.replace(/\/+$/, "")}/collections/${collection}/points/query`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.qdrantApiKey ? { "api-key": config.qdrantApiKey } : {}),
      },
      body: JSON.stringify({
        query: vector,
        limit,
        with_payload: true,
        with_vector: false,
      }),
    });
  } catch {
    return [];
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

function extractNamedEntities(text, candidates) {
  const normalized = String(text || "")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）");
  return candidates.filter((candidate) => normalized.includes(candidate));
}

function extractSchoolNames(prompt) {
  const exactMatches = extractNamedEntities(prompt, SCHOOL_NAMES);
  if (exactMatches.length) return exactMatches;
  const patterns = [/([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,30}(?:大学|学院))/g];
  const names = new Set();
  for (const pattern of patterns) {
    const matches = prompt.matchAll(pattern);
    for (const match of matches) {
      const raw = (match[1] || "").trim();
      if (!raw) continue;
      const normalizedRaw = raw.replace(/\(/g, "（").replace(/\)/g, "）");
      const parts = normalizedRaw.split(/还是|或者|或|和|与|跟|及|、|，|,/).map((part) => part.trim()).filter(Boolean);
      for (const part of parts) {
        if (!/(大学|学院)$/.test(part)) continue;
        if (part.includes("什么大学") || part.includes("哪个大学") || part.includes("什么学校")) continue;
        names.add(part);
      }
    }
  }
  return Array.from(names);
}

function containsNamedEntity(hit, names) {
  if (!names.length) return false;
  const haystack = `${hit.title}\n${hit.path}\n${hit.summary}`.replace(/\(/g, "（").replace(/\)/g, "）");
  return names.some((name) => haystack.includes(name));
}

function isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames) {
  const text = `${hit.title}\n${hit.path}\n${hit.summary}`.replace(/\(/g, "（").replace(/\)/g, "）");
  if (containsNamedEntity({ title: text, path: "", summary: "" }, schoolNames) || 
      containsNamedEntity({ title: text, path: "", summary: "" }, majorNames) || 
      containsNamedEntity({ title: text, path: "", summary: "" }, provinceNames)) {
    return true;
  }
  if (/(捡漏|低分|冷门|波动|大小年|冲稳保|可搏|保底)/.test(prompt) && /(捡漏|低分|冷门|波动|大小年|冲稳保|可搏|保底|谨慎搏)/.test(text)) {
    return true;
  }
  if (/(普通家庭|没钱|低学费|尽早赚钱|考编|考公|就业)/.test(prompt) && /(普通家庭|低学费|尽早就业|考编|考公|就业)/.test(text)) {
    return true;
  }
  return false;
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

  for (const [name, files] of STYLE_INDEX) {
    for (const file of files) {
      pushDirect("gaokao_style_cases", file, 90);
    }
  }

  return directHits;
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
    if (hit.collection === "gaokao_schools" && containsNamedEntity(hit, schoolNames)) scoreBoost += 5;
    if (hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames)) scoreBoost += 5;
    if ((hit.collection === "gaokao_policies_rules" || hit.collection === "gaokao_province_data") && containsNamedEntity(hit, provinceNames)) scoreBoost += 3;
    if (hit.collection === "gaokao_style_cases") scoreBoost += 0.15;
    return { ...hit, score: hit.score + scoreBoost };
  });

  if (route === "school_consult") {
    if (hasExplicitSchools) {
      const namedSchoolHits = next.filter((hit) => hit.collection === "gaokao_schools" && containsNamedEntity(hit, schoolNames));
      const styleHits = isPlainSchoolIntro ? [] : next.filter((hit) => hit.collection === "gaokao_style_cases" && isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames));
      const majorHits = hasExplicitMajorIntent ? next.filter((hit) => hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames)) : [];
      next = [...namedSchoolHits, ...styleHits, ...majorHits];
      if (!next.length) next = hits.filter((hit) => hit.collection === "gaokao_schools");
    }
  } else if (route === "major_consult") {
    const namedMajorHits = majorNames.length ? next.filter((hit) => hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames)) : next.filter((hit) => hit.collection === "gaokao_majors");
    const styleHits = next.filter((hit) => hit.collection === "gaokao_style_cases" && isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames));
    const schoolHits = /(哪个学校|什么学校|院校|大学推荐|学校推荐|适合哪些学校)/.test(prompt) ? next.filter((hit) => hit.collection === "gaokao_schools" && (schoolNames.length === 0 || containsNamedEntity(hit, schoolNames))) : [];
    next = [...namedMajorHits, ...styleHits, ...schoolHits];
    if (!next.length) next = hits.filter((hit) => hit.collection === "gaokao_majors" || hit.collection === "gaokao_style_cases");
  } else if (route === "policy_consult") {
    const policyHits = next.filter((hit) => hit.collection === "gaokao_policies_rules" && (provinceNames.length === 0 || containsNamedEntity(hit, provinceNames)));
    const provinceHits = next.filter((hit) => hit.collection === "gaokao_province_data" && (provinceNames.length === 0 || containsNamedEntity(hit, provinceNames)));
    const styleHits = next.filter((hit) => hit.collection === "gaokao_style_cases" && isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames));
    next = [...policyHits, ...provinceHits, ...styleHits];
    if (!next.length) next = hits.filter((hit) => hit.collection === "gaokao_policies_rules" || hit.collection === "gaokao_province_data");
  } else if (route === "score_tendency") {
    const provinceHits = next.filter((hit) => hit.collection === "gaokao_province_data" && (provinceNames.length === 0 || containsNamedEntity(hit, provinceNames)));
    const schoolHits = schoolNames.length ? next.filter((hit) => hit.collection === "gaokao_schools" && containsNamedEntity(hit, schoolNames)) : [];
    const majorHits = majorNames.length ? next.filter((hit) => hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames)) : [];
    const styleHits = next.filter((hit) => hit.collection === "gaokao_style_cases" && isLikelyRelevantStyleHit(hit, prompt, schoolNames, majorNames, provinceNames));
    next = [...provinceHits, ...schoolHits, ...majorHits, ...styleHits];
    if (!next.length) next = hits.filter((hit) => ["gaokao_province_data", "gaokao_schools", "gaokao_majors"].includes(hit.collection));
  } else if (route === "family_emotion") {
    const styleHits = next.filter((hit) => hit.collection === "gaokao_style_cases");
    const majorHits = majorNames.length ? next.filter((hit) => hit.collection === "gaokao_majors" && containsNamedEntity(hit, majorNames)) : next.filter((hit) => hit.collection === "gaokao_majors");
    next = [...styleHits, ...majorHits];
  }

  const seen = new Set();
  return next.sort((a, b) => b.score - a.score).filter((hit) => {
    const key = `${hit.collection}::${hit.path || hit.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, hasExplicitSchools ? 8 : 10);
}

async function retrieveContext(prompt, routeResult, config) {
  let all = [...buildDirectHits(prompt, routeResult)];
  
  if (config.qdrantUrl && config.embeddingsUrl) {
    try {
      const vector = await createEmbedding(prompt, config);
      const collections = [...(routeResult.priorityCollections || []), ...(routeResult.fallbackCollections || [])];
      const schoolNames = extractSchoolNames(prompt);
      const majorNames = extractNamedEntities(prompt, MAJOR_NAMES);
      const provinceNames = extractNamedEntities(prompt, PROVINCE_NAMES);

      for (const collection of collections) {
        let limit = config.topKPerCollection;
        if (routeResult.route === "school_consult" && collection === "gaokao_schools" && schoolNames.length) {
          limit = Math.max(config.topKPerCollection * 12, 30);
        } else if (routeResult.route === "major_consult" && collection === "gaokao_majors" && majorNames.length) {
          limit = Math.max(config.topKPerCollection * 12, 30);
        } else if ((routeResult.route === "policy_consult" || routeResult.route === "score_tendency") && provinceNames.length && ["gaokao_policies_rules", "gaokao_province_data"].includes(collection)) {
          limit = Math.max(config.topKPerCollection * 12, 30);
        }
        const hits = await queryCollection(collection, vector, limit, config);
        hits.map((hit) => normalizeHit(collection, hit)).forEach((hit) => all.push(hit));
      }
    } catch (error) {
      console.error("Vector retrieval failed, using direct hits only:", error.message);
    }
  }
  
  return rerankAndDenoiseHits(all, routeResult, extractSchoolNames(prompt), prompt);
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

async function answerQuestion(prompt, config) {
  const routeResult = classify(prompt);
  const hits = await retrieveContext(prompt, routeResult, config);
  const answer = await callOpenAICompatible(prompt, routeResult, hits, config);

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
  console.log(`高考志愿咨询系统已启动: http://127.0.0.1:${PORT}`);
  console.log(`局域网访问地址: http://<你的局域网IP>:${PORT}`);
  const config = readConfig();
  console.log(`LLM: ${config.baseUrl}`);
  console.log(`Qdrant: ${config.qdrantUrl || "未配置"}`);
});
