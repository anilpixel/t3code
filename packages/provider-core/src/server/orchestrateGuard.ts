// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return NodeOS.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function canonicalizeWithExistingAncestor(resolvedPath: string): string {
  const normalized = NodePath.resolve(resolvedPath);
  const trailingSegments: Array<string> = [];
  let current = normalized;
  while (true) {
    try {
      if (NodeFS.existsSync(current)) {
        const realCurrent = NodeFS.realpathSync.native(current);
        return trailingSegments.length === 0
          ? realCurrent
          : NodePath.join(realCurrent, ...trailingSegments.toReversed());
      }
    } catch {
      return normalized;
    }
    const parent = NodePath.dirname(current);
    if (parent === current) {
      return normalized;
    }
    trailingSegments.push(NodePath.basename(current));
    current = parent;
  }
}

function resolveCandidatePath(targetPath: string, cwd: string | null): string {
  const expanded = expandHome(targetPath.trim());
  const baseDir = cwd !== null && cwd.trim().length > 0 ? expandHome(cwd.trim()) : process.cwd();
  const absolute = NodePath.isAbsolute(expanded)
    ? NodePath.resolve(expanded)
    : NodePath.resolve(baseDir, expanded);
  return canonicalizeWithExistingAncestor(absolute);
}

export function isPathWithinProtectedRoots(
  targetPath: string,
  cwd: string | null,
  protectedWorkspaceRoots: ReadonlyArray<string>,
): string | null {
  if (protectedWorkspaceRoots.length === 0) return null;
  const trimmed = targetPath.trim();
  if (trimmed.length === 0) return null;
  const candidate = resolveCandidatePath(trimmed, cwd);
  for (const rawRoot of protectedWorkspaceRoots) {
    if (rawRoot.trim().length === 0) continue;
    const canonicalRoot = canonicalizeWithExistingAncestor(expandHome(rawRoot.trim()));
    if (
      candidate === canonicalRoot ||
      candidate.startsWith(
        canonicalRoot.endsWith(NodePath.sep) ? canonicalRoot : `${canonicalRoot}${NodePath.sep}`,
      )
    ) {
      return rawRoot;
    }
  }
  return null;
}

function formatProtectedRootWriteDenial(matchedRoot: string): string {
  return `Direct writes inside project workspace '${matchedRoot}' are blocked in Orchestrate mode. Delegate code or repository changes with delegate_task (pass continueTaskId to follow up on an existing subagent's branch).`;
}

export function checkOrchestrateFilePaths(
  paths: ReadonlyArray<string>,
  cwd: string | null,
  protectedWorkspaceRoots: ReadonlyArray<string>,
): string | null {
  if (protectedWorkspaceRoots.length === 0) return null;
  for (const candidatePath of paths) {
    const matchedRoot = isPathWithinProtectedRoots(candidatePath, cwd, protectedWorkspaceRoots);
    if (matchedRoot !== null) {
      return formatProtectedRootWriteDenial(matchedRoot);
    }
  }
  return null;
}

function extractApplyPatchPaths(patchText: string): ReadonlyArray<string> {
  const paths: Array<string> = [];
  for (const rawLine of patchText.split(/\r?\n/u)) {
    const applyHeader = /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s+(.+?)\s*$/u.exec(
      rawLine,
    );
    if (applyHeader?.[1] !== undefined) {
      paths.push(applyHeader[1]);
      continue;
    }
    const unifiedHeader = /^(?:\+\+\+|---)\s+(.+?)\s*$/u.exec(rawLine);
    if (unifiedHeader?.[1] !== undefined) {
      const rawTarget = unifiedHeader[1].split("\t")[0]?.trim() ?? "";
      if (rawTarget === "/dev/null" || rawTarget.length === 0) continue;
      const stripped =
        rawTarget.startsWith("a/") || rawTarget.startsWith("b/") ? rawTarget.slice(2) : rawTarget;
      if (stripped.length > 0) {
        paths.push(stripped);
      }
    }
  }
  return paths;
}

interface ParsedSegment {
  readonly argv: ReadonlyArray<string>;
  readonly redirectTargets: ReadonlyArray<string>;
  readonly substitutions: ReadonlyArray<string>;
}

const REDIRECT_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>", "1>", "1>>", "2>", "2>>"]);

function parseShellSegments(command: string): ReadonlyArray<ParsedSegment> {
  const segments: Array<{
    argv: Array<string>;
    redirectTargets: Array<string>;
    substitutions: Array<string>;
  }> = [{ argv: [], redirectTargets: [], substitutions: [] }];

  let currentToken = "";
  let tokenStarted = false;
  let expectingRedirectTarget = false;

  const flushToken = () => {
    if (!tokenStarted) return;
    const active = segments[segments.length - 1]!;
    if (expectingRedirectTarget) {
      active.redirectTargets.push(currentToken);
      expectingRedirectTarget = false;
    } else {
      active.argv.push(currentToken);
    }
    currentToken = "";
    tokenStarted = false;
  };

  const pushSeparator = () => {
    flushToken();
    expectingRedirectTarget = false;
    if (
      segments[segments.length - 1]!.argv.length > 0 ||
      segments[segments.length - 1]!.redirectTargets.length > 0 ||
      segments[segments.length - 1]!.substitutions.length > 0
    ) {
      segments.push({ argv: [], redirectTargets: [], substitutions: [] });
    }
  };

  const readCommandSubstitution = (startIndex: number): { content: string; nextIndex: number } => {
    let depth = 1;
    let index = startIndex;
    let content = "";
    while (index < command.length && depth > 0) {
      const ch = command[index]!;
      if (ch === "\\") {
        content += ch;
        if (index + 1 < command.length) {
          content += command[index + 1]!;
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }
      if (ch === "'") {
        content += ch;
        index += 1;
        while (index < command.length && command[index] !== "'") {
          content += command[index]!;
          index += 1;
        }
        if (index < command.length) {
          content += command[index]!;
          index += 1;
        }
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          return { content, nextIndex: index + 1 };
        }
      }
      content += ch;
      index += 1;
    }
    return { content, nextIndex: index };
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "'") {
      tokenStarted = true;
      i += 1;
      while (i < command.length && command[i] !== "'") {
        currentToken += command[i]!;
        i += 1;
      }
      if (i < command.length) i += 1;
      continue;
    }
    if (ch === '"') {
      tokenStarted = true;
      i += 1;
      while (i < command.length && command[i] !== '"') {
        const inner = command[i]!;
        if (inner === "\\" && i + 1 < command.length) {
          currentToken += command[i + 1]!;
          i += 2;
          continue;
        }
        if (inner === "$" && command[i + 1] === "(") {
          const sub = readCommandSubstitution(i + 2);
          segments[segments.length - 1]!.substitutions.push(sub.content);
          i = sub.nextIndex;
          continue;
        }
        if (inner === "`") {
          i += 1;
          let subContent = "";
          while (i < command.length && command[i] !== "`") {
            if (command[i] === "\\" && i + 1 < command.length) {
              subContent += command[i + 1]!;
              i += 2;
              continue;
            }
            subContent += command[i]!;
            i += 1;
          }
          if (i < command.length) i += 1;
          segments[segments.length - 1]!.substitutions.push(subContent);
          continue;
        }
        currentToken += inner;
        i += 1;
      }
      if (i < command.length) i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      tokenStarted = true;
      currentToken += command[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      tokenStarted = true;
      const sub = readCommandSubstitution(i + 2);
      segments[segments.length - 1]!.substitutions.push(sub.content);
      i = sub.nextIndex;
      continue;
    }
    if (ch === "`") {
      tokenStarted = true;
      i += 1;
      let subContent = "";
      while (i < command.length && command[i] !== "`") {
        if (command[i] === "\\" && i + 1 < command.length) {
          subContent += command[i + 1]!;
          i += 2;
          continue;
        }
        subContent += command[i]!;
        i += 1;
      }
      if (i < command.length) i += 1;
      segments[segments.length - 1]!.substitutions.push(subContent);
      continue;
    }
    if (ch === "#" && !tokenStarted) {
      while (i < command.length && command[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "\n" || ch === ";") {
      pushSeparator();
      i += 1;
      continue;
    }
    if (ch === "|" || ch === "&") {
      if (ch === "&" && command[i + 1] === ">") {
        flushToken();
        if (command[i + 2] === ">") {
          expectingRedirectTarget = true;
          i += 3;
        } else {
          expectingRedirectTarget = true;
          i += 2;
        }
        continue;
      }
      if (command[i + 1] === ch) {
        pushSeparator();
        i += 2;
        continue;
      }
      pushSeparator();
      i += 1;
      continue;
    }
    if ((ch === "1" || ch === "2") && !tokenStarted && command[i + 1] === ">") {
      if (command[i + 2] === "&") {
        // fd duplication like 2>&1
        i += 3;
        while (i < command.length && /\d/u.test(command[i]!)) i += 1;
        continue;
      }
      expectingRedirectTarget = true;
      i += command[i + 2] === ">" ? 3 : 2;
      continue;
    }
    if (ch === ">") {
      flushToken();
      if (command[i + 1] === "&") {
        i += 2;
        while (i < command.length && !/\s|[;|&]/u.test(command[i]!)) i += 1;
        continue;
      }
      if (command[i + 1] === ">" || command[i + 1] === "|") {
        expectingRedirectTarget = true;
        i += 2;
      } else {
        expectingRedirectTarget = true;
        i += 1;
      }
      continue;
    }
    if (/\s/u.test(ch)) {
      flushToken();
      i += 1;
      continue;
    }
    tokenStarted = true;
    currentToken += ch;
    i += 1;
  }
  flushToken();
  return segments.filter(
    (segment) =>
      segment.argv.length > 0 ||
      segment.redirectTargets.length > 0 ||
      segment.substitutions.length > 0,
  );
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const TRANSPARENT_WRAPPERS = new Set(["env", "command", "nohup", "nice"]);

function stripLeadingCommandWrappers(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (ENV_ASSIGNMENT_RE.test(token)) {
      index += 1;
      continue;
    }
    const base = NodePath.basename(token);
    if (TRANSPARENT_WRAPPERS.has(base)) {
      index += 1;
      while (index < argv.length && argv[index]!.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (base === "timeout") {
      index += 1;
      while (index < argv.length && argv[index]!.startsWith("-")) {
        index += 1;
      }
      if (index < argv.length) index += 1; // duration
      continue;
    }
    break;
  }
  return argv.slice(index);
}

function extractPositionalArgs(
  args: ReadonlyArray<string>,
  flagsWithValue: ReadonlySet<string>,
): ReadonlyArray<string> {
  const positional: Array<string> = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) {
      if (flagsWithValue.has(arg)) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    positional.push(arg);
    index += 1;
  }
  return positional;
}

const GH_FLAGS_WITH_VALUE = new Set([
  "-R",
  "--repo",
  "--hostname",
  "-H",
  "-X",
  "--method",
  "-F",
  "-f",
  "--jq",
  "-q",
]);

function checkUnattendedMergeCommand(argv: ReadonlyArray<string>): string | null {
  if (argv.length === 0) return null;
  const bin = NodePath.basename(argv[0]!);
  const rest = argv.slice(1);
  if (bin === "gh") {
    const positional = extractPositionalArgs(rest, GH_FLAGS_WITH_VALUE);
    if (positional[0] === "pr" && positional[1] === "merge") {
      return "Merging pull requests ('gh pr merge') is blocked during unattended wakes. Leave the PR ready and surface it for user confirmation.";
    }
    if (positional[0] === "api") {
      const endpoint = positional[1] ?? "";
      const hasGetMethod = rest.some(
        (token, idx) =>
          ((token === "-X" || token === "--method") && rest[idx + 1]?.toUpperCase() === "GET") ||
          token.toUpperCase() === "-XGET",
      );
      if (/\/pulls\/\d+\/merge\b/iu.test(endpoint) && !hasGetMethod) {
        return "Merging pull requests via 'gh api .../pulls/.../merge' is blocked during unattended wakes. Leave the PR ready and surface it for user confirmation.";
      }
    }
  }
  if (bin === "glab") {
    const positional = extractPositionalArgs(rest, GH_FLAGS_WITH_VALUE);
    if (positional[0] === "mr" && positional[1] === "merge") {
      return "Merging merge requests ('glab mr merge') is blocked during unattended wakes. Leave the MR ready and surface it for user confirmation.";
    }
  }
  if (bin === "tea") {
    const positional = extractPositionalArgs(rest, GH_FLAGS_WITH_VALUE);
    if (
      (positional[0] === "pr" || positional[0] === "pull" || positional[0] === "pulls") &&
      positional[1] === "merge"
    ) {
      return "Merging pull requests ('tea pr merge') is blocked during unattended wakes. Leave the PR ready and surface it for user confirmation.";
    }
  }
  return null;
}

const MUTATING_GIT_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "checkout",
]);

function checkGitWorkspaceMutation(
  args: ReadonlyArray<string>,
  currentCwd: string | null,
  protectedWorkspaceRoots: ReadonlyArray<string>,
): string | null {
  let effectiveCwd = currentCwd;
  let subcommand: string | null = null;
  let subcommandArgs: ReadonlyArray<string> = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "-C" && i + 1 < args.length) {
      effectiveCwd = resolveCandidatePath(args[i + 1]!, effectiveCwd);
      i += 2;
      continue;
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      effectiveCwd = resolveCandidatePath(arg.slice(2), effectiveCwd);
      i += 1;
      continue;
    }
    if (
      (arg === "-c" ||
        arg === "--git-dir" ||
        arg === "--work-tree" ||
        arg === "--namespace" ||
        arg === "--config-env") &&
      i + 1 < args.length
    ) {
      if (arg === "--work-tree") {
        effectiveCwd = resolveCandidatePath(args[i + 1]!, effectiveCwd);
      }
      i += 2;
      continue;
    }
    if (arg.startsWith("--work-tree=")) {
      effectiveCwd = resolveCandidatePath(arg.slice("--work-tree=".length), effectiveCwd);
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    subcommand = arg;
    subcommandArgs = args.slice(i + 1);
    break;
  }

  if (subcommand === null) return null;
  const matchedRoot = isPathWithinProtectedRoots(
    effectiveCwd ?? process.cwd(),
    null,
    protectedWorkspaceRoots,
  );
  if (matchedRoot === null) return null;

  if (MUTATING_GIT_SUBCOMMANDS.has(subcommand)) {
    return formatProtectedRootWriteDenial(matchedRoot);
  }
  if (
    subcommand === "branch" &&
    subcommandArgs.some((flag) => /^-(?:[dDmMcCf]|-delete|-move|-copy|-force)$/u.test(flag))
  ) {
    return formatProtectedRootWriteDenial(matchedRoot);
  }
  if (
    subcommand === "worktree" &&
    subcommandArgs[0] !== undefined &&
    subcommandArgs[0] !== "list"
  ) {
    return formatProtectedRootWriteDenial(matchedRoot);
  }
  return null;
}

const DIRECT_WRITE_BINS = new Set([
  "rm",
  "rmdir",
  "touch",
  "mkdir",
  "truncate",
  "chmod",
  "chown",
  "tee",
  "cp",
  "mv",
  "ln",
  "install",
]);

function checkSegmentMutation(input: {
  readonly argv: ReadonlyArray<string>;
  readonly redirectTargets: ReadonlyArray<string>;
  readonly currentCwd: string | null;
  readonly protectedWorkspaceRoots: ReadonlyArray<string>;
  readonly unattendedTurn: boolean;
  readonly depth: number;
}): { denial: string | null; nextCwd: string | null } {
  const { redirectTargets, currentCwd, protectedWorkspaceRoots, unattendedTurn, depth } = input;

  if (protectedWorkspaceRoots.length > 0) {
    for (const target of redirectTargets) {
      if (target === "/dev/null" || target.length === 0) continue;
      if (REDIRECT_OPERATORS.has(target)) continue;
      const matched = isPathWithinProtectedRoots(target, currentCwd, protectedWorkspaceRoots);
      if (matched !== null) {
        return { denial: formatProtectedRootWriteDenial(matched), nextCwd: currentCwd };
      }
    }
  }

  const argv = stripLeadingCommandWrappers(input.argv);
  if (argv.length === 0) {
    return { denial: null, nextCwd: currentCwd };
  }

  const bin = NodePath.basename(argv[0]!);
  const rest = argv.slice(1);

  if (bin === "cd" || bin === "pushd") {
    const target = rest.find((arg) => !arg.startsWith("-")) ?? NodeOS.homedir();
    if (target === "-") {
      return { denial: null, nextCwd: currentCwd };
    }
    return {
      denial: null,
      nextCwd: resolveCandidatePath(target, currentCwd),
    };
  }

  if (
    depth < 4 &&
    (bin === "bash" || bin === "sh" || bin === "zsh" || bin === "dash") &&
    rest.length >= 2
  ) {
    const cIndex = rest.findIndex((arg) => arg === "-c" || /^-[A-Za-z]*c$/u.test(arg));
    if (cIndex !== -1 && rest[cIndex + 1] !== undefined) {
      const nestedDenial = checkOrchestrateShellCommandInternal({
        command: rest[cIndex + 1]!,
        cwd: currentCwd,
        protectedWorkspaceRoots,
        unattendedTurn,
        depth: depth + 1,
      });
      if (nestedDenial !== null) {
        return { denial: nestedDenial, nextCwd: currentCwd };
      }
    }
  }

  if (unattendedTurn) {
    const mergeDenial = checkUnattendedMergeCommand(argv);
    if (mergeDenial !== null) {
      return { denial: mergeDenial, nextCwd: currentCwd };
    }
  }

  if (protectedWorkspaceRoots.length === 0) {
    return { denial: null, nextCwd: currentCwd };
  }

  if (bin === "git") {
    const gitDenial = checkGitWorkspaceMutation(rest, currentCwd, protectedWorkspaceRoots);
    return { denial: gitDenial, nextCwd: currentCwd };
  }

  if (bin === "patch") {
    const dirFlagIdx = rest.findIndex((arg) => arg === "-d" || arg === "--directory");
    const patchCwd =
      dirFlagIdx !== -1 && rest[dirFlagIdx + 1] !== undefined
        ? resolveCandidatePath(rest[dirFlagIdx + 1]!, currentCwd)
        : currentCwd;
    const matched = isPathWithinProtectedRoots(
      patchCwd ?? process.cwd(),
      null,
      protectedWorkspaceRoots,
    );
    if (matched !== null) {
      return { denial: formatProtectedRootWriteDenial(matched), nextCwd: currentCwd };
    }
  }

  if (
    (bin === "sed" || bin === "perl" || bin === "ruby") &&
    rest.some((arg) => arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place"))
  ) {
    const fileCandidates = rest.filter((arg) => !arg.startsWith("-"));
    // First non-flag arg is typically the script expression unless -e/-f was passed.
    const hasExplicitExpr = rest.some(
      (arg) => arg === "-e" || arg.startsWith("-e") || arg === "-f" || arg.startsWith("-f"),
    );
    const operands = hasExplicitExpr ? fileCandidates : fileCandidates.slice(1);
    const pathsToCheck = operands.length > 0 ? operands : [currentCwd ?? process.cwd()];
    const denial = checkOrchestrateFilePaths(pathsToCheck, currentCwd, protectedWorkspaceRoots);
    if (denial !== null) {
      return { denial, nextCwd: currentCwd };
    }
  }

  if (DIRECT_WRITE_BINS.has(bin)) {
    const operands = extractPositionalArgs(
      rest,
      new Set(["-t", "--target-directory", "-m", "-o", "-g"]),
    );
    const targetFlagIdx = rest.findIndex((arg) => arg === "-t" || arg === "--target-directory");
    const explicitTargetDir =
      targetFlagIdx !== -1 && rest[targetFlagIdx + 1] !== undefined
        ? [rest[targetFlagIdx + 1]!]
        : [];
    const candidatePaths =
      bin === "cp" || bin === "ln" || bin === "install"
        ? explicitTargetDir.length > 0
          ? explicitTargetDir
          : operands.length > 0
            ? [operands[operands.length - 1]!]
            : []
        : [...explicitTargetDir, ...operands];
    const denial = checkOrchestrateFilePaths(candidatePaths, currentCwd, protectedWorkspaceRoots);
    if (denial !== null) {
      return { denial, nextCwd: currentCwd };
    }
  }

  return { denial: null, nextCwd: currentCwd };
}

function checkOrchestrateShellCommandInternal(input: {
  readonly command: string;
  readonly cwd: string | null;
  readonly protectedWorkspaceRoots: ReadonlyArray<string>;
  readonly unattendedTurn: boolean;
  readonly depth: number;
}): string | null {
  if (input.protectedWorkspaceRoots.length === 0 && !input.unattendedTurn) {
    return null;
  }
  const segments = parseShellSegments(input.command);
  let currentCwd = input.cwd;
  for (const segment of segments) {
    if (input.depth < 4) {
      for (const sub of segment.substitutions) {
        const subDenial = checkOrchestrateShellCommandInternal({
          command: sub,
          cwd: currentCwd,
          protectedWorkspaceRoots: input.protectedWorkspaceRoots,
          unattendedTurn: input.unattendedTurn,
          depth: input.depth + 1,
        });
        if (subDenial !== null) return subDenial;
      }
    }
    const { denial, nextCwd } = checkSegmentMutation({
      argv: segment.argv,
      redirectTargets: segment.redirectTargets,
      currentCwd,
      protectedWorkspaceRoots: input.protectedWorkspaceRoots,
      unattendedTurn: input.unattendedTurn,
      depth: input.depth,
    });
    if (denial !== null) return denial;
    currentCwd = nextCwd;
  }
  return null;
}

export function checkOrchestrateShellCommand(input: {
  readonly command: string;
  readonly cwd: string | null;
  readonly protectedWorkspaceRoots: ReadonlyArray<string>;
  readonly unattendedTurn: boolean;
}): string | null {
  return checkOrchestrateShellCommandInternal({
    ...input,
    depth: 0,
  });
}

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "exec_command",
  "execute_command",
  "run_terminal_cmd",
  "terminal",
]);

const PATCH_TOOL_NAMES = new Set(["apply_patch", "applypatch"]);

const FILE_WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "write_file",
  "edit_file",
  "create_file",
  "replace_in_file",
  "delete_file",
  "str_replace_editor",
  "str_replace_based_edit_tool",
]);

function collectToolFilePaths(toolInput: Record<string, unknown>): ReadonlyArray<string> {
  const paths: Array<string> = [];
  for (const key of ["file_path", "path", "notebook_path", "target_file", "filename"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim().length > 0) {
      paths.push(value);
    }
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (typeof edit === "object" && edit !== null) {
        const editRecord = edit as Record<string, unknown>;
        for (const key of ["file_path", "path"]) {
          const value = editRecord[key];
          if (typeof value === "string" && value.trim().length > 0) {
            paths.push(value);
          }
        }
      }
    }
  }
  return paths;
}

export function checkOrchestrateToolGuard(input: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly cwd: string | null;
  readonly protectedWorkspaceRoots: ReadonlyArray<string>;
  readonly unattendedTurn: boolean;
}): string | null {
  const rawName = input.toolName.trim();
  if (rawName.length === 0 || rawName.startsWith("mcp__") || rawName.startsWith("mcp.")) {
    return null;
  }
  const normalizedName = rawName.toLowerCase();

  if (SHELL_TOOL_NAMES.has(normalizedName)) {
    const commandValue =
      typeof input.toolInput.command === "string"
        ? input.toolInput.command
        : typeof input.toolInput.cmd === "string"
          ? input.toolInput.cmd
          : Array.isArray(input.toolInput.command)
            ? input.toolInput.command
                .filter((part): part is string => typeof part === "string")
                .join(" ")
            : null;
    if (commandValue === null) return null;
    const toolCwd =
      typeof input.toolInput.cwd === "string"
        ? input.toolInput.cwd
        : typeof input.toolInput.workdir === "string"
          ? input.toolInput.workdir
          : input.cwd;
    return checkOrchestrateShellCommand({
      command: commandValue,
      cwd: toolCwd,
      protectedWorkspaceRoots: input.protectedWorkspaceRoots,
      unattendedTurn: input.unattendedTurn,
    });
  }

  if (PATCH_TOOL_NAMES.has(normalizedName)) {
    const patchValue =
      typeof input.toolInput.patch === "string"
        ? input.toolInput.patch
        : typeof input.toolInput.input === "string"
          ? input.toolInput.input
          : typeof input.toolInput.diff === "string"
            ? input.toolInput.diff
            : null;
    if (patchValue === null) return null;
    return checkOrchestrateFilePaths(
      extractApplyPatchPaths(patchValue),
      input.cwd,
      input.protectedWorkspaceRoots,
    );
  }

  if (FILE_WRITE_TOOL_NAMES.has(normalizedName)) {
    if (
      (normalizedName === "str_replace_editor" ||
        normalizedName === "str_replace_based_edit_tool") &&
      input.toolInput.command === "view"
    ) {
      return null;
    }
    return checkOrchestrateFilePaths(
      collectToolFilePaths(input.toolInput),
      input.cwd,
      input.protectedWorkspaceRoots,
    );
  }

  return null;
}
