const fs = require('fs');
const path = require('path');

require('dotenv').config();

const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL || '';
const API_KEY = process.env.API_KEY || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v3';

async function getEmbedding(text) {
  if (!EMBEDDINGS_URL) {
    throw new Error('EMBEDDINGS_URL not configured');
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
    const errorText = await response.text();
    throw new Error(`Embedding API error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  return data.data[0].embedding;
}

async function createCollection(collectionName) {
  const response = await fetch(`${QDRANT_URL}/collections/${collectionName}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'api-key': QDRANT_API_KEY
    },
    body: JSON.stringify({
      vectors: {
        size: 1536,
        distance: 'Cosine'
      }
    })
  });
  
  if (!response.ok && response.status !== 409) {
    throw new Error(`Create collection error: ${response.status}`);
  }
  
  console.log(`Collection "${collectionName}" ready`);
}

async function upsertPoints(collectionName, points) {
  const response = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/upsert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': QDRANT_API_KEY
    },
    body: JSON.stringify({ points })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upsert error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  return data;
}

async function loadCollegeData() {
  const colleges = [];
  const basePath = path.join(__dirname, '../03_院校库');
  const provinces = fs.readdirSync(basePath, { withFileTypes: true })
    .filter(dir => dir.isDirectory())
    .map(dir => dir.name);
  
  provinces.forEach(province => {
    const provincePath = path.join(basePath, province);
    const files = fs.readdirSync(provincePath).filter(f => f.endsWith('.md'));
    
    files.forEach(file => {
      const content = fs.readFileSync(path.join(provincePath, file), 'utf-8');
      const name = file.replace('.md', '');
      colleges.push({
        name,
        province,
        content,
        type: 'college'
      });
    });
  });
  
  return colleges;
}

async function loadMajorData() {
  const majors = [];
  const basePath = path.join(__dirname, '../04_专业库');
  const files = fs.readdirSync(basePath).filter(f => f.endsWith('.md') && !f.includes('(1)'));
  
  files.forEach(file => {
    const content = fs.readFileSync(path.join(basePath, file), 'utf-8');
    const name = file.replace('.md', '');
    majors.push({
      name,
      content,
      type: 'major'
    });
  });
  
  return majors;
}

async function main() {
  if (!QDRANT_URL || !QDRANT_API_KEY) {
    console.error('Error: QDRANT_URL and QDRANT_API_KEY must be set');
    process.exit(1);
  }
  
  if (!EMBEDDINGS_URL || !API_KEY) {
    console.error('Error: EMBEDDINGS_URL and API_KEY must be set');
    process.exit(1);
  }
  
  console.log('Loading data...');
  
  const colleges = await loadCollegeData();
  const majors = await loadMajorData();
  
  console.log(`Loaded ${colleges.length} colleges and ${majors.length} majors`);
  
  console.log('\nCreating collection "gaokao"...');
  await createCollection('gaokao');
  
  let totalProcessed = 0;
  const batchSize = 10;
  
  const allItems = [...colleges, ...majors];
  
  for (let i = 0; i < allItems.length; i += batchSize) {
    const batch = allItems.slice(i, i + batchSize);
    const points = [];
    
    console.log(`\nProcessing items ${i + 1}-${Math.min(i + batchSize, allItems.length)}...`);
    
    for (const item of batch) {
      console.log(`  - ${item.name}`);
      
      try {
        const embedding = await getEmbedding(item.content);
        
        points.push({
          id: totalProcessed,
          vector: embedding,
          payload: {
            name: item.name,
            type: item.type,
            province: item.province || '',
            content: item.content.substring(0, 2000)
          }
        });
        
        totalProcessed++;
      } catch (error) {
        console.error(`  ! Error processing ${item.name}: ${error.message}`);
      }
    }
    
    if (points.length > 0) {
      await upsertPoints('gaokao', points);
      console.log(`  ✓ ${points.length} items uploaded`);
    }
  }
  
  console.log(`\n✅ Import completed! Total processed: ${totalProcessed}`);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});