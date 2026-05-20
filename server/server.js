const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3011;
const ROOT = __dirname;

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen-plus';
const API_KEY = process.env.API_KEY || '';
const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v3';
const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';

function log(...args) {
  console.log(`[${new Date().toLocaleString()}]`, ...args);
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': map[ext] || 'text/plain; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function callLLM(message) {
  if (!API_KEY) {
    throw new Error('API_KEY not configured');
  }

  const systemPrompt = `你是一位专业的高考志愿填报顾问，风格类似张雪峰。请根据用户的问题，给出专业、详细、有针对性的建议。

用户可能问的问题类型包括：
1. 院校介绍和评价
2. 专业选择建议
3. 志愿填报策略
4. 分数线参考
5. 职业规划建议

请用友好、亲切的语气回答，确保信息准确可靠。先给结论，再讲原因、风险和替代方案。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message }
  ];

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: messages,
      temperature: 0.7,
      max_tokens: 2048
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error: ${response.status} - ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '没有获取到回答';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return json(res, 200, { ok: true });
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === '/') {
    return sendFile(res, path.join(ROOT, 'index.html'));
  }

  if (reqUrl.pathname === '/chat' || reqUrl.pathname === '/chat.html') {
    return sendFile(res, path.join(ROOT, 'chat.html'));
  }

  if (reqUrl.pathname === '/api/config') {
    if (req.method === 'GET') {
      return json(res, 200, {
        provider: 'openai-compatible',
        baseUrl: LLM_BASE_URL,
        workspaceSlug: 'zhiyuan-consultant',
        maxConcurrency: 3,
        queueStepMs: 2400,
        queueVisualSeconds: 12,
        qdrantUrl: QDRANT_URL || 'disabled',
        embeddingsUrl: EMBEDDINGS_URL,
        embeddingModel: EMBEDDING_MODEL,
        topKPerCollection: 3,
        adEnabled: false,
        adMode: 'local-timer',
        adDebugBypass: true,
        adDurationSeconds: 30,
        adRewardQuestions: 5,
      });
    }
    if (req.method === 'POST') {
      return json(res, 200, { config: {} });
    }
  }

  if (reqUrl.pathname === '/api/status') {
    return json(res, 200, {
      activeRequests: 0,
      maxConcurrency: 3,
      queueVisualSeconds: 12,
      queueStepMs: 2400,
    });
  }

  if (reqUrl.pathname === '/api/ad/reward') {
    return json(res, 200, { granted: 5 });
  }

  if (reqUrl.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const prompt = body.prompt || body.message || '';
      
      if (!prompt) {
        return json(res, 400, { error: '缺少问题内容' });
      }

      log(`收到问题: ${prompt.substring(0, 50)}...`);
      const answer = await callLLM(prompt);
      log(`回答完成`);
      
      return json(res, 200, { 
        answer: answer,
        route: 'direct_llm',
        sources: []
      });
    } catch (error) {
      log(`错误: ${error.message}`);
      return json(res, 500, { error: error.message });
    }
  }

  const filePath = path.join(ROOT, reqUrl.pathname.replace(/^\/+/, ''));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendFile(res, filePath);
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 高考志愿咨询系统启动成功！`);
  console.log(`📍 端口: ${PORT}`);
  console.log(`💬 访问地址: http://localhost:${PORT}/chat.html`);
  console.log(`📦 LLM: ${LLM_BASE_URL}`);
  console.log(`🔑 API Key: ${API_KEY ? '已配置' : '未配置'}`);
});
