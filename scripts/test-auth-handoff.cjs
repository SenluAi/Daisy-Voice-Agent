const assert = require("node:assert/strict");
const { requestsManualAuthentication } = require("../dist/main/automation/authHandoff.js");

assert.equal(requestsManualAuthentication("QQ 当前是登录界面，需要您先登录后才能发送文件。"), true);
assert.equal(requestsManualAuthentication("请您手动扫码或在手机上确认登录。"), true);
assert.equal(requestsManualAuthentication("已点击登录，正在等待 QQ 主界面。"), false);
assert.equal(requestsManualAuthentication("登录页有已保存账号和登录按钮，可以直接点击。"), false);
assert.equal(requestsManualAuthentication("已把文件发给北城。"), false);

console.log("auth handoff classification passed");
