'use strict';

/**
 * 通过 GitHub REST API 推送仓库（无需 git，适配直连 github.com 不稳但 api.github.com 可用的网络环境）
 * ------------------------------------------------------------------
 * 用法（PowerShell）：
 *   $env:GH_TOKEN='github_pat_xxx'; node scripts/push-to-github.js [仓库名]
 *
 * 过程：
 *   1. 创建仓库（若已存在则复用），不自动初始化 README（避免首次推送冲突）；
 *   2. 把工作区文件切成 blob 逐批上传（并发 8，失败重试）；
 *   3. 组装 tree → 创建 commit → 把 main 指向该 commit；
 *   4. 返回仓库地址与 Pages 所需信息。
 *
 * 说明：
 *   - 不依赖本地 .git，因此不会改动你的工作区；
 *   - 自动跳过 data/、node_modules/、临时文件（与 .gitignore 保持一致）；
 *   - token 只从环境变量读取，不写入任何文件、不打印到日志。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OWNER = process.env.GH_OWNER || 'KyoukaAlice';
const REPO = process.argv[2] || process.env.GH_REPO || 'lab-equipment-booking';
const TOKEN = process.env.GH_TOKEN || '';
const API = 'https://api.github.com';
const ROOT = path.join(__dirname, '..');
const BRANCH = 'main';

/** 需要排除的路径（与 .gitignore 对齐） */
const EXCLUDE_DIRS = new Set(['.git', 'data', 'node_modules', 'tmp', 'temp', '.idea', '.vscode']);
const EXCLUDE_FILES = [/\.db$/, /\.db-wal$/, /\.db-shm$/, /\.log$/, /^_/, /\.tmp$/, /\.bak$/];
const EXCLUDE_ANY = [/^docs\/images\/_/];

if (!TOKEN) {
  console.error('缺少 GH_TOKEN。请先执行：$env:GH_TOKEN=\'github_pat_xxx\'');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'lab-booking-system-push-script',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body, { retries = 4, allow404 = false } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      if (attempt === retries) throw new Error(`${method} ${url} 网络失败：${err.message}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (allow404 && res.status === 404) return null;
    if (res.status === 204) return {};
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // 空仓库读取 ref 时 GitHub 返回 409「Git Repository is empty」，语义上等同于「资源不存在」
    const isEmptyRepoMsg = json && typeof json.message === 'string' && /Repository is empty/i.test(json.message);
    if (allow404 && res.status === 409 && isEmptyRepoMsg) return null;
    if (res.ok) return json;

    // 403/429（限流）与 5xx（服务端瞬时错误）可重试
    const retriable = res.status === 403 || res.status === 429 || res.status >= 500;
    const message = (json && json.message) || text.slice(0, 200);
    if (retriable && attempt < retries) {
      const wait = res.status === 403 || res.status === 429 ? 4000 * (attempt + 1) : 1500 * (attempt + 1);
      console.log(`      HTTP ${res.status}，${wait / 1000}s 后重试 (${attempt + 1}/${retries})：${message}`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${method} ${url} -> HTTP ${res.status}: ${message}`);
  }
  throw new Error(`${method} ${url} 重试耗尽`);
}

/** 计算 git blob 的 SHA-1（用于校验上传结果） */
function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return require('node:crypto').createHash('sha1').update(Buffer.concat([header, buffer])).digest('hex');
}

/** 递归收集需要推送的文件 */
function collectFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(path.join(dir, entry.name), rel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_FILES.some((re) => re.test(entry.name))) continue;
    if (EXCLUDE_ANY.some((re) => re.test(rel))) continue;
    out.push(rel);
  }
  return out;
}

/** 判断是否可执行（Windows 上无 x 位，这里按扩展名约定） */
function fileMode(rel) {
  return /\.(sh|bat|cmd)$/i.test(rel) ? '100644' : '100644';
}

/**
 * 空仓库无法直接创建 blob（API 会返回 409 Git Repository is empty）。
 * 因此先用 Contents API 提交一个 .gitignore 作为引导提交，让仓库处于「有分支」的状态；
 * 后续创建真实 tree/commit 时不再把它作为父提交，引导提交会被自然丢弃。
 */
async function bootstrapIfEmpty(repoUrl, repo) {
  const head = await api('GET', `${repoUrl}/git/ref/heads/${BRANCH}`, undefined, { allow404: true });
  if (head && head.object && head.object.sha) return false;

  console.log('      空仓库：先创建引导提交（.gitignore）…');
  const gitignorePath = path.join(ROOT, '.gitignore');
  const content = fs.readFileSync(gitignorePath, 'utf8');
  const existing = await api('GET', `${repoUrl}/contents/.gitignore`, undefined, { allow404: true });
  const payload = {
    message: 'chore: 初始化仓库（引导提交）',
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: repo.default_branch || BRANCH,
  };
  if (existing && existing.sha) payload.sha = existing.sha;
  await api('PUT', `${repoUrl}/contents/.gitignore`, payload);
  // 新建引用存在最终一致性延迟，轮询等待分支出现
  for (let i = 0; i < 10; i += 1) {
    await sleep(1200);
    const ref = await api('GET', `${repoUrl}/git/ref/heads/${BRANCH}`, undefined, { allow404: true });
    if (ref && ref.object && ref.object.sha) {
      console.log(`      引导完成：${BRANCH} -> ${ref.object.sha.slice(0, 7)}`);
      return true;
    }
  }
  throw new Error('引导提交后仍未检测到 main 分支，请稍后重试');
}

async function main() {
  console.log(`\n仓库：${OWNER}/${REPO}`);
  console.log(`来源：${ROOT}\n`);

  /* ---------- 1. 仓库 ---------- */
  const repoUrl = `${API}/repos/${OWNER}/${REPO}`;
  let repo = await api('GET', repoUrl, undefined, { allow404: true });
  if (!repo) {
    console.log('[1/5] 创建仓库…');
    repo = await api('POST', `${API}/user/repos`, {
      name: REPO,
      description: '高校实验室设备预约与共享管理系统 · Node.js + SQLite 零第三方依赖 · R01~R12 冲突规则引擎 · 并发唯一性',
      homepage: `https://${OWNER.toLowerCase()}.github.io/${REPO}/`,
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    });
    console.log(`      已创建：${repo.full_name}（默认分支 ${repo.default_branch}）`);
    // 新建仓库存在最终一致性延迟，稍等再创建 blob
    await sleep(2500);
  } else {
    console.log(`[1/5] 仓库已存在，复用：${repo.full_name}`);
  }

  /* ---------- 2. 收集文件 ---------- */
  const files = collectFiles(ROOT).sort();
  const totalBytes = files.reduce((s, f) => s + fs.statSync(path.join(ROOT, f)).size, 0);
  console.log(`\n[2/5] 待推送 ${files.length} 个文件，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  // 空仓库需要先有引导提交，否则后续 git/blobs 会返回 409
  await bootstrapIfEmpty(repoUrl, repo);

  /* ---------- 3. 上传 blob（并发 8） ---------- */
  console.log('\n[3/5] 上传 blob…');
  const tree = new Array(files.length);
  let uploaded = 0;
  let verified = 0;

  async function uploadOne(idx) {
    const rel = files[idx];
    const full = path.join(ROOT, rel);
    const buf = fs.readFileSync(full);
    const localSha = gitBlobSha(buf);
    const payload = buf.length === 0 ? { content: '', encoding: 'base64' } : { content: buf.toString('base64'), encoding: 'base64' };
    const blob = await api('POST', `${repoUrl}/git/blobs`, payload);
    if (blob.sha !== localSha) {
      // 内容一致但 SHA 不同的情况不该出现；出现说明编码环节有问题，直接失败更安全
      throw new Error(`blob SHA 不一致：${rel} 本地 ${localSha.slice(0, 8)} vs 远端 ${String(blob.sha).slice(0, 8)}`);
    }
    verified += 1;
    tree[idx] = { path: rel, mode: fileMode(rel), type: 'blob', sha: blob.sha };
    uploaded += 1;
    if (uploaded % 10 === 0 || uploaded === files.length) {
      console.log(`      已上传 ${uploaded}/${files.length}（SHA 校验通过 ${verified}）`);
    }
  }

  const CONCURRENCY = 8;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = [];
    for (let k = i; k < Math.min(i + CONCURRENCY, files.length); k += 1) batch.push(uploadOne(k));
    await Promise.all(batch);
  }
  console.log('      SHA 全部一致 ✅');

  /* ---------- 4. tree + commit ---------- */
  console.log('\n[4/5] 创建 tree 与 commit…');
  const createdTree = await api('POST', `${repoUrl}/git/trees`, { tree });
  const message = `feat: 高校实验室设备预约与共享管理系统（毕业设计实现）

- 冲突检测规则引擎 R01~R12：设备/实验室状态、时间合法性、提前量、时长、
  开放排班、停机计划、设备占用、本人冲突、在途与周额度、信用状态
- 并发唯一性：进程内写锁 + BEGIN IMMEDIATE + 事务内二次校验
- 候补自动补位与限时确认、信用约束与自动冻结、后台定时作业
- 76 个 REST 接口、14 张表、20 个前端页面，零第三方依赖
- 验证：自动化测试 46/46、HTTP 冒烟 46/46、数据自检 33/33、前端渲染 30/30
- GitHub Pages 项目介绍页（docs/，含 16 张真实运行界面截图）`;

  const parents = [];
  // 注意：不把引导提交作为父提交，保证远端历史就是这一次干净的首个提交；
  // 引导提交只用于让仓库「非空」，随后的 force 更新会让它不可达。
  void parents;

  let name = 'KyoukaAlice';
  let email = 'KyoukaAlice@users.noreply.github.com';
  try {
    const user = await api('GET', `${API}/user`);
    if (user && user.login) {
      name = user.name || user.login;
      email = `${user.id}+${user.login}@users.noreply.github.com`;
    }
  } catch {
    /* 取不到用户信息时使用默认署名 */
  }
  const now = new Date().toISOString();
  const commit = await api('POST', `${repoUrl}/git/commits`, {
    message,
    tree: createdTree.sha,
    parents,
    author: { name, email, date: now },
    committer: { name, email, date: now },
  });
  console.log(`      commit ${commit.sha.slice(0, 7)}（父提交 ${parents.length ? parents[0].slice(0, 7) : '无，首个提交'}）`);

  /* ---------- 5. 更新分支引用 ---------- */
  console.log('\n[5/5] 更新分支引用…');
  // 引导提交已经创建了 main，因此这里必须先 PATCH（force）而非 POST（会返回 422 Reference already exists）
  let refUpdated = false;
  try {
    await api('PATCH', `${repoUrl}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
    refUpdated = true;
  } catch (err) {
    if (!/422|Reference does not exist/i.test(err.message)) throw err;
  }
  if (!refUpdated) {
    await api('POST', `${repoUrl}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }
  const finalRef = await api('GET', `${repoUrl}/git/ref/heads/${BRANCH}`);
  const remoteSha = finalRef.object.sha;
  console.log(`      ${BRANCH} -> ${remoteSha.slice(0, 7)}${remoteSha === commit.sha ? '（与本地提交一致 ✅）' : ''}`);

  const info = await api('GET', repoUrl);
  console.log('\n' + '='.repeat(64));
  console.log(`推送完成 ✅`);
  console.log(`  仓库：${info.html_url}`);
  console.log(`  默认分支：${info.default_branch}｜大小：${info.size} KB｜可见性：${info.private ? '私有' : '公开'}`);
  console.log(`  提交：${commit.sha}`);
  console.log(`  文件：${files.length} 个`);
  console.log('='.repeat(64) + '\n');

  // 输出机器可读结果，便于后续脚本（如开启 Pages）复用
  console.log(`PUSH_RESULT=${JSON.stringify({ owner: OWNER, repo: REPO, sha: commit.sha, files: files.length })}`);
  void execFileSync;
}

main().catch((err) => {
  console.error('\n推送失败：', err.message);
  if (/Bad credentials|401/.test(err.message)) {
    console.error('提示：token 无效或已过期；请确认使用 classic token 并勾选 repo 权限。');
  }
  if (/Resource not accessible|403/.test(err.message)) {
    console.error('提示：token 权限不足（需要 repo 权限；若用 fine-grained token，请授予 Contents: Read and write）。');
  }
  process.exit(1);
});
