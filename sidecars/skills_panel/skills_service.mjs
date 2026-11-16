import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
export const SKILL_RE = /^[a-zA-Z0-9._-]+$/;

const HOME = homedir();
const AGY_DIR = join(HOME, '.gemini', 'antigravity');
const CFG_DIR = join(HOME, '.gemini', 'config');
const GLOBAL_SKILLS = join(CFG_DIR, 'skills');
const GLOBAL_DISABLED = join(CFG_DIR, 'skills-disabled');
const BUILTIN_SKILLS = join(AGY_DIR, 'builtin', 'skills');
const USAGE_LOG = join(CFG_DIR, 'logs', 'skill-usage.jsonl');

const SECURITY_CHECKS = [
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|\n]*\|\s*(ba|z|fi)?sh\b/i, msg: 'Sťahovanie a priame spustenie skriptu (curl | sh)' },
  { re: /\b(iwr|Invoke-WebRequest|irm)\b[^\n]*\|\s*(iex|Invoke-Expression)\b/i, msg: 'PowerShell download + Invoke-Expression' },
  { re: /\brm\s+-rf\s+[\/~]/i, msg: 'Nebezpečné rekurzívne mazanie (rm -rf)' },
  { re: /--no-verify\b/i, msg: 'Obchádzanie git hookov (--no-verify)' },
  { re: /\b(\.env|id_rsa|id_ed25519|secrets\.json|printenv)\b/i, msg: 'Zmienka o citlivých súboroch alebo env premenných' },
  { re: /\bbase64\s+-d\b.*\|\s*(sh|bash|node|python)/i, msg: 'Obfuskované base64 vykonanie príkazu' },
];

function parseFrontmatter(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };
  const fm = m[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descSingle = fm.match(/^description:\s*(?![>-])(.+)$/m);
  let description = descSingle ? descSingle[1].trim() : '';
  if (!description) {
    const descMulti = fm.match(/^description:\s*[>-]\s*\r?\n((?:[ \t]+.+\r?\n?)+)/m);
    if (descMulti) {
      description = descMulti[1].replace(/\s+/g, ' ').trim();
    }
  }
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : '',
    description: description.replace(/^["']|["']$/g, ''),
  };
}

function readUsageCounts(days = 60) {
  const counts = {};
  if (!existsSync(USAGE_LOG)) return counts;
  const since = Date.now() - days * 864e5;
  try {
    const lines = readFileSync(USAGE_LOG, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.skill && Date.parse(entry.ts) >= since) {
          counts[entry.skill] = (counts[entry.skill] || 0) + 1;
        }
      } catch {}
    }
  } catch {}
  return counts;
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function readJsonSafe(p) {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
}

function scanSkillFolder(skillDir, { id, enabled, scope, projectLabel, pluginName, readonly, usageCounts, seenNames, seenPaths }) {
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return null;
  const real = safeRealpath(skillMd);
  if (seenPaths.has(real)) return null;

  const raw = readFileSync(skillMd, 'utf8');
  const fm = parseFrontmatter(raw);
  const name = fm.name || id;
  if (enabled && seenNames.has(name)) return null;

  seenPaths.add(real);
  if (enabled) seenNames.add(name);

  return {
    id,
    name,
    description: fm.description || '',
    enabled,
    readonly: Boolean(readonly),
    scope,
    projectLabel: projectLabel || null,
    pluginName: pluginName || null,
    fileUri: pathToFileURL(real).href,
    tokens: Math.round(raw.length / 4),
    descTokens: Math.round(fm.description.length / 4),
    uses60d: usageCounts[id] || usageCounts[name] || 0,
    hasLearnings: existsSync(join(skillDir, 'learnings.md')),
  };
}

function scanDir(dir, opts) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const rec = scanSkillFolder(join(dir, d.name), { ...opts, id: d.name });
    if (rec) out.push(rec);
  }
  return out;
}

function collectPluginSkills(workspacePaths, opts) {
  const out = [];
  const roots = [
    ...workspacePaths.map((ws) => join(ws, '.agents', 'plugins')),
    join(CFG_DIR, 'plugins'),
    join(AGY_DIR, 'builtin', 'plugins'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const pDir = join(root, d.name);
      const manifest = readJsonSafe(join(pDir, 'plugin.json'));
      const pluginName = manifest?.name || d.name;
      out.push(...scanDir(join(pDir, 'skills'), {
        ...opts,
        enabled: true,
        scope: 'plugin',
        pluginName,
        readonly: true,
      }));
      if (existsSync(join(pDir, 'SKILL.md'))) {
        const rec = scanSkillFolder(pDir, {
          ...opts,
          id: d.name,
          enabled: true,
          scope: 'plugin',
          pluginName,
          readonly: true,
        });
        if (rec) out.push(rec);
      }
    }
  }
  return out;
}

export function listLocalSkills(workspacePaths = []) {
  const usageCounts = readUsageCounts(60);
  const seenNames = new Set();
  const seenPaths = new Set();
  const shared = { usageCounts, seenNames, seenPaths };
  const items = [];

  for (const ws of workspacePaths) {
    if (!ws || !existsSync(ws)) continue;
    const label = basename(ws);
    items.push(
      ...scanDir(join(ws, '.agents', 'skills'), { ...shared, enabled: true, scope: 'project', projectLabel: label, readonly: false }),
      ...scanDir(join(ws, '.agents', 'skills-disabled'), { ...shared, enabled: false, scope: 'project', projectLabel: label, readonly: false })
    );
  }

  items.push(
    ...scanDir(GLOBAL_SKILLS, { ...shared, enabled: true, scope: 'global', readonly: false }),
    ...scanDir(GLOBAL_DISABLED, { ...shared, enabled: false, scope: 'global', readonly: false }),
    ...collectPluginSkills(workspacePaths, shared),
    ...scanDir(BUILTIN_SKILLS, { ...shared, enabled: true, scope: 'builtin', readonly: true })
  );

  items.sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.uses60d - a.uses60d || a.id.localeCompare(b.id));
  return {
    skills: items,
    totals: {
      active: items.filter((s) => s.enabled).length,
      disabled: items.filter((s) => !s.enabled).length,
      descTokens: items.filter((s) => s.enabled).reduce((acc, s) => acc + s.descTokens, 0),
    },
  };
}

export function toggleSkill({ id, enable, scope, workspacePath }) {
  if (!SKILL_RE.test(id || '')) throw new Error('Neplatný názov skillu.');
  const base = scope === 'project' && workspacePath ? join(workspacePath, '.agents') : CFG_DIR;
  const activeDir = join(base, 'skills', id);
  const disabledDir = join(base, 'skills-disabled', id);
  const from = enable ? disabledDir : activeDir;
  const to = enable ? activeDir : disabledDir;

  if (!existsSync(from)) throw new Error(`Skill "${id}" nebol nájdený.`);
  if (existsSync(to)) throw new Error(`Cieľ "${to}" už existuje.`);

  mkdirSync(join(base, enable ? 'skills' : 'skills-disabled'), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  return { ok: true, id, enabled: Boolean(enable) };
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'");
}

function stripTags(s) {
  return decodeHtml(String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

export async function searchOnline(query) {
  const q = (query || '').trim();
  const url = `https://www.skillsdirectory.com/skills?sort=stars&grade=A${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'agy-skills-panel' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`skillsdirectory.com HTTP ${res.status}`);
  const html = await res.text();

  const cardRe = /<li><a\b[^>]*href="\/skills\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a><\/li>/g;
  const skills = [];
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const slug = m[1];
    const body = m[2];
    const titleM = body.match(/class="[^"]*text-title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    if (!titleM) continue;
    const gradeM = body.match(/title="Security grade ([A-F][+-]?)"/);
    const descM = body.match(/class="[^"]*line-clamp-2[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const starsM = body.match(/GitHub stars:\s*<\/span>([\d,]+)/);
    skills.push({
      slug,
      name: stripTags(titleM[1]),
      grade: gradeM ? gradeM[1] : 'A',
      description: descM ? stripTags(descM[1]) : '',
      stars: starsM ? Number(starsM[1].replace(/,/g, '')) : 0,
    });
  }

  skills.sort((a, b) => b.stars - a.stars);
  return { skills };
}

export function auditSkillContent(content) {
  const warnings = [];
  for (const check of SECURITY_CHECKS) {
    if (check.re.test(content)) warnings.push(check.msg);
  }
  return warnings;
}

async function resolveFromDirectorySlug(slug) {
  if (!SKILL_RE.test(slug || '')) throw new Error('Neplatný identifikátor skillu.');
  const res = await fetch(`https://www.skillsdirectory.com/skills/${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': 'agy-skills-panel' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`skillsdirectory.com HTTP ${res.status}`);
  const html = await res.text();

  const blobM = html.match(/https:\/\/github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\/blob\/([^/]+)\/([^\s"'<>]*SKILL\.md)/);
  if (blobM) {
    const [, source, branch, relFile] = blobM;
    const folderPath = relFile.includes('/') ? relFile.replace(/\/SKILL\.md$/, '') : '.';
    const rawId = folderPath !== '.' ? basename(folderPath) : slug;
    const skillId = SKILL_RE.test(rawId) ? rawId : slug;
    return { source, branch, relFile, folderPath, skillId };
  }

  const repoM = html.match(/https:\/\/github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/);
  if (repoM) {
    return { source: repoM[1], branch: 'HEAD', relFile: null, folderPath: null, skillId: slug };
  }
  throw new Error(`Nepodarilo sa nájsť GitHub repozitár pre "${slug}".`);
}

export async function previewSkill(source, skillId, slug) {
  if (slug) {
    const resolved = await resolveFromDirectorySlug(slug);
    source = resolved.source;
    skillId = resolved.skillId;
    if (resolved.relFile) {
      const rawUrl = `https://raw.githubusercontent.com/${source}/${resolved.branch}/${resolved.relFile}`;
      const rawRes = await fetch(rawUrl, { signal: AbortSignal.timeout(8000) });
      if (rawRes.ok) {
        const content = await rawRes.text();
        return {
          source,
          skillId,
          folderPath: resolved.folderPath,
          content,
          warnings: auditSkillContent(content),
          tokens: Math.round(content.length / 4),
        };
      }
    }
  }

  if (!SOURCE_RE.test(source || '') || !SKILL_RE.test(skillId || '')) {
    throw new Error('Neplatný formát repozitára alebo názvu skillu.');
  }
  const stripped = skillId.includes('-') ? skillId.replace(/^[^-]+-/, '') : skillId;
  const names = [...new Set([skillId, stripped])];
  const candidates = [];
  for (const n of names) {
    candidates.push(`skills/${n}`, `.agents/skills/${n}`, `.claude/skills/${n}`, n);
  }
  candidates.push('.');

  for (const folder of candidates) {
    const relFile = folder === '.' ? 'SKILL.md' : `${folder}/SKILL.md`;
    const rawUrl = `https://raw.githubusercontent.com/${source}/HEAD/${relFile}`;
    try {
      const res = await fetch(rawUrl, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const content = await res.text();
        return {
          source,
          skillId,
          folderPath: folder,
          content,
          warnings: auditSkillContent(content),
          tokens: Math.round(content.length / 4),
        };
      }
    } catch {}
  }

  // Fallback: inspect GitHub tree
  const treeRes = await fetch(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`, {
    headers: { 'User-Agent': 'agy-skills-panel' },
    signal: AbortSignal.timeout(8000),
  });
  if (treeRes.ok) {
    const tree = await treeRes.json();
    const match = (tree.tree || []).find((t) =>
      names.some((n) => t.path.endsWith(`/${n}/SKILL.md`) || t.path === `${n}/SKILL.md`)
    );
    if (match) {
      const folder = match.path.replace(/\/SKILL\.md$/, '') || '.';
      const rawRes = await fetch(`https://raw.githubusercontent.com/${source}/HEAD/${match.path}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (rawRes.ok) {
        const content = await rawRes.text();
        return {
          source,
          skillId,
          folderPath: folder,
          content,
          warnings: auditSkillContent(content),
          tokens: Math.round(content.length / 4),
        };
      }
    }
  }

  throw new Error(`SKILL.md pre "${skillId}" sa nepodarilo nájsť v ${source}.`);
}

export function installSkill({ source, skillId, folderPath, scope, workspacePath }) {
  if (!SOURCE_RE.test(source || '') || !SKILL_RE.test(skillId || '')) {
    throw new Error('Neplatný formát repozitára alebo názvu skillu.');
  }
  const safeFolder = (folderPath || `skills/${skillId}`).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (safeFolder.includes('..')) throw new Error('Neplatná cesta v repozitári.');

  const targetRoot = scope === 'project' && workspacePath
    ? join(workspacePath, '.agents', 'skills')
    : GLOBAL_SKILLS;
  const targetDir = join(targetRoot, skillId);

  const tmpDir = join(tmpdir(), `agy-skill-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  try {
    const repoUrl = `https://github.com/${source}.git`;
    execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', repoUrl, tmpDir], {
      stdio: 'ignore',
      timeout: 30000,
    });
    if (safeFolder !== '.') {
      execFileSync('git', ['sparse-checkout', 'set', safeFolder], {
        cwd: tmpDir,
        stdio: 'ignore',
        timeout: 15000,
      });
    }
    const srcDir = safeFolder === '.' ? tmpDir : join(tmpDir, safeFolder);
    if (!existsSync(join(srcDir, 'SKILL.md'))) {
      throw new Error('Stiahnutý priečinok neobsahuje SKILL.md.');
    }

    mkdirSync(targetRoot, { recursive: true });
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    cpSync(srcDir, targetDir, { recursive: true });
    // Avoid copying .git if root skill repo
    rmSync(join(targetDir, '.git'), { recursive: true, force: true });

    return { ok: true, id: skillId, path: targetDir };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
