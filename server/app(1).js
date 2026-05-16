const dom = {
  stream: document.getElementById("message-stream"),
  form: document.getElementById("chat-form"),
  prompt: document.getElementById("user-prompt"),
  template: document.getElementById("message-template"),
  providerTag: document.getElementById("provider-tag"),
  quotaTag: document.getElementById("quota-tag"),
  concurrencyTag: document.getElementById("concurrency-tag"),
  workspaceTag: document.getElementById("workspace-tag"),
  queuePanel: document.getElementById("queue-panel"),
  queueText: document.getElementById("queue-text"),
  queueProgress: document.getElementById("queue-progress"),
  queuePill: document.getElementById("queue-pill"),
  queueModal: document.getElementById("queue-modal"),
  queueModalText: document.getElementById("queue-modal-text"),
  queueModalProgress: document.getElementById("queue-modal-progress"),
  watchAdBtn: document.getElementById("watch-ad-btn"),
  adModal: document.getElementById("ad-modal"),
  adCountdown: document.getElementById("ad-countdown"),
  closeAdBtn: document.getElementById("close-ad-btn"),
};

let queueTimer = null;
let adTimer = null;
let progressTimer = null;

init();

async function init() {
  await hydrateDashboard();
  bindQuickPrompts();
  bindNav();
  dom.form.addEventListener("submit", handleSubmit);
  dom.prompt.addEventListener("keydown", handlePromptKeydown);
  if (dom.watchAdBtn) dom.watchAdBtn.addEventListener("click", openAdModal);
  window.addEventListener("storage", hydrateDashboard);
  setInterval(hydrateDashboard, 5000);
}

async function hydrateDashboard() {
  const config = await getAdminConfig();
  let status = null;
  try {
    status = await getBackendStatus();
  } catch {
    status = null;
  }
  if (dom.providerTag) dom.providerTag.textContent = `接口：${providerName(config.provider)}`;
  if (dom.quotaTag) dom.quotaTag.textContent = `可用次数：${getQuota()}`;
  if (dom.concurrencyTag) dom.concurrencyTag.textContent = `并发上限：${status?.maxConcurrency ?? config.maxConcurrency}`;
  if (dom.workspaceTag) dom.workspaceTag.textContent = `工作区 / 模型：${config.workspaceSlug || "未配置"}`;
  if (dom.watchAdBtn) {
    dom.watchAdBtn.textContent = config.adEnabled
      ? (config.adMode === "api" ? "请求广告奖励" : `开始广告倒计时（${config.adDurationSeconds || 30}s）`)
      : `广告关闭，直接恢复 ${config.adRewardQuestions || 5} 次`;
  }
  if (dom.queuePill && (!status || status.activeRequests < status.maxConcurrency)) {
    dom.queuePill.textContent = "当前无排队";
  }
}

function bindQuickPrompts() {
  document.querySelectorAll(".quick-chip").forEach((button) => {
    button.addEventListener("click", () => {
      dom.prompt.value = button.dataset.prompt || "";
      dom.prompt.focus();
    });
  });
}

function bindNav() {
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = document.querySelector(link.getAttribute("href"));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

async function handleSubmit(event) {
  event.preventDefault();
  const prompt = dom.prompt.value.trim();
  if (!prompt) return;

  appendMessage("user", "你的问题", prompt);
  dom.prompt.value = "";
  await hydrateDashboard();

  const loadingNode = appendProgressMessage();
  startProgressFlow(loadingNode);

  try {
    const answer = await askBackend(prompt);
    stopProgressFlow(loadingNode, "回答已生成，正在整理结果");
    loadingNode.remove();
    appendMessage("assistant", "AI 回答", answer.answer);
    if (answer.route || (answer.sources && answer.sources.length)) {
      const meta = renderMetaMessage(answer.route, answer.sources || []);
      if (meta) appendMessage("assistant", "参考信息", meta);
    }
  } catch (error) {
    stopProgressFlow(loadingNode, "处理中断");
    loadingNode.remove();
    appendMessage("assistant", "提示", error.message || "请求失败，请稍后重试。");
  } finally {
    await hydrateDashboard();
  }
}

function handlePromptKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    dom.form.requestSubmit();
  }
}

async function askBackend(prompt) {
  let attempt = 0;
  while (attempt < 20) {
    attempt += 1;
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (response.status === 429) {
      const status = await safeStatus();
      const ahead = Math.max((status?.activeRequests || 1) - (status?.maxConcurrency || 1) + 1, 1);
      showQueueState(ahead, status?.queueVisualSeconds || 12);
      await wait(status?.queueStepMs || 2400, status?.queueVisualSeconds || 12, attempt);
      continue;
    }

    hideQueueState();

    if (!response.ok) {
      const payload = await safeJson(response);
      throw new Error(payload?.error || `请求失败：${response.status}`);
    }

    return response.json();
  }

  throw new Error("当前排队时间过长，请稍后再试。");
}

async function safeStatus() {
  try {
    return await getBackendStatus();
  } catch {
    return null;
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function wait(stepMs, seconds, attempt) {
  clearInterval(queueTimer);
  dom.queueProgress.style.width = "6%";
  if (dom.queueModalProgress) dom.queueModalProgress.style.width = "6%";
  let elapsed = 0;
  await new Promise((resolve) => {
    queueTimer = setInterval(() => {
      elapsed += stepMs;
      const progress = Math.min((elapsed / (seconds * 1000)) * 100, 96);
      dom.queueProgress.style.width = `${progress}%`;
      if (dom.queueModalProgress) dom.queueModalProgress.style.width = `${progress}%`;
      dom.queueText.textContent = `当前后端拥堵，正在排队重试（第 ${attempt} 次）`;
      if (dom.queueModalText) dom.queueModalText.textContent = `当前后端拥堵，正在排队重试（第 ${attempt} 次）`;
      if (elapsed >= seconds * 1000) {
        clearInterval(queueTimer);
        resolve();
      }
    }, stepMs);
  });
}

function showQueueState(ahead, seconds) {
  dom.queuePanel.classList.remove("hidden");
  if (dom.queuePill) dom.queuePill.textContent = "排队中";
  dom.queueText.textContent = `前方约 ${ahead} 个请求，预计 ${seconds} 秒内轮到`;
  dom.queueProgress.style.width = "6%";
  if (dom.queueModal) dom.queueModal.classList.remove("hidden");
  if (dom.queueModalText) dom.queueModalText.textContent = `当前需要排队，前方约 ${ahead} 个请求，预计 ${seconds} 秒内轮到`;
  if (dom.queueModalProgress) dom.queueModalProgress.style.width = "6%";
}

function hideQueueState() {
  dom.queuePanel.classList.add("hidden");
  dom.queueProgress.style.width = "0%";
  if (dom.queuePill) dom.queuePill.textContent = "当前无排队";
  if (dom.queueModal) dom.queueModal.classList.add("hidden");
  if (dom.queueModalProgress) dom.queueModalProgress.style.width = "0%";
}

function appendMessage(type, roleLabel, content) {
  const node = dom.template.content.firstElementChild.cloneNode(true);
  node.classList.add(type);
  node.querySelector(".message-role").textContent = roleLabel;
  node.querySelector(".message-body").innerHTML = formatContent(content);
  dom.stream.appendChild(node);
  dom.stream.scrollTop = dom.stream.scrollHeight;
  return node;
}

function appendSystemMessage(content) {
  return appendMessage("assistant", "提示", content);
}

function appendProgressMessage() {
  const node = dom.template.content.firstElementChild.cloneNode(true);
  node.classList.add("assistant", "progress-message");
  node.querySelector(".message-role").textContent = "处理中";
  node.querySelector(".message-body").innerHTML = `
    <div class="progress-card">
      <div class="progress-card-title">正在为你整理咨询结果</div>
      <div class="progress-card-text" data-progress-text>正在识别问题类型</div>
      <div class="progress-track inline-progress">
        <div class="progress-fill" data-inline-progress></div>
      </div>
    </div>
  `;
  dom.stream.appendChild(node);
  dom.stream.scrollTop = dom.stream.scrollHeight;
  return node;
}

function startProgressFlow(node) {
  const textNode = node.querySelector("[data-progress-text]");
  const barNode = node.querySelector("[data-inline-progress]");
  if (!textNode || !barNode) return;

  const stages = [
    { text: "正在识别问题类型", progress: 12 },
    { text: "正在检索知识库", progress: 30 },
    { text: "向量模型正在整理相关资料", progress: 50 },
    { text: "知识库检索完成，正在组合回答上下文", progress: 72 },
    { text: "云端语言大模型正在生成回答，速度会稍慢一些，请耐心等待", progress: 90 },
  ];

  let index = 0;
  textNode.textContent = stages[0].text;
  barNode.style.width = `${stages[0].progress}%`;
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    index = Math.min(index + 1, stages.length - 1);
    textNode.textContent = stages[index].text;
    barNode.style.width = `${stages[index].progress}%`;
    if (index === stages.length - 1) {
      clearInterval(progressTimer);
    }
  }, 850);
}

function stopProgressFlow(node, finalText) {
  clearInterval(progressTimer);
  progressTimer = null;
  const textNode = node.querySelector("[data-progress-text]");
  const barNode = node.querySelector("[data-inline-progress]");
  if (textNode) textNode.textContent = finalText;
  if (barNode) barNode.style.width = "100%";
}

function renderMetaMessage(route, sources) {
  const lines = [];
  if (route) lines.push(`命中路由：${prettifyRouteLabel(route)}`);
  if (sources.length) {
    const { primary, secondary } = classifySources(route, sources);
    if (primary.length) {
      lines.push(`主参考：${primary.map(prettifySourceLabel).join("、")}`);
    }
    if (secondary.length) {
      lines.push(`辅助参考：${secondary.map(prettifySourceLabel).join("、")}`);
    }
  }
  return lines.join("\n");
}

function classifySources(route, sources) {
  const primary = [];
  const secondary = [];
  for (const source of sources) {
    const normalized = String(source || "").replace(/\\/g, "/");
    const isSchool = /03_院校库\/.+\.md$/i.test(normalized);
    const isMajor = /04_专业库\/.+\.md$/i.test(normalized);
    const isPolicy = /(01_政策规则|02_省份数据|07_录取数据)\/.+\.md$/i.test(normalized);
    const isStyleCase = /(05_张雪峰风格库|06_案例库)\/.+\.md$/i.test(normalized);

    const shouldPrimary =
      (route === "school_consult" && isSchool) ||
      (route === "major_consult" && isMajor) ||
      (route === "policy_consult" && isPolicy) ||
      (route === "score_tendency" && (isPolicy || isSchool || isMajor)) ||
      (route === "family_emotion" && isStyleCase);

    if (shouldPrimary) {
      primary.push(source);
    } else {
      secondary.push(source);
    }
  }
  return { primary, secondary };
}

function prettifySourceLabel(source) {
  const normalized = String(source || "").replace(/\\/g, "/");
  const last = normalized.split("/").pop() || normalized;
  return last.replace(/\.md$/i, "");
}

function prettifyRouteLabel(route) {
  const map = {
    major_consult: "专业分析",
    school_consult: "院校对比",
    policy_consult: "政策规则",
    score_tendency: "分数与录取倾向",
    family_emotion: "家庭约束与情绪支持",
  };
  return map[route] || route;
}

function formatContent(content) {
  return escapeHtml(content)
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `<p>${item.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

async function openAdModal() {
  const config = await getAdminConfig();

  if (!config.adEnabled || config.adDebugBypass) {
    const reward = await requestAdReward();
    await rewardQuestions(reward.granted || config.adRewardQuestions || 5);
    appendSystemMessage(`广告门槛已关闭，已直接恢复 ${reward.granted || config.adRewardQuestions || 5} 次提问。`);
    return;
  }

  if (config.adMode === "api") {
    const reward = await requestAdReward();
    await rewardQuestions(reward.granted || config.adRewardQuestions || 5);
    appendSystemMessage(`广告接口奖励已发放，已恢复 ${reward.granted || config.adRewardQuestions || 5} 次提问。`);
    return;
  }

  dom.adModal.classList.remove("hidden");
  dom.closeAdBtn.disabled = true;
  dom.closeAdBtn.textContent = "请等待倒计时结束";
  let seconds = config.adDurationSeconds || 30;
  updateCountdown(seconds, config.adDurationSeconds || 30);
  clearInterval(adTimer);
  adTimer = setInterval(async () => {
    seconds -= 1;
    updateCountdown(seconds, config.adDurationSeconds || 30);
    if (seconds <= 0) {
      clearInterval(adTimer);
      const reward = await requestAdReward();
      await rewardQuestions(reward.granted || config.adRewardQuestions || 5);
      await hydrateDashboard();
      dom.closeAdBtn.disabled = false;
      dom.closeAdBtn.textContent = `已恢复 ${reward.granted || config.adRewardQuestions || 5} 次，关闭`;
      dom.closeAdBtn.onclick = closeAdModal;
    }
  }, 1000);
}

function updateCountdown(seconds, total) {
  const progress = ((total - seconds) / total) * 100;
  dom.adCountdown.textContent = String(Math.max(seconds, 0));
  document.documentElement.style.setProperty("--progress", `${progress}%`);
}

function closeAdModal() {
  dom.adModal.classList.add("hidden");
  dom.closeAdBtn.onclick = null;
}

async function requestAdReward() {
  const response = await fetch("/api/ad/reward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "frontend" }),
  });
  if (!response.ok) {
    const payload = await safeJson(response);
    throw new Error(payload?.error || "广告奖励请求失败");
  }
  return response.json();
}

async function rewardQuestions(count) {
  await hydrateDashboard();
}
