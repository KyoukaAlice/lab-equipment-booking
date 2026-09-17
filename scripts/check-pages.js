'use strict';
/* 介绍页静态自检：文案、结构与图库一致性 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
const issues = [];

// 1) 不应再出现「脚本/自动截取」这类实现细节表述
for (const bad of ['脚本驱动', '自动登录', '逐页截取', '自动截取', '真实运行截图']) {
  if (html.includes(bad)) issues.push(`文案仍含「${bad}」`);
}

// 2) 旧的结构树样式 class="tree" 应已替换为 filetree
if (/class="tree"/.test(html)) issues.push('仍引用旧样式 class="tree"');
if (!/class="filetree"/.test(html)) issues.push('缺少项目结构树 .filetree');

// 3) 分层列表应存在，且每个 li 恰好两个子元素（层名 + 说明）
if (!/ul class="layers"/.test(html)) issues.push('缺少分层列表 ul.layers');
const liCount = (html.match(/<li><i class="ly">/g) || []).length;
if (liCount !== 6) issues.push(`分层列表条目数为 ${liCount}，期望 6`);

// 4) 图库清单与磁盘文件一一对应
// 说明：首页 hero 大图直接写在 HTML 里（不在 SHOTS 列表中），因此需要把它也算作引用
const start = html.indexOf('const SHOTS = [');
const end = html.indexOf('\n];', start);
const block = html.slice(start, end);
const heroRefs = [...html.matchAll(/images\/([A-Za-z0-9_.-]+\.png)/g)].map((m) => m[1]);
const refs = [...new Set([...[...block.matchAll(/f: '([^']+)'/g)].map((m) => m[1]), ...heroRefs])].sort();
const disk = fs
  .readdirSync(path.join(root, 'docs', 'images'))
  .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
  .sort();
const missing = refs.filter((f) => !disk.includes(f));
const orphan = disk.filter((f) => !refs.includes(f));
if (missing.length) issues.push(`页面引用但文件缺失：${missing.join(', ')}`);
if (orphan.length) issues.push(`文件存在但未引用：${orphan.join(', ')}`);

// 5) 描述文案长度（保证单行不省略）
const descs = [...block.matchAll(/d: '([^']+)'/g)].map((m) => m[1]);
const longDesc = descs.filter((d) => d.length > 28);

console.log(`介绍页自检`);
console.log(`  图库条目：${refs.length} 个，磁盘文件：${disk.length} 张`);
console.log(`  分层条目：${liCount} 个｜描述最长：${Math.max(...descs.map((d) => d.length))} 字`);
if (longDesc.length) console.log(`  注意：以下描述超过 28 字，小屏可能显示省略号：${longDesc.join(' / ')}`);
console.log(`  检查结果：${issues.length ? '❌ ' + issues.join('；') : '✅ 通过'}`);
process.exit(issues.length ? 1 : 0);
