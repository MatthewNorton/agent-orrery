'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./shared/atomic-write');
const { validGoalId } = require('./shared/ids');

const TASK_LINE = /^(\s*)([-*])([ \t]+)\[([ xX])\]([ \t]+)(.*)$/;
const ASSIGNED_GOAL_SUFFIX = /^(.*?)([ \t]+<!--\s*agent-universe:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->[ \t]*)$/i;

function splitSourceLines(text) {
  const source = String(text);
  const lines = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== '\n' && source[index] !== '\r') continue;
    let end = index + 1;
    if (source[index] === '\r' && source[end] === '\n') end++;
    lines.push({ content: source.slice(start, index), ending: source.slice(index, end) });
    start = end;
    index = end - 1;
  }
  if (start < source.length) lines.push({ content: source.slice(start), ending: '' });
  return lines;
}

function matchTask(content) {
  const match = TASK_LINE.exec(content);
  if (!match) return null;
  const assigned = ASSIGNED_GOAL_SUFFIX.exec(match[6]);
  return {
    indent: match[1],
    bullet: match[2],
    bulletSpace: match[3],
    mark: match[4],
    textSpace: match[5],
    text: assigned ? assigned[1] : match[6],
    assignedSuffix: assigned ? assigned[2] : '',
    id: assigned ? assigned[3].toLowerCase() : null,
    done: match[4].toLowerCase() === 'x',
  };
}

function parseGoals(text) {
  const lines = splitSourceLines(text == null ? '' : text);
  const items = [];
  lines.forEach((line, index) => {
    const task = matchTask(line.content);
    if (task) {
      items.push({
        text: task.text,
        done: task.done,
        line: index,
        ...(task.id ? { id: task.id } : {}),
      });
    }
  });
  return { items };
}

function preferredEnding(lines) {
  const found = lines.find((line) => line.ending);
  return found ? found.ending : '\n';
}

function canonicalTask(item) {
  const id = validGoalId(item && item.id) ? String(item.id).toLowerCase() : null;
  const suffix = id ? ` <!-- agent-universe:${id} -->` : '';
  return `- [${item.done ? 'x' : ' '}] ${String(item.text)}${suffix}`;
}

function serializeGoals(originalText, items) {
  const source = originalText == null ? '' : String(originalText);
  const nextItems = Array.isArray(items) ? items : [];
  if (!source) {
    if (nextItems.length === 0) return source;
    return '# Goals\n\n' + nextItems.map(canonicalTask).join('\n');
  }

  const lines = splitSourceLines(source);
  const originalHadFinalEnding = lines.length > 0 && Boolean(lines[lines.length - 1].ending);
  const ending = preferredEnding(lines);
  const additions = [];

  for (const item of nextItems) {
    const lineNumber = Number.isSafeInteger(item && item.line) ? item.line : null;
    if (lineNumber == null) {
      additions.push(item);
      continue;
    }
    const line = lines[lineNumber];
    const task = line && matchTask(line.content);
    if (!task) continue;
    const text = String(item.text);
    const done = Boolean(item.done);
    const suppliedId = validGoalId(item.id) ? String(item.id).toLowerCase() : null;
    if (task.id && suppliedId && suppliedId !== task.id) {
      throw new Error('Goal id cannot be changed');
    }
    const effectiveId = suppliedId || task.id;
    if (task.text === text && task.done === done && effectiveId === task.id) continue;
    const mark = done ? (task.done ? task.mark : 'x') : ' ';
    const suffix = task.assignedSuffix || (
      effectiveId ? ` <!-- agent-universe:${effectiveId} -->` : ''
    );
    line.content = `${task.indent}${task.bullet}${task.bulletSpace}[${mark}]${task.textSpace}${text}${suffix}`;
  }

  if (additions.length > 0) {
    let lastTask = -1;
    lines.forEach((line, index) => { if (matchTask(line.content)) lastTask = index; });
    const insertion = lastTask >= 0 ? lastTask + 1 : lines.length;
    if (insertion === lines.length && lines.length > 0 && !lines[lines.length - 1].ending) {
      lines[lines.length - 1].ending = ending;
    }
    const newLines = additions.map((item, index) => ({
      content: canonicalTask(item),
      ending: insertion < lines.length || index < additions.length - 1 || originalHadFinalEnding
        ? ending
        : '',
    }));
    lines.splice(insertion, 0, ...newLines);
  }

  return lines.map((line) => line.content + line.ending).join('');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' &&
    !path.isAbsolute(relative);
}

function resolveGoalsPath(projectRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('Project root must be absolute');
  }
  const root = fs.realpathSync.native(projectRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('Project root is not a directory');
  const goalsPath = path.resolve(root, 'GOALS.md');
  if (!isInside(root, goalsPath)) throw new Error('GOALS.md escapes the project root');

  try {
    const stat = fs.lstatSync(goalsPath);
    if (stat.isSymbolicLink()) throw new Error('GOALS.md symlinks are not trusted');
    const real = fs.realpathSync.native(goalsPath);
    if (!isInside(root, real)) throw new Error('GOALS.md escapes the project root');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return { root, goalsPath };
}

function readGoalsFile(projectRoot) {
  const { goalsPath } = resolveGoalsPath(projectRoot);
  try {
    const stat = fs.statSync(goalsPath);
    if (!stat.isFile()) throw new Error('GOALS.md is not a file');
    const originalText = fs.readFileSync(goalsPath, 'utf8');
    return { exists: true, path: goalsPath, originalText, items: parseGoals(originalText).items };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, path: goalsPath, originalText: null, items: [] };
    }
    throw error;
  }
}

function normalizeGoalItems(items) {
  if (!Array.isArray(items) || items.length > 10_000) throw new Error('Invalid goal items');
  const seenLines = new Set();
  const seenIds = new Set();
  return items.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string' ||
        item.text.length > 10_000 || /[\r\n\0]/.test(item.text) || typeof item.done !== 'boolean') {
      throw new Error('Invalid goal item');
    }
    const normalized = { text: item.text, done: item.done };
    if (item.id != null) {
      if (!validGoalId(item.id)) throw new Error('Invalid goal id');
      normalized.id = item.id.toLowerCase();
      if (seenIds.has(normalized.id)) throw new Error('Duplicate goal id');
      seenIds.add(normalized.id);
    }
    if (item.line != null) {
      if (!Number.isSafeInteger(item.line) || item.line < 0 || seenLines.has(item.line)) {
        throw new Error('Invalid goal line');
      }
      seenLines.add(item.line);
      normalized.line = item.line;
    }
    return normalized;
  });
}

function writeGoalsFile(projectRoot, items) {
  const normalized = normalizeGoalItems(items);
  const before = readGoalsFile(projectRoot);
  const { root, goalsPath } = resolveGoalsPath(projectRoot);
  const nextText = serializeGoals(before.originalText, normalized);
  writeFileAtomic(goalsPath, nextText);
  return readGoalsFile(root);
}

function ensureAssignedGoal(projectRoot, item) {
  const assigned = normalizeAssignedGoal(item);
  const { id } = assigned;
  const before = readGoalsFile(projectRoot);
  const existing = before.items.find((goal) => goal.id === id);
  if (existing) {
    if (existing.text !== assigned.text) throw new Error('Assigned goal id collision');
    return { ...before, item: existing, created: false };
  }
  // Pass only the addition so a concurrent external edit to an existing task
  // is never rewritten from this earlier snapshot.
  const after = writeGoalsFile(projectRoot, [{ id, text: assigned.text, done: false }]);
  const created = after.items.find((goal) => goal.id === id);
  if (!created) throw new Error('Assigned goal was not persisted');
  return { ...after, item: created, created: true };
}

function completeAssignedGoal(projectRoot, item) {
  const assigned = normalizeAssignedGoal(item);
  const before = readGoalsFile(projectRoot);
  const matches = before.items
    .map((goal, index) => ({ goal, index }))
    .filter((entry) => entry.goal.id === assigned.id);
  const index = matches.length === 1 ? matches[0].index : -1;
  const goal = index >= 0 ? before.items[index] : null;
  if (!goal || goal.text !== assigned.text) throw new Error('Assigned goal changed');
  if (goal.done) return { ...before, item: goal, changed: false };

  const nextItems = before.items.map((entry, itemIndex) => (
    itemIndex === index ? { ...entry, done: true } : entry
  ));
  const nextText = serializeGoals(before.originalText, nextItems);
  replaceGoalsIfUnchanged(projectRoot, before, nextText);
  const after = readGoalsFile(projectRoot);
  const completed = after.items.find((entry) => entry.id === assigned.id);
  if (!completed || !completed.done || completed.text !== assigned.text) {
    throw new Error('Assigned goal was not completed');
  }
  return { ...after, item: completed, changed: true };
}

function appendGoal(projectRoot, text) {
  const normalized = normalizeGoalItems([{ text, done: false }])[0];
  if (normalized.text.trim().length === 0) throw new Error('Goal text is empty');
  const after = writeGoalsFile(projectRoot, [normalized]);
  const item = after.items[after.items.length - 1];
  return { ...after, item, changed: true };
}

function setGoalDone(projectRoot, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.text !== 'string' || request.text.length > 10_000 ||
      /[\r\n\0]/.test(request.text) || typeof request.done !== 'boolean') {
    throw new Error('Invalid goal update');
  }
  const before = readGoalsFile(projectRoot);
  let index = -1;
  if (request.id != null) {
    if (!validGoalId(request.id)) throw new Error('Invalid goal id');
    const id = request.id.toLowerCase();
    const matches = before.items
      .map((goal, itemIndex) => ({ goal, itemIndex }))
      .filter((entry) => entry.goal.id === id);
    if (matches.length === 1) index = matches[0].itemIndex;
  } else if (Number.isSafeInteger(request.line) && request.line >= 0) {
    index = before.items.findIndex((goal) => goal.line === request.line && !goal.id);
  }
  const goal = index >= 0 ? before.items[index] : null;
  if (!goal || goal.text !== request.text) throw new Error('Goal changed');
  if (goal.done === request.done) return { ...before, item: goal, changed: false };
  const nextItems = before.items.map((entry, itemIndex) => (
    itemIndex === index ? { ...entry, done: request.done } : entry
  ));
  const nextText = serializeGoals(before.originalText, nextItems);
  replaceGoalsIfUnchanged(projectRoot, before, nextText);
  const after = readGoalsFile(projectRoot);
  const updated = request.id
    ? after.items.find((entry) => entry.id === request.id.toLowerCase())
    : after.items.find((entry) => entry.line === request.line && !entry.id);
  if (!updated || updated.text !== request.text || updated.done !== request.done) {
    throw new Error('Goal was not updated');
  }
  return { ...after, item: updated, changed: true };
}

function removeGoal(projectRoot, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      request.id != null || !Number.isSafeInteger(request.line) || request.line < 0 ||
      typeof request.text !== 'string' || request.text.length > 10_000 ||
      /[\r\n\0]/.test(request.text)) {
    throw new Error('Invalid goal removal');
  }
  const before = readGoalsFile(projectRoot);
  const goal = before.items.find((entry) => (
    entry.line === request.line && !entry.id && entry.text === request.text
  ));
  if (!goal) throw new Error('Goal changed');

  const lines = splitSourceLines(before.originalText);
  const sourceLine = lines[goal.line];
  const sourceGoal = sourceLine && matchTask(sourceLine.content);
  if (!sourceGoal || sourceGoal.id || sourceGoal.text !== goal.text) {
    throw new Error('Goal changed');
  }
  lines.splice(goal.line, 1);
  const nextText = lines.map((line) => line.content + line.ending).join('');
  replaceGoalsIfUnchanged(projectRoot, before, nextText);
  const after = readGoalsFile(projectRoot);
  if (after.items.length !== before.items.length - 1) {
    throw new Error('Goal was not removed');
  }
  return { ...after, item: goal, changed: true };
}

function replaceGoalsIfUnchanged(projectRoot, before, nextText) {
  const { root, goalsPath } = resolveGoalsPath(projectRoot);
  writeFileAtomic(goalsPath, nextText, {
    beforeRename() {
      const current = readGoalsFile(root);
      if (current.path !== goalsPath || current.originalText !== before.originalText) {
        throw new Error('GOALS.md changed during completion');
      }
    },
  });
}

function normalizeAssignedGoal(item) {
  if (!item || typeof item !== 'object' || !validGoalId(item.id) ||
      typeof item.text !== 'string' || item.text.length === 0 || item.text.length > 10_000 ||
      /[\r\n\0]/.test(item.text) || /<!--\s*agent-universe:/i.test(item.text)) {
    throw new Error('Invalid assigned goal');
  }
  return { id: item.id.toLowerCase(), text: item.text };
}

module.exports = {
  parseGoals,
  serializeGoals,
  readGoalsFile,
  writeGoalsFile,
  ensureAssignedGoal,
  completeAssignedGoal,
  appendGoal,
  setGoalDone,
  removeGoal,
  validGoalId,
};
