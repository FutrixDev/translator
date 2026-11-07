/**
 * 输入框按钮的「在此网站不显示」：一个 sync 键，存一份站点（主机）列表。
 *
 * 双模经典脚本：服务工作者 import 它、内容脚本用 <script> 装，挂在
 * globalThis.InputChipHosts 上。不放进用户站点规则（shared/custom-rules.js）：那是
 * 已发布的同步存储契约，旧版本的扩展读不懂的规则会整条丢掉（D-1043）。
 *
 * 读：内容脚本自己读（hidden）。写：读—改—写一整个列表，两个标签页同时点会互相
 * 盖掉，所以和漫画提示的主机列表一样排进服务工作者的单写者队列（StorageWriter）；
 * 失败抛给点下去的那一处，由它说「没存上」。
 *
 * 主机按站点规则的口径归一（www.example.com 和 example.com 是同一个站）。列表最多
 * 留 MAX_HOSTS 条、并且按编码后的字节塞进 sync 每项的预算，超了先丢最早的。
 */
(function (root) {
  const { SiteRules, StorageWriter } = root;
  if (!SiteRules) throw new Error('input-chip-hosts.js 要先装 shared/site-rules.js');
  if (!StorageWriter) throw new Error('input-chip-hosts.js 要先装 shared/storage-writer.js');

  const KEY = 'inputChipHiddenHosts';
  const MAX_HOSTS = 200;

  async function stored() {
    const value = (await chrome.storage.sync.get({ [KEY]: [] }))[KEY];
    return Array.isArray(value) ? value : [];
  }

  /** 这台主机是不是被「在此网站不显示」关掉了。 */
  async function hidden(host) {
    const key = SiteRules.normalizeHost(host);
    return Boolean(key) && (await stored()).includes(key);
  }

  async function hide({ host }) {
    const key = SiteRules.normalizeHost(host);
    if (!key) throw new Error(`input-chip-hosts: not a host: ${host}`);
    const hosts = await stored();
    if (hosts.includes(key)) return;
    await chrome.storage.sync.set({ [KEY]: StorageWriter.fitNewest([...hosts, key], MAX_HOSTS) });
  }

  const writer = StorageWriter.create({ type: 'INPUT_CHIP_HOSTS_WRITE', writes: { hide }, errors: 'throw' });

  root.InputChipHosts = {
    KEY,
    hidden,
    hide: (host) => writer.request('hide', { host }),
    applyWrite: writer.applyWrite,
  };
})(globalThis);
