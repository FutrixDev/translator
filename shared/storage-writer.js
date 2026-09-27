/**
 * 同步存储的单写者：一类写入一条队列，排在服务工作者里。
 *
 * 双模经典脚本：服务工作者 import 它，内容脚本、设置页、popup 用 <script> 装。
 * 挂在 globalThis.StorageWriter 上，site-rules、auto-stats、custom-rules 三家共用
 * —— 这段逻辑以前在前两家各抄了一份，第三份就是漂移的开始。
 *
 * 为什么要单写者：
 *
 * 站点规则和追问计数各自是一整个对象里的一个键：读出来、改一个键、整份写回。
 * 同一个域名开着三个标签页，或者用户一边在 popup 上点「关」、一边追问条在给
 * 另一个域名记数，两边都会先读到同一份旧对象，后写的那份把先写的整个盖掉 ——
 * 用户点下的选择就这么没了，而且哪里都不报错。
 *
 * 所以写入点收到服务工作者里：它是单实例，配上一条队列（两条消息的处理照样
 * 能在 await 处交错）就能把这些改动串成一条线。队列只保证顺序、不传播失败：
 * 一次写崩了不该把后面的全卡死 —— 失败照样交给发起这次写入的调用方。
 *
 * 两家对失败的态度本来就不同，所以做成参数（errors）：
 * - 'throw'：失败抛给调用方。用户刚点下的那一下没存上，调用方要说得出口。
 * - 'swallow'：失败得 null。统计、额度这类附带动作，写不进去不该让主路径出错；
 *   这里是错误被接住、不再往上抛的那一层，所以在这里记一条 warn。
 */
(function (root) {
  const IN_SERVICE_WORKER =
    typeof ServiceWorkerGlobalScope !== 'undefined' && root instanceof ServiceWorkerGlobalScope;

  // 同步存储是**每项** 8KB：撑爆的那天 set() 直接失败。按**序列化之后的字节数**
  // 算，不按条数 —— 撑爆配额的是字节。8KB 里只留 6KB，剩下的是给键名本身和
  // 「Chrome 怎么数」留的余量：差那一点就写不进去，代价是整个键。
  const ITEM_BUDGET = 6 * 1024;

  function itemBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }

  // 'SITE_RULES_WRITE' -> 'site-rules'：报错里用的名字，和各家以前手写的一致。
  function writerLabel(type) {
    return String(type).replace(/_WRITE$/, '').toLowerCase().replace(/_/g, '-');
  }

  const ERROR_MODES = new Set(['throw', 'swallow']);

  /**
   * @param {{type: string, writes: Object<string, function>, errors: 'throw'|'swallow'}} spec
   *   type：写消息的 type（背景页按它分派）；writes：kind → 在 SW 里真正执行的写；
   *   errors：见文件头。
   * @returns {{applyWrite: function, request: function}}
   *   applyWrite(message)：服务工作者的入口，把一条写入排进这个 writer 的队列；
   *   request(kind, payload)：在服务工作者里就自己写，在别处就发消息交给它。
   */
  function create({ type, writes, errors }) {
    if (!type || !writes) throw new Error('StorageWriter.create needs type and writes');
    if (!ERROR_MODES.has(errors)) throw new Error(`StorageWriter.create: unknown errors mode ${errors}`);
    const label = writerLabel(type);
    let queue = Promise.resolve();

    function applyWrite(message) {
      const write = message && writes[message.kind];
      if (!write) return Promise.reject(new Error(`unknown ${label} write: ${message && message.kind}`));
      const result = queue.then(() => write(message), () => write(message));
      queue = result.catch(() => {});
      return result;
    }

    function send(message) {
      const runtime = root.chrome && root.chrome.runtime;
      if (!runtime || !runtime.sendMessage) {
        return Promise.reject(new Error(`${type}: no extension runtime to send the write to`));
      }
      return runtime.sendMessage(message).then((reply) => {
        if (reply && reply.error) throw new Error(reply.error);
        return reply ? reply.value : undefined;
      });
    }

    function request(kind, payload) {
      const message = Object.assign({ type, kind }, payload);
      if (errors === 'throw') {
        if (IN_SERVICE_WORKER) return applyWrite(message);
        return send(message);
      }
      // 'swallow'：没有 runtime（单元测试、页面正在卸载）不是错误，直接得 null。
      const runtime = root.chrome && root.chrome.runtime;
      if (!IN_SERVICE_WORKER && (!runtime || !runtime.sendMessage)) return Promise.resolve(null);
      const pending = IN_SERVICE_WORKER ? applyWrite(message) : send(message);
      return pending.then(
        (value) => value || null,
        (error) => {
          console.warn(`${type} ${kind} failed:`, error);
          return null;
        },
      );
    }

    return { applyWrite, request };
  }

  root.StorageWriter = { create, ITEM_BUDGET, itemBytes, IN_SERVICE_WORKER };
})(globalThis);
