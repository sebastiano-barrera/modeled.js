import * as Modeled from "./modeled.ts";

import { parseArgs as parseArgsGeneric } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import * as YAML from "@std/yaml";
import { TextLineStream } from "https://deno.land/std@0.224.0/streams/mod.ts";
import { AssertionError } from "https://deno.land/std@0.224.0/assert/assertion_error.ts";

const WORKER_OUTPUT_PREFIX = "worker output:";
const DATA_DIR = `${import.meta.dirname}/.run262`;
const STATE_FILENAME = `${DATA_DIR}/state`;

class CliError extends Error {}

class SkippedTest {
  constructor(message) {
    this.message = message;
  }
}

function assertValidCommitID(commitID) {
  if (!/^[a-f0-9]+$/.test(commitID)) {
    throw new Error(`invalid output for git command: git rev-parse ${commitID}: ${stdout}`);
  }
}

async function resolveGitRevision(rev) {
  const command = new Deno.Command("git", {
    args: ["rev-parse", rev],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();

  if (code !== 0) return null;

  const anchorCommitID = new TextDecoder().decode(stdout).trim();
  assertValidCommitID(anchorCommitID);
  return anchorCommitID;
}
async function getAnchorCommitID() { return await resolveGitRevision('run262-anchor') }
async function getCurrentCommitID() {
  // is repo clean?
  const command = new Deno.Command("git", {
    args: ["status", "--porcelain"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    throw new Error('git error: ' + new TextDecoder().decode(stderr));
  }

  if (stdout.length !== 0) {
    // repo not clean, no clear-cut commit ID can be assigned to the current situation
    return null;
  }

  return await resolveGitRevision('HEAD');
}

let state = null;

async function loadState() {
  try {
    state = await Deno.readTextFile();
  } catch(err) {
    if (err instanceof Deno.errors.NotFound) {
      return null;
    }
    throw err;
  }
}
async function saveState() {
  Deno.writeTextFile(STATE_FILENAME, JSON.stringify(state, null, 2));
}
async function saveOutput(commitID, outcomes) {
  assertValidCommitID(commitID);
  const content = JSON.stringify({outcomes});
  const filename = `${DATA_DIR}/output-${commitID}.json`;
  await Deno.writeTextFile(filename, content);
  console.log(`saved status to file ${filename}`);
}
async function loadOutput(commitID) {
  assertValidCommitID(commitID);
  const filename = `${DATA_DIR}/output-${commitID}.json`;
  try {
    const content = await Deno.readTextFile(filename);
    const object = JSON.parse(content);
    return object.outcomes;
  } catch(err) {
    if (err instanceof Deno.errors.NotFound) {
      return null;
    }
    throw err;
  }
}

const args = parseArgsGeneric(Deno.args);

function checkFlagRequired(flag, description) {
  if (typeof args[flag] !== "string") {
    throw new CliError(
      `required argument missing or invalid: --${flag} (${description})`,
    );
  }
}
function checkFlagString(flag, description) {
  if (args[flag] !== undefined && typeof (args[flag]) !== "string") {
    throw new CliError(
      `argument for --${flag} must be string (${description})`,
    );
  }
}

// deno-fmt-ignore
{
  checkFlagRequired("test262", "path to the test262 repo");
  checkFlagString("filter", "substring of the path that enables a test");
  checkFlagString('worker', '(internal) worker configuration index/count');
  if ('single' in args)
    checkFlagString("single", "path to the single test case (relative or absolute)");
  else
    checkFlagRequired("config",  "path to the test config JSON (e.g. test/focused.json)");
}

const test262Root = args.test262;
const preamble = {
  sta: await Deno.readTextFile(`${test262Root}/harness/sta.js`),
  assert: await Deno.readTextFile(`${test262Root}/harness/assert.js`),
};

if (args.single) {
  await cmdSingle();
} else if (args.worker) {
  const toks = args.worker.split("/");
  if (toks.length !== 2) {
    throw new CliError("invalid worker spec: " + args.worker);
  }

  const workerIndex = Number(toks[0]);
  const workerCount = Number(toks[1]);
  await cmdWorker(workerIndex, workerCount);
} else {
  cmdManager();
}

async function cmdSingle() {
  console.log(" --- single test case " + args.single);
  const outcomes = await runTest262Case(test262Root, args.single);
  for (const outcome of outcomes) {
    console.log(`outcome\t${outcome.mode}\t${outcome.outcome}`);

    if (outcome.outcome === "success") continue;
    outcome.ctor = outcome.error?.constructor.name;
    outcome.ectx = outcome.error?.context?.map((item) => {
      const l = item.loc;
      return `${l.source}:${l.start.line}-${l.end.line}:${l.start.column}-${l.end.column} ${item.type}`;
    }) ?? [];

    
    let causeIndex = 0;
    if (outcome.error) {
      outcome.stack = [];
      for (let error = outcome.error; error; error = error.cause) {
        outcome.stack.push(`cause ${causeIndex}`);
        outcome.stack.push(...  error.stack.split("\n"));
        causeIndex++;
      }
    }

    for (const key of Object.keys(outcome).sort()) {
      if (key === "outcome") continue;
      const value = outcome[key];
      const lines = Array.isArray(value) ? value : [value];
      for (const line of lines) {
        console.log(`\t${key}\t${line}`);
      }
    }
  }
}

async function fanout(workerCount) {
  const outputRaw = [];

  const children = [];
  for (let i = 0; i < workerCount; i++) {
    const childArgs = [
      "run",
      "--allow-read",
      import.meta.filename,
      "--worker",
      `${i}/${workerCount}`,
    ].concat(Deno.args);

    const cmd = new Deno.Command(Deno.execPath(), {
      args: childArgs,
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    children.push(child);

    const out = child.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    const stderrLines = child.stderr
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    const tag = String(i).padEnd(4);

    (async function () {
      for await (const line of stderrLines) {
        console.log(`worker ${tag} ! ${line}`);
      }
    })();

    (async function () {
      for await (const line of out) {
        if (line.startsWith(WORKER_OUTPUT_PREFIX)) {
          const jsonEncoded = line.slice(WORKER_OUTPUT_PREFIX.length);
          outputRaw.push(jsonEncoded);
        } else {
          console.log(`worker ${tag} | ${line}`);
        }
      }
    })();
  }

  if (children.length !== workerCount) throw new AssertionError();

  let allOk = true;
  for (let i = 0; i < workerCount; i++) {
    console.log(`waiting child ${i}...`);
    const status = await children[i].status;
    console.log(`child ${i} finished with status ${status.code}`);
    allOk = allOk && status.success;
  }

  if (!allOk) {
    throw new Error('some workers did not complete successfully');
  }

  return outputRaw.map(JSON.parse);
}

async function cmdManager() {
  const WORKER_COUNT = 4;

  const currentCommitID = await getCurrentCommitID();

  let output = null;
  if (currentCommitID && !args.noCache) {
    output = await loadOutput(currentCommitID);
  }
  if (output === null) {
    output = await fanout(WORKER_COUNT);
  }

  const anchorCommitID = await getAnchorCommitID();
  const anchorOutput = await loadOutput(anchorCommitID);
  let anchorOutcomeOfTestcase = {};
  if (anchorOutput) {
    for (const oc of anchorOutput) {
      anchorOutcomeOfTestcase[oc.testcase] = oc;
    }
  }

  const successes = [];
  const skips = [];
  const failures = [];
  const delta = {
    successes: 0,
    skips: 0,
    failures: 0,
  };

  for (const oc of output) {
    if (oc.outcome === "success") successes.push(oc);
    else if (oc.outcome === "skipped") skips.push(oc);
    else failures.push(oc);
  }

  function styleOfOutcome(previous, current) {
    if (previous === current) {
      switch(previous) {
      case "success": return 'color: green';
      case "skipped": return 'color: yellow';
      case "failure": return 'color: red';
      default: return "";
      }
    } else {
      switch(previous) {
      case "success": return 'background-color: green; color: white; font-weight: bold';
      case "skipped": return 'background-color: yellow; color: black; font-weight: bold';
      case "failure": return 'background-color: red; color: white; font-weight: bold';
      default: return "";
      }
    }
  }

  console.log(`${successes.length} successes:`);
  for (const oc of successes) {
    const anchor = anchorOutcomeOfTestcase[oc.testcase];
    const anchorOutcome = ((anchor?.outcome ?? ' ?') + ' ->').padEnd(10);
    const anchorStyle = styleOfOutcome(anchor?.outcome, 'success');
    console.log(
      ` - %c[${anchorOutcome}] %c${oc.testcase}`, 
      `${anchorStyle}`,
      "color: green"
    );

    if (anchor?.outcome !== 'success') delta.successes += 1;
  }

  console.log(`${skips.length} skipped:`);
  for (const { testcase, error } of skips) {
    const anchor = anchorOutcomeOfTestcase[testcase];
    const anchorOutcome = ((anchor?.outcome ?? ' ?') + ' ->').padEnd(10);
    const anchorStyle = styleOfOutcome(anchor?.outcome, 'skipped');
    console.log(
      ` - %c[${anchorOutcome}] %c${testcase}: ${error.message}`,
      `${anchorStyle}`,
      "color: yellow"
    );

    if (anchor?.outcome !== 'skipped') delta.skips += 1;
  }

  if (failures.length === 0) {
    console.log("%c     NO FAILURES, IT ALL AL WORKS LFGGGGGG ", "color: cyan");
  } else {
    console.log("");
    console.log(`${failures.length} failures:`);
    for (const oc of failures) {
      console.log(`%ccase\t${oc.testcase}`, "color: red");

      const anchor = anchorOutcomeOfTestcase[oc.testcase];
      const anchorOutcome = anchor?.outcome ?? ' ?';
      const anchorStyle = styleOfOutcome(anchor?.outcome, 'failure');
      console.log(`was\t%c${anchorOutcome}`, `${anchorStyle}`);

      const lines = oc.error.toString().split("\n");
      for (let i = 0; i < lines.length; i++) {
        const tag = i == 0 ? "error" : "ectx";
        console.log(`${tag}\t${lines[i]}`);
      }

      if (anchor?.outcome !== 'failure') delta.failures += 1;
    }
  }

  console.log(
    `summary: %c${successes.length} successes; %c${skips.length} skipped; %c${failures.length} failures`,
    "color: green",
    "color: yellow",
    "color: red",
  );
  console.log(
    `  delta: %c${delta.successes} fixed; %c${delta.skips} now skipped; %c${delta.failures} failures`,
    "color: green",
    "color: yellow",
    "color: red",
  );

  Deno.mkdir(DATA_DIR, { recursive: true });
  if (currentCommitID) {
    saveOutput(currentCommitID, output);
  } else {
    console.log('repo dirty, not saving');``
  }
}

async function cmdWorker(workerIndex, workerCount) {
  console.log(`worker ${workerIndex} of ${workerCount}`);
  const testConfigRaw = await Deno.readTextFile(args.config);
  const testConfig = JSON.parse(testConfigRaw);

  function emit(obj) {
    console.log(WORKER_OUTPUT_PREFIX, JSON.stringify(obj));
  }

  for (let i = 0; i < testConfig.testCases.length; i++) {
    if (i % workerCount !== workerIndex) {
      continue;
    }

    const relPath = testConfig.testCases[i];
    const path = relPath.startsWith("/")
      ? relPath
      : (test262Root + "/" + relPath);

    try {
      if (args.filter && !path.includes(args.filter)) {
        throw new SkippedTest("skipped via --filter option");
      }

      const outcomes = await runTest262Case(test262Root, path);

      for (const oc of outcomes) {
        // runTest262Case returns an Error, but we want outcome.error to always be a string
        // this makes the outcome JSON-encodable (to be returned to the manager) without loss
        oc.error = oc.error?.toString();
        oc.testcase = path;
        emit(oc);
      }
    } catch (e) {
      if (e instanceof SkippedTest) {
        emit({
          outcome: "skipped",
          testcase: path,
          error: e.message,
        });
      } else throw e;
    }
  }
}

async function runTest262Case(test262Root, path) {
  console.log(" ... running " + path);
  const text = await Deno.readTextFile(path);
  const metadata = YAML.parse(cutMetadata(text)) || {};

  let runStrict = true;
  let runSloppy = true;
  if (metadata.flags) {
    for (const flag of metadata.flags) {
      // deno-fmt-ignore
      switch (flag) {
      case 'onlyStrict': runSloppy = false; break;
      case 'noStrict': runStrict = false; break;
      // ignore these:
      case 'generated': break;
      default: throw new SkippedTest('unknown flag: ' + flag);
      }
    }
  }

  function runInMode(strict) {
    const vm = new Modeled.VM();
    // no unsupported stuff allowed here
    vm.runScript({ path: "<preamble:sta>", text: preamble.sta });
    vm.runScript({ path: "<preamble:assert>", text: preamble.assert });

    if (metadata.includes) {
      for (const path of metadata.includes) {
        const text = Deno.readTextFileSync(test262Root + "/harness/" + path);
        vm.runScript({ path: `<preamble:${path}>`, text });
      }
    }

    const effectiveText = strict ? ('"use strict";' + text) : text;

    let outcome;
    try {
      outcome = vm.runScript({ path, text: effectiveText });
    } catch (err) {
      if (err instanceof Modeled.ArbitrarilyLeftUnimplemented) {
        throw new SkippedTest(err.message);
      }
      outcome = {
        outcome: "failure",
        errorCategory: "vm error",
        error: err,
      };
    }

    if (metadata.negative) {
      if (outcome.outcome === "success") {
        outcome = {
          outcome: "failure",
          errorCategory: "unexpected success",
          expectedError: metadata.negative.type,
          error: new Error(
            `expected error ${metadata.negative.type}, but script completed successfully`,
          ),
        };
      } else if (outcome.programExceptionName !== metadata.negative.type) {
        outcome.errorCategory = "wrong exception type";
        outcome.expectedError = metadata.negative.type;
      } else {
        outcome.outcome = "success";
      }
    }

    outcome.mode = strict ? "strict" : "sloppy";
    return outcome;
  }

  const outcomes = [];
  if (runStrict) outcomes.push(runInMode(true));
  if (runSloppy) outcomes.push(runInMode(false));

  return outcomes;
}

function cutMetadata(text) {
  let inMetaComment = false;
  const metadataYamlLines = [];

  for (const line of text.split("\n")) {
    const lineTrimmed = line.trim();

    if (lineTrimmed == "---*/") inMetaComment = false;
    if (inMetaComment) metadataYamlLines.push(line);
    if (lineTrimmed == "/*---") inMetaComment = true;
  }

  return metadataYamlLines.join("\n");
}
