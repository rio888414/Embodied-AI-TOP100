// 云服务公开配置 —— 仅包含可安全暴露在前端的值
// endpoint 与 publishableKey 由云服务开通时下发，publishableKey 本身不含权限，
// 服务端会做严格的 Origin 校验。
window.CLOUD_CONFIG = {
  endpoint: 'https://embodied-ai-funding-radar.app.workbuddy.host',
  publishableKey: 'wbpk_b8q339LAfbT1jIt297I5dN_8DFc4RX7UudfeUUqxigtdhluFFv0ENmZ'
};
