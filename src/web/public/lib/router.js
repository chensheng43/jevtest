/**
 * 路由的共享状态：离开确认、视图清理、强制重载。
 *
 * 单独成模块是为了让视图不必 import app.js（入口），免得出现循环依赖。
 */

/** 当前视图挂上的「离开前确认」。返回 Promise<boolean>：true = 可以走 */
let leaveGuard = null;
/** 当前视图离开时要做的清理（停轮询、摘全局监听）。换视图时依次调用 */
let cleanups = [];
let reloadHandler = () => {};

export function setLeaveGuard(guard) {
  leaveGuard = guard;
}

export function getLeaveGuard() {
  return leaveGuard;
}

/** 注册一个在视图离开时执行的清理函数。 */
export function onLeave(fn) {
  cleanups.push(fn);
}

export function runCleanups() {
  const pending = cleanups;
  cleanups = [];
  for (const fn of pending) {
    try {
      fn();
    } catch {
      /* 清理失败不影响进入下一张视图 */
    }
  }
}

export function setReloadHandler(fn) {
  reloadHandler = fn;
}

/** 丢掉离开确认，按当前地址重建视图（例如「重新加载最新版本」）。 */
export function reload() {
  leaveGuard = null;
  reloadHandler();
}

export function navigate(hash) {
  if (location.hash === hash) reload();
  else location.hash = hash;
}
