const adminDom = {
  providerSelect: document.getElementById("provider-select"),
  baseUrl: document.getElementById("base-url"),
  workspaceSlug: document.getElementById("workspace-slug"),
  apiKey: document.getElementById("api-key"),
  maxConcurrency: document.getElementById("max-concurrency"),
  queueStepMs: document.getElementById("queue-step-ms"),
  queueVisualSeconds: document.getElementById("queue-visual-seconds"),
  qdrantUrl: document.getElementById("qdrant-url"),
  embeddingsUrl: document.getElementById("embeddings-url"),
  embeddingModel: document.getElementById("embedding-model"),
  topKPerCollection: document.getElementById("topk-per-collection"),
  systemPrompt: document.getElementById("system-prompt"),
  adEnabled: document.getElementById("ad-enabled"),
  adMode: document.getElementById("ad-mode"),
  adDebugBypass: document.getElementById("ad-debug-bypass"),
  adDurationSeconds: document.getElementById("ad-duration-seconds"),
  adRewardQuestions: document.getElementById("ad-reward-questions"),
  adApiBaseUrl: document.getElementById("ad-api-base-url"),
  adRewardPath: document.getElementById("ad-reward-path"),
  adVerifyPath: document.getElementById("ad-verify-path"),
  adAppId: document.getElementById("ad-app-id"),
  adSlotId: document.getElementById("ad-slot-id"),
  saveButton: document.getElementById("save-admin-btn"),
  statusBadges: document.getElementById("status-badges"),
};

initAdmin();

async function initAdmin() {
  await hydrateAdminForm();
  await renderStatus();
  adminDom.saveButton.addEventListener("click", saveAdmin);
}

async function hydrateAdminForm() {
  const config = await getAdminConfig();
  adminDom.providerSelect.value = config.provider;
  adminDom.baseUrl.value = config.baseUrl;
  adminDom.workspaceSlug.value = config.workspaceSlug;
  adminDom.apiKey.value = config.apiKey;
  adminDom.maxConcurrency.value = config.maxConcurrency;
  adminDom.queueStepMs.value = config.queueStepMs;
  adminDom.queueVisualSeconds.value = config.queueVisualSeconds;
  adminDom.qdrantUrl.value = config.qdrantUrl;
  adminDom.embeddingsUrl.value = config.embeddingsUrl;
  adminDom.embeddingModel.value = config.embeddingModel;
  adminDom.topKPerCollection.value = config.topKPerCollection;
  adminDom.systemPrompt.value = config.systemPrompt || "";
  adminDom.adEnabled.value = String(Boolean(config.adEnabled));
  adminDom.adMode.value = config.adMode || "local-timer";
  adminDom.adDebugBypass.value = String(Boolean(config.adDebugBypass));
  adminDom.adDurationSeconds.value = config.adDurationSeconds || 30;
  adminDom.adRewardQuestions.value = config.adRewardQuestions || 5;
  adminDom.adApiBaseUrl.value = config.adApiBaseUrl || "";
  adminDom.adRewardPath.value = config.adRewardPath || "/reward";
  adminDom.adVerifyPath.value = config.adVerifyPath || "/verify";
  adminDom.adAppId.value = config.adAppId || "";
  adminDom.adSlotId.value = config.adSlotId || "";
}

async function saveAdmin() {
  await saveAdminConfig({
    provider: adminDom.providerSelect.value,
    baseUrl: adminDom.baseUrl.value.trim(),
    workspaceSlug: adminDom.workspaceSlug.value.trim(),
    apiKey: adminDom.apiKey.value.trim(),
    maxConcurrency: Number(adminDom.maxConcurrency.value || 1),
    queueStepMs: Number(adminDom.queueStepMs.value || 2400),
    queueVisualSeconds: Number(adminDom.queueVisualSeconds.value || 12),
    qdrantUrl: adminDom.qdrantUrl.value.trim(),
    embeddingsUrl: adminDom.embeddingsUrl.value.trim(),
    embeddingModel: adminDom.embeddingModel.value.trim(),
    topKPerCollection: Number(adminDom.topKPerCollection.value || 3),
    systemPrompt: adminDom.systemPrompt.value.trim(),
    adEnabled: adminDom.adEnabled.value === "true",
    adMode: adminDom.adMode.value,
    adDebugBypass: adminDom.adDebugBypass.value === "true",
    adDurationSeconds: Number(adminDom.adDurationSeconds.value || 30),
    adRewardQuestions: Number(adminDom.adRewardQuestions.value || 5),
    adApiBaseUrl: adminDom.adApiBaseUrl.value.trim(),
    adRewardPath: adminDom.adRewardPath.value.trim() || "/reward",
    adVerifyPath: adminDom.adVerifyPath.value.trim() || "/verify",
    adAppId: adminDom.adAppId.value.trim(),
    adSlotId: adminDom.adSlotId.value.trim(),
  });
  await renderStatus();
}

async function renderStatus() {
  const config = await getAdminConfig();
  let status = null;
  try {
    status = await getBackendStatus();
  } catch {
    status = null;
  }

  const badges = [
    `接口：${providerName(config.provider)}`,
    `模型：${config.workspaceSlug || "未配置"}`,
    `Qdrant：${config.qdrantUrl || "未配置"}`,
    `Embeddings：${config.embeddingModel || "未配置"}`,
    `并发上限：${status?.maxConcurrency ?? config.maxConcurrency}`,
    `当前活动请求：${status?.activeRequests ?? "未知"}`,
    `TopK / collection：${config.topKPerCollection}`,
    `提示词长度：${(config.systemPrompt || "").length}`,
    `广告门槛：${config.adEnabled ? "开启" : "关闭"}`,
    `广告模式：${config.adMode || "local-timer"}`,
    `奖励次数：${config.adRewardQuestions || 5}`,
  ];
  adminDom.statusBadges.innerHTML = badges.map((item) => `<span>${item}</span>`).join("");
}
