import testConfig from './testConfig.json' with {type: 'json'};

import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import * as YAML from "@std/yaml";

const args = parseArgs(Deno.args);

if (typeof args.test262 !== 'string') {
  console.error('usage: scan262.js --test262 <path/to/test262>');
  Deno.exit(1);
}

const output = {
  testCases: {},
};

for (const relPath of testConfig.testCases) {
  const path = `${args.test262}/${relPath}`;
  const text = await Deno.readTextFile(path);
  const metadata = YAML.parse(cutMetadata(text)) || {};

  output.testCases[relPath] = metadata;
}

console.log(JSON.stringify(output, null, 4));

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
