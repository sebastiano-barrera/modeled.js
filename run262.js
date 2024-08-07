import * as Modeled from './modeled.ts'
import testConfig from './testConfig.json' with {type: 'json'};

import { parseArgs as parseArgsGeneric } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import * as YAML from "@std/yaml";


class CliError extends Error {}

class SkippedTest {
  constructor(message) { this.message = message }
}


let args;
try {
  args = parseArgsChecked(Deno.args);
} catch (err) {
  console.error('while parsing command-line: ' + err)
  Deno.exit(1);
}

const test262Root = args.test262;
const preamble = {
  sta: await Deno.readTextFile(`${test262Root}/harness/sta.js`),
  assert: await Deno.readTextFile(`${test262Root}/harness/assert.js`),
};

if (args.single) {
  console.log(" --- single test case " + args.single);
  const outcome = await runTest262Case(test262Root, args.single);
  console.log(outcome);

  } else {
  const successes = []
  const skips = []
  const failures = []

  for (let relPath of testConfig.testCases) {
    const path = relPath.startsWith('/') ? relPath : (test262Root + '/' + relPath);
    try {
      if (args.filter && !path.includes(args.filter))  {
        throw new SkippedTest("skipped via --filter option");
      }
  
      const outcomes = await runTest262Case(test262Root, path);

      for (const oc of outcomes) { 
        oc.testcase = path;
        if (oc.outcome === 'success')
          successes.push(oc);
        else
          failures.push(oc);
      }
    } catch (e) {
      if (e instanceof SkippedTest) {
        skips.push({ path, message: e.message });
      } else throw e;
    }
  }

  console.log(`${successes.length} successes:`)
  for (const oc of successes) {
    console.log(`%c - ${oc.testcase}`, 'color: green')
  }

  console.log(`${skips.length} skipped:`)
  for (const {path, message} of skips) {
    console.log(`%c - ${path}: ${message}`, 'color: yellow')
  }

  if (failures.length === 0) {
    console.log('%c     NO FAILURES, IT ALL AL WORKS LFGGGGGG ', 'color: cyan')
  
  } else {
    console.log('')
    console.log(`${failures.length} failures:`)
    for (const oc of failures) {
      console.log(`%ccase\t${oc.testcase}`, 'color: red')

      const lines = oc.error.toString().split('\n');
      for (let i=0; i < lines.length; i++) {
        const tag = i == 0 ? "error" : "ectx";
        console.log(`${tag}\t${lines[i]}`);
      }
    }
  }

  console.log(
    `summary: %c${successes.length} successes; %c${skips.length} skipped; %c${failures.length} failures`,
    'color: green', 'color: yellow', 'color: red'
  )
}



async function runTest262Case(test262Root, path) {
  console.log(" ... running " + path);
  const text = await Deno.readTextFile(path);
  const metadata = YAML.parse(cutMetadata(text)) || {};

  let runStrict = true;
  let runSloppy = true;
  if (metadata.flags) {
    for (const flag of metadata.flags) {
      if (flag === 'onlyStrict') { runSloppy = false; }
      else if (flag === 'noStrict') { runStrict = false; }
      else { throw new SkippedTest('unknown flag: ' + flag); }
    }
  }

  function runInMode(strict) {
    const vm = new Modeled.VM();
    // no unsupported stuff allowed here
    vm.runScript({ path: '<preamble:sta>',    text: preamble.sta });
    vm.runScript({ path: '<preamble:assert>', text: preamble.assert });

    if (metadata.includes) {
      for (const path of metadata.includes) {
        const text = Deno.readTextFileSync(test262Root + '/harness/' + path);
        vm.runScript({ path: `<preamble:${path}>`, text });
      }
    }
    
    const effectiveText = strict ? ('"use strict";' + text) : text;

    let outcome;
    try {
      outcome = vm.runScript({ path, text: effectiveText });
    } catch (err) {
      if (metadata.negative && err.name === metadata.negative.type) {
        outcome = {
          outcome: 'success',
          expectedError: metadata.negative.type,
          error: err,
        }
      } else {
        outcome = {
          outcome: 'failure',
          errorCategory: 'vm error',
          error: err,
        }
      }
    }
     
    return outcome;
  }

  const outcomes = []
  if (runStrict) { outcomes.push(runInMode(true)); } 
  if (runSloppy) { outcomes.push(runInMode(false)); } 

  return outcomes
}


function parseArgsChecked(args) {
  args = parseArgsGeneric(args);

  if (typeof args.test262 !== 'string') {
    throw new CliError('required argument missing or invalid: --test262 DIR, where DIR is the root of the test262 repo');
  } 
  if (args.single !== undefined && typeof(args.single) !== 'string') {
    throw new CliError('argument for --single must be string');
  }
  if (args.filter !== undefined && typeof(args.filter) !== 'string') {
    throw new CliError('argument for --filter must be string');
  } 

  return args;
}

function cutMetadata(text) {
    let inMetaComment = false;
    const metadataYamlLines = [];
    
    for (const line of text.split('\n')) {
        const lineTrimmed = line.trim();
    
        if (lineTrimmed == '---*/') inMetaComment = false;
        if (inMetaComment) metadataYamlLines.push(line);
        if (lineTrimmed == '/*---') inMetaComment = true;
    }
    
    return metadataYamlLines.join('\n');
}
