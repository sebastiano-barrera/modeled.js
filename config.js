import fullTestConfig from './fullTestConfig.json' with {type: 'json'};
import testMeta from './testMeta.json' with {type: 'json'};

const fraction = 1.0
const predicate = path => (
  (
    path.startsWith('test/language/function-code/') 
    || path.startsWith('test/language/block-scope/')
  )
  && (testMeta.testCases[path] || {}).features === undefined 
  && Math.random() < fraction
);

const filteredTestCases = []
for (const tc of fullTestConfig.testCases) {
  if (predicate(tc)) {
    filteredTestCases.push(tc);
  }
}

const output = { testCases: filteredTestCases }
Deno.writeTextFile('./testConfig.json', JSON.stringify(output))

const nSel = filteredTestCases.length
const nTotal = fullTestConfig.testCases.length
console.log(`selected ${nSel} out of ${nTotal} test cases`)


