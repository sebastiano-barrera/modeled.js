import * as Modeled from "./modeled.ts";

import { parseArgs as parseArgsGeneric } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import * as YAML from "@std/yaml";

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
} else {
  const testConfigRaw = await Deno.readTextFile(args.config);
  const testConfig = JSON.parse(testConfigRaw);

  const successes = [];
  const skips = [];
  const failures = [];

  for (const relPath of testConfig.testCases) {
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
        if (oc.outcome === "success") {
          successes.push(oc);
        } else {
          failures.push(oc);
        }
      }
    } catch (e) {
      if (e instanceof SkippedTest) {
        skips.push({ path, message: e.message });
      } else throw e;
    }
  }

  console.log(`${successes.length} successes:`);
  for (const oc of successes) {
    console.log(`%c - ${oc.testcase}`, "color: green");
  }

  console.log(`${skips.length} skipped:`);
  for (const { path, message } of skips) {
    console.log(`%c - ${path}: ${message}`, "color: yellow");
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

function parseArgsChecked(args) {
  args = parseArgsGeneric(args);

  if (typeof args.test262 !== "string") {
    throw new CliError(
      "required argument missing or invalid: --test262 DIR, where DIR is the root of the test262 repo",
    );
  }
  if (args.single !== undefined && typeof (args.single) !== "string") {
    throw new CliError("argument for --single must be string");
  }
  if (args.filter !== undefined && typeof (args.filter) !== "string") {
    throw new CliError("argument for --filter must be string");
  }

  return args;
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
