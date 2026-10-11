export function requestsManualAuthentication(text: string): boolean {
  const authentication = /登录|扫码|验证码|账号密码|password|sign[ -]?in|login/i.test(text);
  const userAction = /请您|请你|需要您|需要你|手动|自行|人工|用户.{0,8}(?:操作|确认|输入)/.test(text);
  return authentication && userAction;
}
