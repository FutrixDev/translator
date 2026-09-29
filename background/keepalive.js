// Blab Translation background — 模型请求在途时让 service worker 别被回收。
//
// MV3 的 service worker 空闲 30 秒就会被回收；扩展接口调用会重置这个计时。一次
// 模型请求最长等 timeoutSec（上限 240 秒），中间没有任何扩展接口调用，SW 可能在
// 答案回来之前就没了（设计 §3.8）。所以在途请求数从 0 变 1 时起一个 20 秒的计时器
// 调 chrome.runtime.getPlatformInfo()，回到 0 就清掉。
//
// 引用计数而不是每个请求一个计时器：并发 12 批的整页翻译只需要一个。

const PING_MS = 20000;

let holders = 0;
let timer = null;

function ping() {
  // 附带动作：一次 ping 失败不影响请求本身，记下来继续。
  chrome.runtime.getPlatformInfo().catch((error) => {
    console.warn('keepalive ping failed:', error);
  });
}

function acquire() {
  holders += 1;
  if (holders === 1) timer = setInterval(ping, PING_MS);
}

function release() {
  if (holders <= 0) throw new Error('keepalive.release without acquire');
  holders -= 1;
  if (holders === 0) {
    clearInterval(timer);
    timer = null;
  }
}

/** 测试用：当前在途数与计时器是否在跑。 */
function keepaliveState() {
  return { holders, running: timer !== null };
}

export { acquire, release, keepaliveState, PING_MS };
