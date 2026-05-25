const serverless = require('serverless-http');
const app = require('../../server/server');

// 导出 Netlify Function handler
exports.handler = serverless(app, {
  // 允许二进制响应
  binary: ['image/*', 'font/*', 'application/octet-stream'],
});
