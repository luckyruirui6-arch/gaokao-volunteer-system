const APP_QUOTA_KEY = "zhiyuan-jingxiang-ad-quota";

const defaultAdminConfig = {
  provider: "openai-compatible",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  workspaceSlug: "z-ai/glm5",
  apiKey: "[REDACTED]",
  maxConcurrency: 1,
  queueStepMs: 2400,
  queueVisualSeconds: 12,
  qdrantUrl: "http://127.0.0.1:6333",
  embeddingsUrl: "http://127.0.0.1:1234/v1/embeddings",
  embeddingModel: "text-embedding-qwen3-embedding-4b",
  topKPerCollection: 3,
  systemPrompt: "你是一个高考志愿填报分析助手。\n回答时优先使用我提供的检索片段。\n如果检索片段不足，可以结合通用经验继续分析，但必须自然说明这部分属于经验判断，不是当前知识库里的精确数据。\n不允许编造分数、位次、投档线、专业组、就业率、保研率、排名、学科评估。\n如果问题涉及历史录取数据，要提醒用户历史数据仅供参考，最终要以阳光高考、各省教育考试院、学校本科招生网为准。\n回答要像一个懂高考志愿、愿意讲真话的人，先给结论，再讲原因、风险和替代方案。\n回答尽量自然，不要写成表格汇报。\n回答风格和模板优先参考 05_张雪峰风格库 与 06_案例库，但事实判断必须服从检索到的数据。",
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

async function getAdminConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("config_request_failed");
    const data = await response.json();
    return { ...defaultAdminConfig, ...data };
  } catch {
    return { ...defaultAdminConfig };
  }
}

async function saveAdminConfig(nextConfig) {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextConfig),
  });
  if (!response.ok) throw new Error(`save_config_failed_${response.status}`);
  const data = await response.json();
  return { ...defaultAdminConfig, ...data.config };
}

async function getBackendStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) throw new Error(`status_failed_${response.status}`);
  return response.json();
}

function getQuota() {
  const raw = localStorage.getItem(APP_QUOTA_KEY);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.remaining === "number" ? parsed.remaining : 0;
  } catch {
    return 0;
  }
}

function setQuota(remaining) {
  localStorage.setItem(APP_QUOTA_KEY, JSON.stringify({ remaining: Math.max(0, remaining) }));
}

function providerName(provider) {
  if (provider === "anythingllm") return "AnythingLLM";
  if (provider === "openai-compatible") return "OpenAI Compatible";
  if (provider === "anthropic-compatible") return "Anthropic Compatible";
  return "Future Cloud API";
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  
  let w, h;
  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const particles = [];
  const colors = ['#4285f4', '#ea4335', '#fbbc05', '#34a853'];

  let mouse = { x: -1000, y: -1000 };
  let isMoving = false;
  let idleTimeout;

  window.addEventListener('mousemove', e => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    isMoving = true;
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => { isMoving = false }, 100);

    for(let i=0; i<3; i++) {
      particles.push(new Particle(mouse.x, mouse.y, true));
    }
  });

  class Particle {
    constructor(x, y, isMouseSpawn = false) {
      if (isMouseSpawn) {
        this.x = x + (Math.random() - 0.5) * 30;
        this.y = y + (Math.random() - 0.5) * 30;
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 2 + 0.5;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
      } else {
        this.x = Math.random() * w;
        this.y = Math.random() * h;
        this.vx = (Math.random() - 0.5) * 0.5;
        this.vy = (Math.random() - 0.5) * 0.5;
      }
      this.size = Math.random() * 2.5 + 1.5;
      this.color = colors[Math.floor(Math.random() * colors.length)];
      this.life = 1;
      this.decay = Math.random() * 0.015 + 0.005; 
      this.angle = Math.atan2(this.vy, this.vx);
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.life -= this.decay;
      this.vx *= 0.98;
      this.vy *= 0.98;
    }
    draw() {
      ctx.globalAlpha = Math.max(0, this.life);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const len = this.size * 2 + 2; 
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + Math.cos(this.angle) * len, this.y + Math.sin(this.angle) * len);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  for (let i=0; i<40; i++) particles.push(new Particle(0,0, false));

  function animate() {
    ctx.clearRect(0, 0, w, h);
    
    if (Math.random() < 0.15 && particles.length < 150) {
      particles.push(new Particle(0, 0, false));
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (isMoving) {
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          p.vx -= (dx / dist) * 0.2;
          p.vy -= (dy / dist) * 0.2;
          p.angle = Math.atan2(p.vy, p.vx);
          p.life = Math.min(p.life + 0.1, 1); 
        }
      }

      p.update();
      p.draw();
      if (p.life <= 0) {
        particles.splice(i, 1);
      }
    }
    requestAnimationFrame(animate);
  }
  
  animate();
});

