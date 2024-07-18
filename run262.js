import * as Modeled from './modeled.js'
import testConfig from './testConfig.json' with {type: 'json'};

import { parseArgs as parseArgsGeneric } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import * as YAML from "@std/yaml";


class CliError extends Error {}


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
  const failures = []

  for (let path of testConfig.testCases) {
    path = path.startsWith('/') ? path : (test262Root + '/' + path);
    const outcomes = await runTest262Case(test262Root, path);

    for (const oc of outcomes) { 
      oc.testcase = path;
      if (oc.outcome === 'success')
        successes.push(oc);
      else
        failures.push(oc);
    }
  }

  console.log(`${successes.length} successes:`)
  for (const oc of successes) {
    console.log(`%c - ${oc.testcase}`, 'color: green')
  }
  
  const LINE_COUNT_LIMIT = 20

  console.log('')
  console.log(`${failures.length} failures:`)
  for (const oc of failures) {
    console.log(`%c --- ${oc.testcase}`, 'color: red')

    const lines = oc.error.toString().split('\n');
    for (const line of lines.slice(0, LINE_COUNT_LIMIT)) {
      console.log('   | ' + line)
    }
    if (lines.length > LINE_COUNT_LIMIT) {
      console.log('   | ...')
    }
  }
}


async function runTest262Case(test262Root, path) {
  console.log(" ... running " + path);
  const text = await Deno.readTextFile(path);
  const metadata = YAML.parse(cutMetadata(text));

  let runStrict = true;
  let runSloppy = true;
  if (metadata.flags) {
    for (const flag of metadata.flags) {
      if (flag === 'onlyStrict') { runSloppy = false; }
      else if (flag === 'noStrict') { runStrict = false; }
      else {
        throw 'unknown flag: ' + flag;
      }
    }
  }

  function runInMode(strict) {
    const vm = new Modeled.VM();
    // no unsupported stuff allowed here
    vm.runScript({ path: '<preamble:sta>',    text: preamble.sta });
    vm.runScript({ path: '<preamble:assert>', text: preamble.assert });

    for (const path of metadata.includes) {
      const text = Deno.readTextFileSync(test262Root + '/harness/' + path);
      vm.runScript({ path: `<preamble:${path}>`, text });
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

  if (args.single !== undefined) {
    if (typeof(args.single) !== 'string') {
      throw new CliError('argument for --single must be relative or absolute path to test case, not ' + typeof(args.single));
    }
    if (!args.single.startsWith('/')) {
      args.single = args.test262 + '/' + args.single;
    }
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

