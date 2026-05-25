require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 静态文件 - 仅在非 Netlify 环境生效（Netlify 由 CDN 直接托管静态文件）
const isNetlify = !!process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME;
if (!isNetlify) {
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.static(__dirname));
}

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL;
const API_KEY = process.env.API_KEY;
const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v3';
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

// 数据目录 - 兼容多种运行环境
function getDataRoot() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  // 尝试 server 目录的上级（本地开发 server.js 运行）
  const localRoot = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(localRoot, '03_院校库'))) return localRoot;
  // 尝试 Netlify Function 的上级（netlify/functions -> ../../）
  const netlifyRoot = path.resolve(__dirname, '../..');
  if (fs.existsSync(path.join(netlifyRoot, '03_院校库'))) return netlifyRoot;
  // 回退到 cwd
  return process.cwd();
}

const DATA_ROOT = getDataRoot();

function validateConfig() {
  const missing = [];
  if (!LLM_BASE_URL) missing.push('LLM_BASE_URL');
  if (!LLM_MODEL) missing.push('LLM_MODEL');
  if (!API_KEY) missing.push('API_KEY');
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(v => console.error(`  - ${v}`));
    if (!isNetlify) {
      console.error('\nPlease set these environment variables in Render Console or .env file.');
      process.exit(1);
    }
    return;
  }
  
  console.log('✅ Environment variables loaded successfully:');
  console.log(`  LLM_BASE_URL: ${LLM_BASE_URL}`);
  console.log(`  LLM_MODEL: ${LLM_MODEL}`);
  console.log(`  Has API_KEY: ${API_KEY ? 'Yes' : 'No'}`);
  console.log(`  Has EMBEDDINGS_URL: ${EMBEDDINGS_URL ? 'Yes' : 'No'}`);
  console.log(`  Has QDRANT_URL: ${QDRANT_URL ? 'Yes' : 'No'}`);
  console.log(`  DATA_ROOT: ${DATA_ROOT}`);
}

validateConfig();

async function callLLM(messages) {
  const isDashScope = LLM_BASE_URL.includes('dashscope');
  
  let headers = {
    'Content-Type': 'application/json'
  };
  
  if (isDashScope) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  } else {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }
  
  const body = {
    model: LLM_MODEL,
    messages: messages,
    temperature: 0.7,
    max_tokens: 2048
  };
  
  console.log(`🔄 Calling LLM: ${LLM_BASE_URL}/chat/completions`);
  console.log(`📦 Model: ${LLM_MODEL}`);
  console.log(`📨 Message count: ${messages.length}`);
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ LLM API error: ${response.status}`);
      console.error(`❌ Error body: ${errorText.substring(0, 500)}`);
      throw new Error(`LLM API error: ${response.status} - ${errorText.substring(0, 200)}`);
    }
    
    const data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error(`❌ Unexpected response format: ${JSON.stringify(data).substring(0, 500)}`);
      throw new Error('Unexpected LLM response format');
    }
    
    return data.choices[0].message.content;
  } catch (error) {
    console.error(`❌ LLM call failed: ${error.message}`);
    throw error;
  }
}

async function getEmbedding(text) {
  if (!EMBEDDINGS_URL) {
    throw new Error('Embeddings URL not configured');
  }
  
  const response = await fetch(`${EMBEDDINGS_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.substring(0, 5000),
      encoding_format: 'float'
    })
  });
  
  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.data[0].embedding;
}

async function searchQdrant(embedding, collectionName = 'gaokao', limit = 5) {
  if (!QDRANT_URL || !QDRANT_API_KEY) {
    throw new Error('Qdrant not configured');
  }
  
  const response = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': QDRANT_API_KEY
    },
    body: JSON.stringify({
      vector: embedding,
      limit: limit,
      with_payload: true
    })
  });
  
  if (!response.ok) {
    throw new Error(`Qdrant API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.result.map(r => r.payload);
}

function loadCollegeData() {
  const colleges = [];
  const collegeDir = path.join(DATA_ROOT, '03_院校库');
  if (!fs.existsSync(collegeDir)) return colleges;
  const provinces = fs.readdirSync(collegeDir, { withFileTypes: true })
    .filter(dir => dir.isDirectory())
    .map(dir => dir.name);
  
  provinces.forEach(province => {
    const provincePath = path.join(collegeDir, province);
    const files = fs.readdirSync(provincePath).filter(f => f.endsWith('.md'));
    
    files.forEach(file => {
      const content = fs.readFileSync(path.join(provincePath, file), 'utf-8');
      const name = file.replace('.md', '');
      colleges.push({
        name,
        province,
        content: content.substring(0, 500)
      });
    });
  });
  
  return colleges;
}

function loadMajorData() {
  const majors = [];
  const majorDir = path.join(DATA_ROOT, '04_专业库');
  if (!fs.existsSync(majorDir)) return majors;
  const files = fs.readdirSync(majorDir)
    .filter(f => f.endsWith('.md') && !f.includes('(1)'));
  
  files.forEach(file => {
    const content = fs.readFileSync(path.join(majorDir, file), 'utf-8');
    const name = file.replace('.md', '');
    majors.push({
      name,
      content: content.substring(0, 500)
    });
  });
  
  return majors;
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Gaokao Volunteer System API',
    config: {
      llmModel: LLM_MODEL,
      llmBaseUrl: LLM_BASE_URL,
      hasEmbeddings: !!EMBEDDINGS_URL,
      hasQdrant: !!QDRANT_URL
    }
  });
});

app.get('/api/colleges', (req, res) => {
  const { province, keyword } = req.query;
  let colleges = loadCollegeData();
  
  if (province) {
    colleges = colleges.filter(c => c.province.includes(province));
  }
  
  if (keyword) {
    colleges = colleges.filter(c => c.name.includes(keyword));
  }
  
  res.json(colleges.slice(0, 20));
});

app.get('/api/majors', (req, res) => {
  const { keyword } = req.query;
  let majors = loadMajorData();
  
  if (keyword) {
    majors = majors.filter(m => m.name.includes(keyword));
  }
  
  res.json(majors.slice(0, 20));
});

app.get('/api/provinces', (req, res) => {
  const collegeDir = path.join(DATA_ROOT, '03_院校库');
  if (!fs.existsSync(collegeDir)) return res.json([]);
  const provinces = fs.readdirSync(collegeDir, { withFileTypes: true })
    .filter(dir => dir.isDirectory())
    .map(dir => dir.name);
  
  res.json(provinces);
});

app.post('/api/chat', async (req, res) => {
  try {
    const message = req.body.message || req.body.prompt || '';
    const history = req.body.history || [];
    const useVectorDb = req.body.useVectorDb !== undefined ? req.body.useVectorDb : false;
    
    let context = '';
    
    if (useVectorDb && QDRANT_URL && EMBEDDINGS_URL) {
      try {
        const embedding = await getEmbedding(message);
        const results = await searchQdrant(embedding, 'gaokao', 3);
        context = results.map(r => r.content).join('\n\n');
      } catch (vecError) {
        console.warn('Vector DB search failed:', vecError.message);
      }
    }
    
    const systemPrompt = `你是一位专业的高考志愿填报顾问。请根据用户的问题，结合提供的院校和专业数据，给出专业、详细、有针对性的建议。
    
参考资料：
${context || '暂无额外参考资料'}

用户可能问的问题类型包括：
1. 院校介绍和评价
2. 专业选择建议
3. 志愿填报策略
4. 分数线参考
5. 职业规划建议

请用友好、亲切的语气回答，确保信息准确可靠。`;
    
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).map(h => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: h.content
      })),
      { role: 'user', content: message }
    ];
    
    const response = await callLLM(messages);
    res.json({ answer: response, response, hasContext: !!context });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: '服务器内部错误', 
      details: error.message,
      llmUrl: LLM_BASE_URL
    });
  }
});

app.post('/api/embed', async (req, res) => {
  try {
    const { text } = req.body;
    const embedding = await getEmbedding(text);
    res.json({ embedding });
  } catch (error) {
    console.error('Embedding error:', error);
    res.status(500).json({ error: '嵌入服务错误', details: error.message });
  }
});

app.post('/api/upsert', async (req, res) => {
  try {
    if (!QDRANT_URL || !QDRANT_API_KEY) {
      return res.status(400).json({ error: 'Qdrant not configured' });
    }
    
    const { collectionName = 'gaokao', points } = req.body;
    
    const response = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/upsert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': QDRANT_API_KEY
      },
      body: JSON.stringify({ points })
    });
    
    if (!response.ok) {
      throw new Error(`Qdrant API error: ${response.status}`);
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Upsert error:', error);
    res.status(500).json({ error: '向量数据库错误', details: error.message });
  }
});

app.get('/chat.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});

// 仅在直接运行时启动 HTTP 服务器（非 Netlify/serverless 环境）
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📍 API: http://localhost:${PORT}/`);
    console.log(`💬 Chat: http://localhost:${PORT}/chat.html`);
  });
}

module.exports = app;