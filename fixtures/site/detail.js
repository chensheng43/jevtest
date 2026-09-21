/**
 * 详情页脚本。
 *
 * 只做两件事：把 URL 里的 id 填进页面、以及处理「返回列表」。
 * 页面内容依赖 query 参数，因此 e2e 可以断言「确实导航到了**这一台**设备」，
 * 而不只是「URL 变了」。
 */
(() => {
  "use strict";

  const DEVICES = {
    "1": { name: "HP LaserJet 1020", category: "打印机", status: "在线", location: "三楼机房" },
    "2": { name: "Canon iR-ADV C3530", category: "打印机", status: "离线", location: "二楼前台" },
    "3": { name: "TP-Link ER605", category: "路由器", status: "在线", location: "一楼弱电间" },
    "4": { name: "Huawei AR6121", category: "路由器", status: "在线", location: "三楼机房" },
  };

  window.__fixture = { backClicked: false, deviceId: null };

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const id = params.get("id") ?? "";
  const device = Object.prototype.hasOwnProperty.call(DEVICES, id) ? DEVICES[id] : null;

  window.__fixture.deviceId = device === null ? null : id;

  if (device !== null) {
    $("device-name").textContent = device.name;
    $("crumb-current").textContent = device.name;
    $("device-category").textContent = device.category;
    $("device-status").textContent = device.status;
    $("device-location").textContent = device.location;
    document.title = `${device.name} · 设备详情`;
  } else {
    $("device-name").textContent = "未找到该设备";
    document.title = "未找到该设备 · 设备详情";
  }

  $("back").addEventListener("click", () => {
    window.__fixture.backClicked = true;
    // 用显式导航而不是 history.back()：夹具要的是**确定**的落点，
    // 而 history.back() 的结果取决于这个标签页此前去过哪里。
    location.href = "index.html";
  });
})();
