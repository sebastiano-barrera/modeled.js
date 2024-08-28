import * as Modeled from "./modeled.ts";

import { parseArgs as parseArgsGeneric } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import * as YAML from "@std/yaml";
import { TextLineStream } from "https://deno.land/std@0.224.0/streams/mod.ts";
import { AssertionError } from "https://deno.land/std@0.224.0/assert/assertion_error.ts";

const WORKER_OUTPUT_PREFIX = "worker output:";

class CliError extends Error {}

class SkippedTest {
  constructor(message) {
    this.message = message;
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
    outcome.stack = outcome.error?.stack?.split("\n");

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

async function cmdManager() {
  const WORKER_COUNT = 4;

  const outputRaw = [];

  const children = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    const childArgs = [
      "run",
      "--allow-read",
      import.meta.filename,
      "--worker",
      `${i}/${WORKER_COUNT}`,
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

  if (children.length !== WORKER_COUNT) throw new AssertionError();

  let allOk = true;
  for (let i = 0; i < WORKER_COUNT; i++) {
    console.log(`waiting child ${i}...`);
    const status = await children[i].status;
    console.log(`child ${i} finished with status ${status.code}`);
    allOk = allOk && status.success;
  }

  if (!allOk) Deno.exit(1);

  const output = outputRaw.map(JSON.parse);

  const successes = [];
  const skips = [];
  const failures = [];
  for (const oc of output) {
    if (oc.outcome === "success") successes.push(oc);
    else if (oc.outcome === "skipped") skips.push(oc);
    else failures.push(oc);
  }

  console.log(`${successes.length} successes:`);
  for (const oc of successes) {
    console.log(`%c - ${oc.testcase}`, "color: green");
  }

  console.log(`${skips.length} skipped:`);
  for (const { testcase, error } of skips) {
    console.log(`%c - ${testcase}: ${error.message}`, "color: yellow");
  }

  if (failures.length === 0) {
    console.log("%c     NO FAILURES, IT ALL AL WORKS LFGGGGGG ", "color: cyan");
  } else {
    console.log("");
    console.log(`${failures.length} failures:`);
    for (const oc of failures) {
      console.log(`%ccase\t${oc.testcase}`, "color: red");

      const lines = oc.error.toString().split("\n");
      for (let i = 0; i < lines.length; i++) {
        const tag = i == 0 ? "error" : "ectx";
        console.log(`${tag}\t${lines[i]}`);
      }
    }
  }

  console.log(
    `summary: %c${successes.length} successes; %c${skips.length} skipped; %c${failures.length} failures`,
    "color: green",
    "color: yellow",
    "color: red",
  );
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
      // modeled.VM returns an Error, but we want outcome.error to always be a string
      // this makes the outcome JSON-encodable (to be returned to the manager) without loss
      outcome.error = outcome.error.toString();
    } catch (err) {
      if (err instanceof Modeled.ArbitrarilyLeftUnimplemented) {
        throw new SkippedTest(err.message);
      }
      outcome = {
        outcome: "failure",
        errorCategory: "vm error",
        error: err.toString(),
      };
    }

    if (metadata.negative) {
      if (outcome.outcome === "success") {
        outcome = {
          outcome: "failure",
          errorCategory: "unexpected success",
          expectedError: metadata.negative.type,
          error:
            `expected error ${metadata.negative.type}, but script completed successfully`,
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
