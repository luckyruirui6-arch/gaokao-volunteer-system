# 志愿镜像前后端

这一版已经不是前端本地模拟，而是“前台 + 后台控制台 + 本地后端服务”的结构。

## 页面和服务

- `index.html`
  前台用户页，只保留 4 个功能：
  - 对话
  - 看广告
  - 怎么问
  - 提醒

- `admin.html`
  后端控制页，用来设置：
  - 大模型提供方
  - Base URL
  - 工作区 / 模型
  - API Key
  - 并发上限
  - Qdrant URL
  - Embeddings URL
  - Embedding 模型
  - 每个 collection 的检索 TopK

- `server.js`
  本地 Node 后端，负责：
  - 提供前台和后台页面
  - 保存后台配置
  - 维护真实并发状态
  - 按问题类型路由到 Qdrant collection
  - 调用 AnythingLLM 或 OpenAI 兼容模型

## 文件说明

- `index.html`：前台对话页
- `admin.html`：后台控制页
- `styles.css`：统一深色主题样式
- `shared.js`：前后台共享请求函数
- `app.js`：前台交互、排队、广告逻辑
- `admin.js`：后台配置逻辑
- `backend-config.json`：服务端配置文件
- `server.js`：本地后端服务

## 当前能力

- 深色苹果风前台
- 桌面端 / 移动端响应式
- 前后台分离
- 后台真实保存配置
- 前台真实读取后端状态
- 后端并发限制和排队
- Qdrant 路由检索
- AnythingLLM 接入
- OpenAI 兼容接口接入
- Future Cloud API 预留
- 点击广告 30 秒恢复 5 次提问
- 当前数据库范围提醒：`仅公办本科`
- 当前历史数据提醒：`2024 年数据仅供参考`

## 启动方式

在 `D:\张雪峰应用\高考仓库\13_网页前端` 下运行：

```powershell
node .\server.js
```

启动后访问：

- 前台：`http://127.0.0.1:3011/`
- 后台：`http://127.0.0.1:3011/admin.html`

## 一键启动

根目录已经放好一键启动脚本：

- `D:\张雪峰应用\一键启动_局域网前后端.bat`

双击后会：

1. 启动网页后端
2. 自动打开前台和后台页面
3. 输出本机和局域网访问地址

默认端口：

- `3011`

局域网其他用户访问格式：

- `http://你的局域网IP:3011/`
- `http://你的局域网IP:3011/admin.html`

## 使用顺序

1. 先确保 `LM Studio` 本地服务在跑，Qdrant 也在跑
2. 启动 `server.js`
3. 打开 `admin.html` 配置模型、Qdrant 和 embedding
4. 再打开 `index.html` 给用户使用
5. 当前没有免费次数，需要先看广告恢复 5 次

## 路由逻辑

- 专业问题：优先查 `gaokao_majors + gaokao_style_cases`
- 学校问题：优先查 `gaokao_schools + gaokao_style_cases`
- 政策问题：优先查 `gaokao_policies_rules + gaokao_province_data`
- 分数 / 录取问题：优先查 `gaokao_score_rules + gaokao_province_data`
- 家庭约束 / 情绪问题：优先查 `gaokao_style_cases + gaokao_majors`

## 关系图谱入口

- [[../00_文档关系图谱]]
