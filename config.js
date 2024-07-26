import fullTestConfig from './fullTestConfig.json' with {type: 'json'};

const predicate = path => path.startsWith('test/language/statements/');

const prob = 0.4

const filteredTestCases = []
console.log(fullTestConfig)
for (const tc of fullTestConfig.testCases) {
  if (predicate(tc) && Math.random() < prob) {
    filteredTestCases.push(tc)
  }
}

const output = { testCases: filteredTestCases }
Deno.writeTextFile('./testConfig.json', JSON.stringify(output))

const nSel = filteredTestCases.length
const nTotal = fullTestConfig.testCases.length
console.log(`selected ${nSel} out of ${nTotal} test cases`)


