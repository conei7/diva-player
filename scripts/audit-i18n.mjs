#!/usr/bin/env node
/**
 * i18n audit (DESIGN_SPEC §5.9).
 *
 *   node scripts/audit-i18n.mjs                       # whole src/
 *   node scripts/audit-i18n.mjs --files a.tsx b.tsx   # only these files (duplicate checks always run)
 *   node scripts/audit-i18n.mjs --show-dynamic        # also list t(variable) calls that cannot be checked
 *   node scripts/audit-i18n.mjs --json                # machine-readable output
 *   node scripts/audit-i18n.mjs --root <dir>          # audit another checkout (src/i18n.ts, src/i18n-en.ts, src/**)
 *
 * Reports, with repo-relative file:line:
 *   1. source-text calls t('原文') whose text is missing from englishSourceText (src/i18n-en.ts)
 *   2. keyed calls t('key') whose key is missing from the English messages (or from messages.ja)
 *   3. duplicate keys in englishSourceText / messages.ja / English messages, and keys that exist in only one of messages.ja / English messages
 * Exits with 1 when anything is found.
 *
 * Translators are recognized by how they are created, per scope:
 *   const t = useTranslateSourceText()  → source text      const t = useTranslate() → key
 *   (ts: SourceTextTranslator) / (t: (source: string) => string) parameters → source text
 *   (t: (key: TranslationKey) => string) parameters → key
 *   translateSourceText(language, '原文') / translate(language, 'key') imported from i18n
 * Only literal arguments are checked (also both branches of `cond ? 'a' : 'b'` and literal operands of ?? / ||).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const options = parseArgs(process.argv.slice(2));
// --root <dir> points the audit at another checkout (used to test the script itself).
const repoRoot = options.root ? resolve(options.root) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolve(repoRoot, 'src');
const jaPath = resolve(srcRoot, 'i18n.ts');
const enPath = resolve(srcRoot, 'i18n-en.ts');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

function toRepoPath(file) {
  return relative(repoRoot, file).split(sep).join('/');
}

function parseArgs(argv) {
  const options = { files: null, showDynamic: false, json: false, root: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' && index + 1 < argv.length) {
      options.root = argv[index + 1];
      index += 1;
    } else if (arg === '--files') {
      options.files = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        options.files.push(argv[index + 1]);
        index += 1;
      }
    } else if (arg.startsWith('--files=')) {
      options.files = arg.slice('--files='.length).split(',').filter(Boolean);
    } else if (arg === '--show-dynamic') {
      options.showDynamic = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/audit-i18n.mjs [--files <file>...] [--show-dynamic] [--json] [--root <repo>]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function parseFile(file) {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/** Keys of an object literal with their lines, plus duplicates. */
function readObjectKeys(sourceFile, objectLiteral) {
  const keys = new Map();
  const duplicates = [];
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name === null) continue;
    const line = lineOf(sourceFile, property);
    if (keys.has(name)) duplicates.push({ key: name, line, firstLine: keys.get(name) });
    else keys.set(name, line);
  }
  return { keys, duplicates };
}

function unwrapExpression(expression) {
  let current = expression;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression?.(current) || ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression?.(current))) {
    current = current.expression;
  }
  return current;
}

function findVariableObject(sourceFile, variableName) {
  let found = null;
  const visit = node => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (initializer && ts.isObjectLiteralExpression(initializer)) found = initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function loadCatalogs() {
  const jaFile = parseFile(jaPath);
  const enFile = parseFile(enPath);
  const jaMessagesRoot = findVariableObject(jaFile, 'messages');
  const jaObject = jaMessagesRoot?.properties
    .find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === 'ja');
  const jaInitializer = jaObject && ts.isPropertyAssignment(jaObject) ? unwrapExpression(jaObject.initializer) : null;
  const enMessages = findVariableObject(enFile, 'messages');
  const englishSourceText = findVariableObject(enFile, 'englishSourceText');
  if (!jaInitializer || !ts.isObjectLiteralExpression(jaInitializer) || !enMessages || !englishSourceText) {
    throw new Error('Could not find messages.ja (src/i18n.ts) or messages / englishSourceText (src/i18n-en.ts)');
  }
  return {
    ja: readObjectKeys(jaFile, jaInitializer),
    en: readObjectKeys(enFile, enMessages),
    source: readObjectKeys(enFile, englishSourceText),
  };
}

function walkSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walkSourceFiles(path));
    else files.push(path);
  }
  return files;
}

function isAuditedSourceFile(file) {
  if (!SOURCE_EXTENSIONS.has(extname(file))) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.endsWith('.d.ts')) return false;
  return file !== jaPath && file !== enPath;
}

function resolveRequestedFiles(requested) {
  const files = [];
  const missing = [];
  for (const item of requested) {
    const candidates = isAbsolute(item) ? [item] : [resolve(process.cwd(), item), resolve(repoRoot, item)];
    const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
    if (found) files.push(resolve(found));
    else missing.push(item);
  }
  return { files: [...new Set(files)], missing };
}

/** 'source' | 'key' | null for a translator-like type annotation. */
function kindFromType(typeNode) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    if (name === 'SourceTextTranslator') return 'source';
    if (name === 'ReturnType' && typeNode.typeArguments?.length === 1) {
      const argument = typeNode.typeArguments[0];
      if (ts.isTypeQueryNode(argument)) {
        const queried = argument.exprName.getText();
        if (queried === 'useTranslateSourceText') return 'source';
        if (queried === 'useTranslate') return 'key';
      }
    }
    return null;
  }
  if (ts.isFunctionTypeNode(typeNode)) {
    const first = typeNode.parameters[0]?.type;
    if (!first) return null;
    if (first.kind === ts.SyntaxKind.StringKeyword) return 'source';
    if (ts.isTypeReferenceNode(first) && first.typeName.getText() === 'TranslationKey') return 'key';
  }
  return null;
}

function kindFromInitializer(initializer) {
  const expression = unwrapExpression(initializer);
  if (expression && ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    if (expression.expression.text === 'useTranslateSourceText') return 'source';
    if (expression.expression.text === 'useTranslate') return 'key';
  }
  return null;
}

/** Find the declaration of `name` visible at `node` and tell whether it is a translator. */
function resolveTranslator(node, name) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      for (const parameter of current.parameters ?? []) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return kindFromType(parameter.type);
      }
    }
    const statements = current.statements;
    if (Array.isArray(statements) || (statements && typeof statements.length === 'number')) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return kindFromInitializer(declaration.initializer) ?? kindFromType(declaration.type);
          }
        }
      }
    }
    current = current.parent;
  }
  return null;
}

/** Literal strings an argument can evaluate to, or null when part of it is dynamic. */
function literalValues(expression) {
  const node = unwrapExpression(expression);
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalValues(node.whenTrue);
    const whenFalse = literalValues(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    // `value ?? 'fallback'`: only the literal fallback can be checked.
    return literalValues(node.right);
  }
  return null;
}

function importedI18nFunctions(sourceFile) {
  const names = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(^|\/)i18n$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'translateSourceText') names.set(element.name.text, 'source');
      if (imported === 'translate') names.set(element.name.text, 'key');
    }
  }
  return names;
}

function collectCalls(file) {
  const sourceFile = parseFile(file);
  const directFunctions = importedI18nFunctions(sourceFile);
  const calls = [];
  const dynamic = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      let kind = null;
      let argument = null;
      if (directFunctions.has(name)) {
        kind = directFunctions.get(name);
        argument = node.arguments[1];
      } else if (node.arguments.length > 0) {
        kind = resolveTranslator(node, name);
        argument = node.arguments[0];
      }
      if (kind && argument) {
        const line = lineOf(sourceFile, node);
        const values = literalValues(argument);
        // An empty string translates to itself and needs no entry.
        if (values) for (const value of values) { if (value !== '') calls.push({ kind, value, line }); }
        else dynamic.push({ kind, line, expression: argument.getText(sourceFile).slice(0, 80) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { calls, dynamic };
}

function main() {
  const catalogs = loadCatalogs();

  let files;
  let missingFiles = [];
  if (options.files) {
    const resolved = resolveRequestedFiles(options.files);
    files = resolved.files.filter(file => SOURCE_EXTENSIONS.has(extname(file)) && file !== jaPath && file !== enPath);
    missingFiles = resolved.missing;
  } else {
    files = walkSourceFiles(srcRoot).filter(isAuditedSourceFile);
  }

  const missingSource = [];
  const missingKeys = [];
  const dynamicCalls = [];
  for (const file of files.sort()) {
    const { calls, dynamic } = collectCalls(file);
    const path = toRepoPath(file);
    for (const call of calls) {
      if (call.kind === 'source' && !catalogs.source.keys.has(call.value)) {
        missingSource.push({ file: path, line: call.line, text: call.value });
      }
      if (call.kind === 'key' && (!catalogs.en.keys.has(call.value) || !catalogs.ja.keys.has(call.value))) {
        missingKeys.push({
          file: path,
          line: call.line,
          key: call.value,
          missingIn: [!catalogs.ja.keys.has(call.value) && 'messages.ja', !catalogs.en.keys.has(call.value) && 'English messages'].filter(Boolean),
        });
      }
    }
    for (const call of dynamic) dynamicCalls.push({ file: path, ...call });
  }

  const duplicates = [
    ...catalogs.source.duplicates.map(item => ({ table: 'englishSourceText', file: 'src/i18n-en.ts', ...item })),
    ...catalogs.ja.duplicates.map(item => ({ table: 'messages.ja', file: 'src/i18n.ts', ...item })),
    ...catalogs.en.duplicates.map(item => ({ table: 'messages (English)', file: 'src/i18n-en.ts', ...item })),
  ];
  const keyMismatches = [
    ...[...catalogs.ja.keys].filter(([key]) => !catalogs.en.keys.has(key))
      .map(([key, line]) => ({ key, file: 'src/i18n.ts', line, problem: 'missing from English messages' })),
    ...[...catalogs.en.keys].filter(([key]) => !catalogs.ja.keys.has(key))
      .map(([key, line]) => ({ key, file: 'src/i18n-en.ts', line, problem: 'missing from messages.ja' })),
  ];

  // Files passed to --files that do not exist (for example deleted ones) are only listed, not counted.
  const problemCount = missingSource.length + missingKeys.length + duplicates.length + keyMismatches.length;

  if (options.json) {
    console.log(JSON.stringify({
      scannedFiles: files.length,
      missingSource,
      missingKeys,
      duplicates,
      keyMismatches,
      missingFiles,
      dynamicCalls: options.showDynamic ? dynamicCalls : dynamicCalls.length,
    }, null, 2));
  } else {
    const section = (title, items, format) => {
      if (items.length === 0) return;
      console.log(`\n== ${title} (${items.length}) ==`);
      for (const item of items) console.log(format(item));
    };
    section('Files not found (skipped)', missingFiles, item => `  ${item}`);
    section('Source texts missing from englishSourceText', missingSource, item => `  ${item.file}:${item.line}  ${JSON.stringify(item.text)}`);
    section('Translation keys missing', missingKeys, item => `  ${item.file}:${item.line}  ${item.key}  (not in ${item.missingIn.join(', ')})`);
    section('Duplicate keys', duplicates, item => `  ${item.file}:${item.line}  ${item.table}  ${JSON.stringify(item.key)}  (first at line ${item.firstLine})`);
    section('messages.ja / English messages mismatch', keyMismatches, item => `  ${item.file}:${item.line}  ${item.key}  ${item.problem}`);
    if (options.showDynamic) section('Dynamic t() calls (not checked)', dynamicCalls, item => `  ${item.file}:${item.line}  [${item.kind}] ${item.expression}`);
    console.log(`\naudit-i18n: ${files.length} files — ${missingSource.length} missing source texts, ${missingKeys.length} missing keys, ${duplicates.length} duplicate keys, ${keyMismatches.length} ja/en key mismatches${missingFiles.length ? ` (${missingFiles.length} files not found, skipped)` : ''}; ${dynamicCalls.length} dynamic calls not checked${options.showDynamic ? '' : ' (--show-dynamic to list)'}`);
  }

  process.exitCode = problemCount > 0 ? 1 : 0;
}

main();
