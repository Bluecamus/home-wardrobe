#!/usr/bin/env node

// quick_validate — 快速校验本仓库内所有 skill 的结构合法性。
// 用法：node scripts/quick_validate.mjs [skillsRoot]
// 默认扫描 <repo>/.agents/skills/*/SKILL.md。

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { error: "缺少 YAML frontmatter（需以 --- 开头并以 --- 结束）" };
  const raw = match[1];
  const body = match[2].trim();
  const fields = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return { fields, body, rawName: raw.match(/^name:\s*(.*)$/m)?.[1]?.trim() ?? "" };
}

async function referencedPathsExist(skillDir, body) {
  const missing = [];
  // 匹配形如 [text](references/xxx.md) 或 [text](scripts/xxx.mjs) 的相对链接
  const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  for (const link of links) {
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    const target = link.split("#")[0];
    if (!target) continue;
    try {
      await stat(path.join(skillDir, target));
    } catch {
      missing.push(target);
    }
  }
  return missing;
}

async function validateSkill(skillDir) {
  const errors = [];
  const dirName = path.basename(skillDir);
  const skillFile = path.join(skillDir, "SKILL.md");

  let source;
  try {
    source = await readFile(skillFile, "utf8");
  } catch {
    return { name: dirName, errors: ["缺少 SKILL.md"] };
  }

  const { fields, body, rawName, error } = parseFrontmatter(source);
  if (error) return { name: dirName, errors: [error] };

  const name = fields.name;
  const description = fields.description;

  if (!name) errors.push("frontmatter 缺少 name");
  else {
    if (name !== dirName) errors.push(`name（${name}）必须与目录名（${dirName}）一致`);
    if (name.length < 2 || name.length > 64) errors.push("name 长度需在 2-64 之间");
    if (!NAME_RULE.test(name)) errors.push("name 只能用小写字母/数字/单个连字符，且首尾为字母或数字");
    if (/^["']|["']$/.test(rawName)) errors.push("name 不应加引号");
  }

  if (!description) errors.push("frontmatter 缺少 description");
  else {
    if (description.length > 1024) errors.push("description 过长（建议 < 200 字符）");
    if (/:\s/.test(description)) errors.push('description 不应包含 ": "（冒号加空格）');
    if (/[<>]/.test(description)) errors.push("description 不应包含 < 或 >");
    if (/TODO/i.test(description)) errors.push("description 不应包含 TODO");
    if (/(\bUse when\b|当用户|使用|用于|不用于|不适用)/.test(description) === false) {
      errors.push("description 应同时说明「做什么」与「何时触发」");
    }
  }

  if (!body) errors.push("SKILL.md 正文为空");

  const missing = await referencedPathsExist(skillDir, body);
  for (const item of missing) errors.push(`正文引用的相对路径不存在：${item}`);

  return { name: dirName, errors, description };
}

async function main() {
  const repoRoot = process.cwd();
  const skillsRoot = path.resolve(process.argv[2] || path.join(repoRoot, ".agents", "skills"));

  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    console.error(`找不到 skills 根目录：${skillsRoot}`);
    process.exit(1);
  }

  const skillDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(skillsRoot, entry.name));
  if (!skillDirs.length) {
    console.error(`在 ${skillsRoot} 下未发现任何 skill 目录`);
    process.exit(1);
  }

  console.log(`quick_validate — 校验 ${skillDirs.length} 个 skill（${skillsRoot}）\n`);

  let failed = 0;
  for (const skillDir of skillDirs) {
    const result = await validateSkill(skillDir);
    if (result.errors.length) {
      failed += 1;
      console.log(`✗ ${result.name}`);
      for (const error of result.errors) console.log(`    - ${error}`);
    } else {
      console.log(`✓ ${result.name}`);
      if (result.description) console.log(`    description: ${result.description}`);
    }
  }

  console.log("");
  if (failed) {
    console.log(`校验失败：${failed}/${skillDirs.length} 个 skill 存在问题。`);
    process.exit(1);
  }
  console.log(`校验通过：${skillDirs.length}/${skillDirs.length} 个 skill 均合法。`);
}

await main();
