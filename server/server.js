const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "backend-config.json");
const HOST = "0.0.0.0";
const PORT = process.env.PORT || 3011;

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
  systemPrompt: "你是一个高考志愿填报分析助手，模仿张雪峰的风格回答问题。回答时要先给结论，直接说现实，再讲原因、风险、代价和替代方案。不要空泛安慰，要给出实用的建议。",
  adEnabled: false,
  adMode: "local-timer",
  adDebugBypass: true,
  adDurationSeconds: 30,
  adRewardQuestions: 5,
};

let activeRequests = 0;

function classify(prompt) {
  const text = String(prompt || "").toLowerCase();
  
  if (/(大学|学院|学校)/.test(text) && /(怎么样|好不好|介绍一下|评价|推荐)/.test(text)) {
    return { route: "school_consult", priorityCollections: ["gaokao_schools"], fallbackCollections: [] };
  }
  
  if (/(专业|学什么|前景|就业)/.test(text)) {
    return { route: "major_consult", priorityCollections: ["gaokao_majors"], fallbackCollections: [] };
  }
  
  if (/(政策|规则|志愿|投档|录取|位次|分数)/.test(text)) {
    return { route: "score_tendency", priorityCollections: [], fallbackCollections: [] };
  }
  
  if (/(赋分|选科|提前批|专项|公费|定向)/.test(text)) {
    return { route: "policy_consult", priorityCollections: ["gaokao_policies_rules"], fallbackCollections: [] };
  }
  
  return { route: "general", priorityCollections: [], fallbackCollections: [] };
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
    throw new Error(`embeddings_unreachable:${error.message}`);
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
    title: payload.title || payload.path || collection,
    path: payload.path || "",
    summary: payload.summary || payload.text || payload.chunk || "",
  };
}

async function retrieveContext(prompt, routeResult, config) {
  if (!config.qdrantUrl || !config.embeddingsUrl) {
    return [];
  }
  
  try {
    const vector = await createEmbedding(prompt, config);
    const collections = [...routeResult.priorityCollections, ...routeResult.fallbackCollections].filter(Boolean);
    const all = [];
    
    for (const collection of collections) {
      const hits = await queryCollection(collection, vector, config.topKPerCollection || 3, config);
      hits.map(hit => normalizeHit(collection, hit)).forEach(hit => all.push(hit));
    }
    
    return all.sort((a, b) => b.score - a.score).slice(0, 10);
  } catch (error) {
    console.error("Vector retrieval failed:", error.message);
    return [];
  }
}

async function callLLM(prompt, hits, config) {
  const context = hits.map((hit, index) => {
    return `来源${index + 1}：${hit.title}\n${hit.summary}`.trim();
  }).join("\n\n");

  const systemPrompt = config.systemPrompt || defaultConfig.systemPrompt;
  const userPrompt = hits.length > 0
    ? `请基于以下信息回答用户问题：\n\n${context}\n\n---\n\n用户问题：${prompt}`
    : `用户问题：${prompt}`;

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
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (error) {
    throw new Error(`llm_unreachable:${error.message}`);
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
  const answer = await callLLM(prompt, hits, config);

  const sources = [...new Set(hits.map(hit => hit.title || hit.path).filter(Boolean))].slice(0, 6);

  return {
    answer,
    route: routeResult.route,
    sources,
  };
}

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
      provider: config.provider,
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
  console.log(`小陈志愿咨询器已启动: http://0.0.0.0:${PORT}`);
  console.log(`LLM: ${defaultConfig.baseUrl}`);
});
