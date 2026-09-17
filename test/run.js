'use strict';

/**
 * 测试入口：发现并依次加载 test/*.test.js，然后串行执行全部用例。
 *   node test/run.js                          运行全部
 *   node test/run.js booking                  只运行文件名含 booking 的测试文件
 *   node test/run.js interval,conflict-rules  多个关键字用逗号分隔
 */

const fs = require('node:fs');
const path = require('node:path');

const { setCurrentFile, takeCases, takeHooks } = require('./runner');

const COLORS = {
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
};

function discover(filter) {
  const keywords = String(filter || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => (keywords.length ? keywords.some((kw) => f.includes(kw)) : true))
    .sort()
    .map((f) => path.join(__dirname, f));
}

function describeError(err) {
  const lines = String((err && err.message) || err).split('\n');
  // 诊断型错误会用「｜」分隔多段信息，这里保留前两段，便于定位失败原因
  if (lines.length > 1) return `${lines[0]} ${lines[1]}`;
  const parts = lines[0].split('｜');
  return parts.length > 1 ? `${parts[0]}\n      ${parts.slice(1).join('｜')}` : lines[0];
}

async function main() {
  const filter = process.argv[2] || '';
  const files = discover(filter);
  console.log(COLORS.bold(`\n实验室设备预约与共享管理系统 · 自动化测试`));
  console.log(COLORS.dim(`共发现 ${files.length} 个测试文件${filter ? `（过滤：${filter}）` : ''}\n`));

  let passed = 0;
  let failed = 0;
  const failures = [];
  const startedAt = Date.now();

  for (const file of files) {
    const base = path.basename(file);
    setCurrentFile(base);
    try {
      // 每个文件独立加载（清缓存），文件内部自行完成数据库/服务初始化
      delete require.cache[require.resolve(file)];
      require(file);
    } catch (err) {
      failed += 1;
      failures.push({ name: `${base}（模块加载）`, err });
      console.log(`${COLORS.red('✖')} ${base} 加载失败：${describeError(err)}`);
      takeCases();
      takeHooks();
      continue;
    }

    const cases = takeCases();
    const hooks = takeHooks();
    console.log(COLORS.bold(`📄 ${base}（${cases.length} 个用例）`));

    let hookFailed = false;
    for (const hook of hooks.before) {
      try {
        await hook();
      } catch (err) {
        hookFailed = true;
        failures.push({ name: `${base}（before 钩子）`, err });
        console.log(`  ${COLORS.red('✖')} before 钩子失败：${describeError(err)}`);
      }
    }
    if (hookFailed) {
      failed += cases.length;
      continue;
    }

    for (const c of cases) {
      const t0 = Date.now();
      try {
        await c.fn();
        passed += 1;
        console.log(`  ${COLORS.green('✓')} ${c.name} ${COLORS.dim(`(${Date.now() - t0}ms)`)}`);
      } catch (err) {
        failed += 1;
        failures.push({ name: `${base} → ${c.name}`, err });
        console.log(`  ${COLORS.red('✖')} ${c.name}`);
        console.log(`      ${COLORS.red(describeError(err))}`);
        if (err && err.actual !== undefined && err.expected !== undefined) {
          console.log(COLORS.dim(`      期望：${JSON.stringify(err.expected)}`));
          console.log(COLORS.dim(`      实际：${JSON.stringify(err.actual)}`));
        }
      }
    }

    for (const hook of hooks.after) {
      try {
        await hook();
      } catch (err) {
        console.log(`  ${COLORS.yellow('⚠')} after 钩子异常：${describeError(err)}`);
      }
    }
    console.log('');
  }

  const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log('─'.repeat(66));
  if (failed === 0) {
    console.log(COLORS.green(COLORS.bold(`✅ 全部通过：${passed} 个用例，耗时 ${duration}s`)));
  } else {
    console.log(COLORS.red(COLORS.bold(`❌ 失败 ${failed} 个 / 共 ${passed + failed} 个用例，耗时 ${duration}s`)));
    console.log(COLORS.bold('\n失败清单：'));
    for (const f of failures) {
      console.log(`  · ${f.name}`);
      console.log(COLORS.dim(`    ${describeError(f.err)}`));
    }
  }
  console.log('─'.repeat(66) + '\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试运行器异常：', err);
  process.exit(1);
});
