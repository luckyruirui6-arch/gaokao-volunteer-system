const fs = require('fs');
const path = require('path');

const QDRANT_URL = 'http://127.0.0.1:6333';
const QDRANT_API_KEY = '';
const EMBEDDINGS_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const API_KEY = 'sk-c66f556dac644aa7b40e52f1bda10eee';

const COLLECTIONS = [
  { id: 'gaokao_schools', dir: '03_院校库' },
  { id: 'gaokao_majors', dir: '04_专业库' },
  { id: 'gaokao_policies_rules', dir: '01_政策规则' },
  { id: 'gaokao_province_data', dir: '02_省份数据' },
  { id: 'gaokao_style_cases', dir: '05_张雪峰风格库' },
];

async function createEmbedding(text) {
  try {
    const response = await fetch(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: 'text-embedding-v3',
        input: text.slice(0, 4000),
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`❌ Embedding API错误: ${response.status} - ${errorText.slice(0, 100)}`);
      throw new Error(`Embedding failed: ${response.status}`);
    }
    
    const data = await response.json();
    if (!data.data || !data.data[0] || !data.data[0].embedding) {
      throw new Error('Invalid embedding response');
    }
    return data.data[0].embedding;
  } catch (e) {
    console.log(`⚠️ 创建embedding失败，使用随机向量: ${e.message}`);
    return Array(1024).fill(0).map(() => Math.random() * 2 - 1);
  }
}

async function createCollection(collectionName) {
  console.log(`尝试创建集合: ${collectionName}`);
  const response = await fetch(`${QDRANT_URL}/collections/${collectionName}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(QDRANT_API_KEY ? { 'Authorization': `Bearer ${QDRANT_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      vectors: {
        size: 1024,
        distance: 'Cosine',
      },
    }),
  });
  const text = await response.text();
  console.log(`创建结果: ${response.status} - ${text.slice(0, 100)}`);
  return response.ok;
}

async function upsertPoints(collectionName, points) {
  const response = await fetch(`${QDRANT_URL}/collections/${collectionName}/points`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(QDRANT_API_KEY ? { 'Authorization': `Bearer ${QDRANT_API_KEY}` } : {}),
    },
    body: JSON.stringify({ points }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upsert failed: ${response.status} - ${error.slice(0, 200)}`);
  }
  return response.json();
}

function walkMarkdownFiles(dir, result = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkMarkdownFiles(full, result);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (!/README|总表|索引|总说明/.test(entry.name)) {
          result.push(full);
        }
      }
    }
  } catch (e) {
    console.log(`Error reading ${dir}:`, e.message);
  }
  return result;
}

function readDocSnippet(filePath) {
  try {
    let text = fs.readFileSync(filePath, 'utf8');
    text = text.replace(/^---[\s\S]*?---\s*/m, '');
    text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
    text = text.replace(/\r/g, '');
    text = text.trim();
    return text;
  } catch {
    return '';
  }
}

async function main() {
  console.log('=== 开始上传知识库到 Qdrant ===\n');
  
  for (const { id, dir } of COLLECTIONS) {
    console.log(`\n📦 处理集合: ${id}`);
    console.log(`📂 目录: ${dir}`);
    
    await createCollection(id);
    
    const files = walkMarkdownFiles(dir);
    console.log(`📝 找到 ${files.length} 个文件`);
    
    if (files.length === 0) {
      console.log('⚠️ 没有找到文件，跳过');
      continue;
    }
    
    let pointId = 0;
    const batchSize = 3;
    let successCount = 0;
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const points = [];
      
      for (const filePath of batch) {
        const text = readDocSnippet(filePath);
        if (!text || text.length < 10) {
          console.log(`⏭️ 跳过空文件: ${path.basename(filePath)}`);
          continue;
        }
        
        try {
          const vector = await createEmbedding(text);
          const relativePath = path.relative('.', filePath).replace(/\\/g, '/');
          
          points.push({
            id: pointId++,
            vector,
            payload: {
              title: path.basename(filePath),
              path: relativePath,
              summary: text.slice(0, 800),
            },
          });
          
          console.log(`🔄 处理: ${path.basename(filePath)}`);
        } catch (e) {
          console.log(`❌ 失败: ${path.basename(filePath)} - ${e.message}`);
        }
      }
      
      if (points.length > 0) {
        try {
          await upsertPoints(id, points);
          successCount += points.length;
          console.log(`✅ 上传 ${points.length} 条数据`);
        } catch (e) {
          console.log(`❌ 批量上传失败: ${e.message}`);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log(`🎉 完成集合: ${id} (成功上传 ${successCount} 条)\n`);
  }
  
  console.log('=== 所有数据上传完成！===');
}

main().catch(console.error);