'use strict';

/**
 * 开启 / 查询 GitHub Pages（分支模式：main 分支 /docs 目录）
 * ------------------------------------------------------------------
 * 用法：
 *   $env:GH_TOKEN='github_pat_xxx'; node scripts/setup-pages.js [仓库名]
 *   $env:GH_TOKEN='github_pat_xxx'; node scripts/setup-pages.js [仓库名] --status
 *
 * 说明：GitHub Pages 对新建仓库存在最终一致性延迟，若首次返回 422，
 * 脚本会自动等待并重试若干次。
 */

const OWNER = process.env.GH_OWNER || 'KyoukaAlice';
const REPO = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.env.GH_REPO || 'lab-equipment-booking';
const STATUS_ONLY = process.argv.includes('--status');
const TOKEN = process.env.GH_TOKEN || '';
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error("缺少 GH_TOKEN。请先执行：$env:GH_TOKEN='github_pat_xxx'");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'lab-booking-system-pages-script',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body, { allow404 = false } = {}) {
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (allow404 && res.status === 404) return { ok: false, status: 404, json: null };
  if (!res.ok && res.status !== 404 && res.status !== 422) {
    throw new Error(`${method} ${url} -> HTTP ${res.status}: ${(json && json.message) || text.slice(0, 200)}`);
  }
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  const repoUrl = `${API}/repos/${OWNER}/${REPO}`;
  const pagesUrl = `${repoUrl}/pages`;

  console.log(`\n仓库：${OWNER}/${REPO}`);

  const current = await api('GET', pagesUrl, undefined, { allow404: true });
  if (current.ok && current.json) {
    console.log(`当前 Pages 状态：${current.json.status}｜来源：${current.json.source ? `${current.json.source.branch} /${current.json.source.path}` : '未知'}`);
    console.log(`访问地址：${current.json.html_url}`);
    if (STATUS_ONLY) return;
  } else {
    console.log('当前未开启 Pages。');
    if (STATUS_ONLY) return;
  }

  if (!STATUS_ONLY) {
    console.log('\n正在开启 Pages（main 分支 /docs 目录）…');
    let result = null;
    for (let attempt = 1; attempt <= 8 && !result; attempt += 1) {
      const res = current.ok
        ? await api('PUT', pagesUrl, { source: { branch: 'main', path: '/docs' } })
        : await api('POST', pagesUrl, { source: { branch: 'main', path: '/docs' } });
      if (res.ok) {
        result = res.json;
        break;
      }
      const msg = (res.json && res.json.message) || '';
      console.log(`      第 ${attempt} 次返回 HTTP ${res.status}：${msg}，20 秒后重试…`);
      await sleep(20000);
    }
    if (!result) throw new Error('多次重试后仍未成功开启 Pages（可能是仓库尚未完成初始化或 token 缺少 Pages 权限）');
    console.log(`      已开启：来源 ${result.source ? `${result.source.branch} /${result.source.path}` : 'main /docs'}｜状态 ${result.status}`);
  }

  // 等待首次构建完成，并验证站点可访问
  const siteUrl = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;
  console.log(`\n等待 Pages 首次构建（最长约 3 分钟）…`);
  let built = false;
  for (let i = 1; i <= 18; i += 1) {
    await sleep(10000);
    const st = await api('GET', pagesUrl, undefined, { allow404: true });
    const status = st.ok && st.json ? st.json.status : 'unknown';
    process.stdout.write(`      [${i}/18] 构建状态：${status}\r`);
    if (status === 'built') {
      built = true;
      console.log(`\n      构建完成 ✅`);
      break;
    }
    if (status === 'errored') {
      console.log('\n      构建失败 ❌（请到仓库 Actions / Pages 设置查看日志）');
      break;
    }
  }

  // 校验线上页面
  console.log(`\n校验线上地址：${siteUrl}`);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const res = await fetch(siteUrl, { redirect: 'follow' });
      const html = await res.text();
      const hasTitle = /实验室设备预约与共享管理系统/.test(html);
      const hasRepoLink = /lab-equipment-booking/.test(html);
      console.log(`      HTTP ${res.status}｜${html.length} 字节｜标题匹配：${hasTitle ? '是' : '否'}｜仓库链接：${hasRepoLink ? '是' : '否'}`);
      if (res.status === 200 && hasTitle) {
        console.log('\n' + '='.repeat(64));
        console.log(`Pages 部署成功 ✅`);
        console.log(`  项目介绍页：${siteUrl}`);
        console.log(`  仓库地址　：https://github.com/${OWNER}/${REPO}`);
        console.log('='.repeat(64) + '\n');
        return;
      }
    } catch (err) {
      console.log(`      第 ${attempt} 次访问失败：${err.message}`);
    }
    await sleep(15000);
  }
  console.log(`\n页面暂未可访问（构建可能仍在进行或排队）。稍后打开：${siteUrl}`);
  void built;
}

main().catch((err) => {
  console.error('\n开启 Pages 失败：', err.message);
  if (/Resource not accessible|403|Not enough permissions/i.test(err.message)) {
    console.error('提示：token 缺少 Pages 权限（classic token 需 repo；fine-grained 需 Pages: Read and write）。');
    console.error('      也可以在仓库 Settings → Pages 手动选择 main 分支 + /docs 目录。');
  }
  process.exit(1);
});
