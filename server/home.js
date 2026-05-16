const graphData = {
  policy: {
    title: "政策规则",
    body: "这一层沉淀的是各省高考制度、赋分规则、提前批、专项、特招、公费与定向路径。它决定了能不能报、怎么报，以及哪些规则必须优先看清。",
    points: ["先看省份制度差异", "提前批、专项、公费题优先命中这里", "是后续学校和专业判断的制度底座"],
  },
  province: {
    title: "省份数据",
    body: "这一层记录各省录取数据总览、历史数据说明、数据口径和官方查询入口，用来判断一个问题到底能不能进入更细的录取分析。",
    points: ["先知道当前省份数据覆盖到什么程度", "历史数据主要看趋势和层级", "回答分数问题时会先落到这一层"],
  },
  score: {
    title: "录取数据",
    body: "这里放的是学校和专业在各省的历史录取分数、位次和规则说明。它最适合回答冲稳保、能不能报、大致层级这类问题，但不会替代当年官方结果。",
    points: ["主要用于录取倾向判断", "历史数据仅供参考", "最终仍要回到官方数据确认"],
  },
  route: {
    title: "问题路由",
    body: "这是整套系统的中枢。它会先判断你是在问学校、专业、政策、录取还是家庭约束，再把问题送到最合适的知识层里检索，避免全库乱搜。",
    points: ["先分类，再检索", "减少无关文档误命中", "让回答尽量贴着数据走"],
  },
  school: {
    title: "院校库",
    body: "院校库负责学校定位、优势专业、报考风险和现实适配度。它更适合回答这所学校值不值得报、和另一所学校怎么比、适合什么样的学生。",
    points: ["学校定位与层级判断", "优势方向和风险提醒", "学校对比题优先看这里"],
  },
  major: {
    title: "专业库",
    body: "专业库负责专业定义、优缺点、发展路线、未来前景和家庭约束。它更适合回答这个专业值不值得学、适不适合普通家庭、未来是不是分化行业。",
    points: ["专业价值与前景", "适合 / 不适合人群", "专业问题优先命中这里"],
  },
  style: {
    title: "风格与案例",
    body: "这一层不是用来替代事实，而是让回答更像真实咨询。里面有家庭约束标签、情绪沟通模板、捡漏案例和各种高频场景，负责把结论说得更像人。",
    points: ["回答风格优先参考这里", "高焦虑和家庭约束问题很重要", "不改变事实，只优化表达和场景感"],
  },
  explain: {
    title: "回答生成",
    body: "最后模型会把检索到的事实、规则和案例模板揉在一起，先给结论，再讲现实、风险和替代方案，尽量做到像一个会说真话的老师在对话。",
    points: ["先结论，再原因", "没有数据时会明确提醒", "风格参考案例，但事实服从数据"],
  },
};

const nodeEls = Array.from(document.querySelectorAll(".graph-node"));
const titleEl = document.getElementById("graph-detail-title");
const bodyEl = document.getElementById("graph-detail-body");
const listEl = document.getElementById("graph-detail-list");
const stageEl = document.getElementById("graph-stage");

nodeEls.forEach((node) => {
  node.addEventListener("click", () => activateNode(node.dataset.node));
  node.addEventListener("mouseenter", () => activateNode(node.dataset.node, false));
});

activateNode("policy", true);

function activateNode(key, sticky = true) {
  const data = graphData[key];
  if (!data) return;

  titleEl.textContent = data.title;
  bodyEl.textContent = data.body;
  listEl.innerHTML = data.points.map((point) => `<li>${point}</li>`).join("");
  if (stageEl) stageEl.dataset.active = key;

  if (sticky) {
    nodeEls.forEach((node) => {
      node.classList.toggle("is-active", node.dataset.node === key);
    });
  }
}


// Typewriter Animation
const typeHeadline = "致敬张雪峰老师\n让关键选择少一点迷茫 多一点清晰";
const typeTarget = document.getElementById("typewriter-text");
const actionsTarget = document.getElementById("hero-actions");
if (typeTarget && actionsTarget) {
  let charIdx = 0;
  function typeWriter() {
    if (charIdx === 0) typeTarget.innerHTML = '';
    if (charIdx < typeHeadline.length) {
      const char = typeHeadline.charAt(charIdx);
      if (char === '\n') {
        typeTarget.innerHTML += '<br>';
      } else {
        typeTarget.appendChild(document.createTextNode(char));
      }
      charIdx++;
      let speed = 60 + Math.random() * 40;
      if (char === ' ') speed = 120;
      setTimeout(typeWriter, speed);
    } else {
      setTimeout(() => {
        actionsTarget.style.transition = "opacity 0.8s ease, transform 0.8s cubic-bezier(0.2, 0.8, 0.2, 1)";
        actionsTarget.style.opacity = "1";
        actionsTarget.style.transform = "translateY(0)";
        actionsTarget.style.pointerEvents = "auto";
      }, 200);
    }
  }
  setTimeout(typeWriter, 500);
}
