const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3011;
const ROOT = __dirname;

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const API_KEY = process.env.API_KEY || '';
const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL || 'https://api.deepseek.com/v1/embeddings';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-ada-002';
const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';

const KNOWLEDGE_COLLECTIONS = [
  { name: 'policies', prefix: '01_政策规则' },
  { name: 'provinces', prefix: '02_省份数据' },
  { name: 'schools', prefix: '03_院校库' },
  { name: 'majors', prefix: '04_专业库' },
  { name: 'styles', prefix: '05_张雪峰风格库' },
  { name: 'cases', prefix: '06_案例库' },
  { name: 'scores', prefix: '07_录取数据' },
];

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

async function createEmbedding(text) {
  if (!API_KEY) {
    throw new Error('API_KEY not configured');
  }

  const response = await fetch(`${EMBEDDINGS_URL}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding API error: ${response.status} - ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.data?.[0]?.embedding || [];
}

async function searchQdrant(embedding, collectionName, topK = 3) {
  if (!QDRANT_URL || !QDRANT_API_KEY) {
    return [];
  }

  try {
    const response = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': QDRANT_API_KEY
      },
      body: JSON.stringify({
        vector: embedding,
        limit: topK,
        with_payload: true,
        with_vectors: false
      })
    });

    if (!response.ok) {
      log(`Qdrant search failed for ${collectionName}: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.result?.map(item => ({
      score: item.score,
      content: item.payload?.content || '',
      source: item.payload?.source || '',
      collection: collectionName
    })) || [];
  } catch (error) {
    log(`Qdrant error: ${error.message}`);
    return [];
  }
}

async function retrieveKnowledge(query) {
  const embedding = await createEmbedding(query);
  if (!embedding.length) {
    return [];
  }

  const allResults = [];
  for (const coll of KNOWLEDGE_COLLECTIONS) {
    const results = await searchQdrant(embedding, coll.name, 3);
    allResults.push(...results);
  }

  return allResults.sort((a, b) => b.score - a.score).slice(0, 10);
}

async function callLLM(message, context = []) {
  if (!API_KEY) {
    throw new Error('API_KEY not configured');
  }

  if (!message || message.trim() === '') {
    throw new Error('Message content cannot be empty');
  }

  let contextText = '';
  if (context && context.length > 0) {
    contextText = `以下是相关参考资料，请优先根据这些资料回答问题：\n\n`;
    context.forEach((item, index) => {
      const content = item && item.content && item.content.trim() ? item.content.substring(0, 300) : '暂无内容';
      const source = item && item.source ? item.source : '未知来源';
      contextText += `【参考${index + 1}】(${source})\n${content}\n\n`;
    });
    contextText += `---\n\n`;
  }

  const userContent = (contextText || '') + message;
  
  if (!userContent || userContent.trim() === '') {
    throw new Error('User content cannot be empty');
  }

  const systemPrompt = `你是一位专业的高考志愿填报顾问，风格类似张雪峰。请根据用户的问题，结合提供的参考资料，给出专业、详细、有针对性的建议。

用户可能问的问题类型包括：
1. 院校介绍和评价
2. 专业选择建议
3. 志愿填报策略
4. 分数线参考
5. 职业规划建议

回答规则：
1. 如果有参考资料，请优先使用参考资料中的信息
2. 如果参考资料不足，可以结合你的通用知识，但要明确说明这是你的分析
3. 不要编造分数、位次、投档线等具体数据
4. 用友好、亲切的语气回答，先给结论，再讲原因、风险和替代方案`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];
  
  log(`发送消息数量: ${messages.length}`);
  log(`消息0 (system) content长度: ${messages[0]?.content?.length || 0}`);
  log(`消息1 (user) content长度: ${messages[1]?.content?.length || 0}`);
  log(`消息1 content存在: ${!!messages[1]?.content}`);
  log(`消息1 content类型: ${typeof messages[1]?.content}`);

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

  if (reqUrl.pathname === '/api/test' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const prompt = body.prompt || 'hello';
      
      const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: '你是一个助手' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json(res, 500, { error: `LLM API error: ${response.status}`, details: errorText });
      }

      const data = await response.json();
      return json(res, 200, { answer: data.choices?.[0]?.message?.content });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (reqUrl.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const prompt = body.prompt || body.message || '';
      
      if (!prompt) {
        return json(res, 400, { error: '缺少问题内容' });
      }

      log(`收到问题: ${prompt.substring(0, 50)}...`);

      let knowledge = [];
      let route = 'direct_llm';
      
      if (QDRANT_URL && QDRANT_API_KEY) {
        log('正在检索知识库...');
        try {
          knowledge = await retrieveKnowledge(prompt);
          log(`检索到 ${knowledge.length} 条相关资料`);
          
          if (knowledge.length > 0) {
            route = 'knowledge_base';
          }
        } catch (e) {
          log(`知识库检索失败，跳过: ${e.message}`);
          knowledge = [];
        }
      }

      log('正在生成回答...');
      const answer = await callLLM(prompt, knowledge);
      log('回答完成');
      
      const sources = knowledge.map(k => k.source);
      
      return json(res, 200, { 
        answer: answer,
        route: route,
        sources: sources
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
  console.log(`📚 向量数据库: ${QDRANT_URL ? '已配置' : '未配置'}`);
  console.log(`📂 当前目录: ${__dirname}`);
  console.log(`📂 根目录: ${ROOT}`);
});